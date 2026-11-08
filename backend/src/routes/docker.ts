import { z } from 'zod';
import { writeAudit } from '../db/audit.repo.js';
import type { Db } from '../db/connection.js';
import { authenticateUpgrade, requireAuth, type UpgradeDeps } from '../middleware/auth.js';
import type { AppInstance } from '../server.js';
import {
  LOG_TAIL_DEFAULT,
  LOG_TAIL_MAX,
  type ContainerSummary,
  type DockerService,
} from '../services/docker.js';
import type { DockerStatsPoller } from '../services/dockerStats.js';
import type { SocketRegistry } from '../services/socketRegistry.js';
import { AppError } from '../utils/errors.js';
import type { SessionRateLimiter } from '../utils/rateLimit.js';

/**
 * Docker routes.
 *
 * Everything here is behind the global auth guard (session + CSRF + Origin)
 * and every state change is audited. There is deliberately no exec endpoint and
 * no create-container endpoint: the dashboard can start, stop and remove the
 * things it already knows about, nothing more.
 */

/**
 * Container ids are 64 hex characters; names are [a-zA-Z0-9][a-zA-Z0-9_.-]*.
 * One pattern covers both, and it is strict enough that nothing in it can be
 * mistaken for a CLI flag or a path. No shell is involved anywhere below —
 * dockerode speaks HTTP to the socket proxy.
 */
export const ContainerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'container id or name contains invalid characters');

const ParamsSchema = z.object({ id: ContainerIdSchema });

const LogsQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(LOG_TAIL_MAX).default(LOG_TAIL_DEFAULT),
});

const WS_OPEN = 1;
const WS_POLICY_VIOLATION = 1008;
/** Beyond this much queued data a slow log reader starts losing frames. */
const MAX_BUFFERED_BYTES = 1_000_000;
/** A single log line is truncated to this before it reaches the browser. */
const MAX_LINE_LENGTH = 2000;

export interface DockerRoutesDeps extends UpgradeDeps {
  docker: DockerService;
  statsPoller: DockerStatsPoller;
  statsIntervalMs: number;
  registry: SocketRegistry;
  db: Db;
  actions: SessionRateLimiter;
}

interface WsSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
}

export function registerDockerRoutes(app: AppInstance, deps: DockerRoutesDeps): void {
  // ---------------------------------------------------------------- status
  app.get('/api/docker/status', async (request) => {
    requireAuth(request);
    return deps.docker.status();
  });

  // ------------------------------------------------------------ containers
  app.get('/api/docker/containers', async (request) => {
    requireAuth(request);

    const containers = await deps.docker.list();
    const running = containers.filter((container) => container.state === 'running').map((c) => c.id);
    const stats = await deps.docker.statsFor(running);

    return {
      available: true,
      containers: containers.map((container) => ({
        ...container,
        stats: stats.get(container.id) ?? null,
      })),
      refreshAt: Date.now(),
    };
  });

  app.get('/api/docker/containers/:id', async (request) => {
    requireAuth(request);
    const { id } = ParamsSchema.parse(request.params);
    const inspect = await deps.docker.inspect(id);
    return inspect;
  });

  // ---------------------------------------------------------------- control
  const actionRoute = (action: 'start' | 'stop' | 'restart'): void => {
    app.post(`/api/docker/containers/:id/${action}`, async (request) => {
      const session = requireAuth(request);
      const { id } = ParamsSchema.parse(request.params);

      consumeAction(deps, session.sessionId, request.ip, `${action} ${id}`);

      const summary = await deps.docker.resolve(id);
      await auditDenial(deps, session.username, request.ip, action, summary);
      await deps.docker.action(id, action);

      writeAudit(deps.db, {
        action: `docker.container.${action}`,
        actor: session.username,
        target: `${summary.name} (${summary.shortId})`,
        detail: `image ${summary.image}`,
        ip: request.ip,
        now: Date.now(),
      });

      const refreshed = await deps.docker.resolve(id);
      return { ok: true, container: refreshed };
    });
  };

  actionRoute('start');
  actionRoute('stop');
  actionRoute('restart');

  app.delete('/api/docker/containers/:id', async (request) => {
    const session = requireAuth(request);
    const { id } = ParamsSchema.parse(request.params);

    consumeAction(deps, session.sessionId, request.ip, `remove ${id}`);

    const summary = await deps.docker.resolve(id);
    await auditDenial(deps, session.username, request.ip, 'remove', summary);
    await deps.docker.remove(id);

    writeAudit(deps.db, {
      action: 'docker.container.remove',
      actor: session.username,
      target: `${summary.name} (${summary.shortId})`,
      detail: `image ${summary.image}`,
      ip: request.ip,
      now: Date.now(),
    });

    return { ok: true, removed: { id: summary.id, name: summary.name } };
  });

  // ------------------------------------------------------------- log stream
  app.get('/ws/docker/logs/:id', { websocket: true }, (socket, request) => {
    const rawSocket = socket as unknown as WsSocket;
    const upgrade = authenticateUpgrade(request, deps);

    if (!upgrade.ok) {
      rawSocket.close(WS_POLICY_VIOLATION, upgrade.reason === 'origin' ? 'origin not allowed' : 'authentication required');
      return;
    }

    const params = ParamsSchema.safeParse(request.params);
    const query = LogsQuerySchema.safeParse(request.query);

    if (!params.success || !query.success) {
      rawSocket.close(WS_POLICY_VIOLATION, 'invalid container id or tail');
      return;
    }

    const { id } = params.data;
    const { tail } = query.data;
    const session = upgrade.session;

    deps.registry.add(session.sessionId, rawSocket);

    let stopStream: (() => void) | null = null;
    let dropped = 0;
    let closed = false;

    const send = (frame: unknown): void => {
      if (rawSocket.readyState !== WS_OPEN) return;
      rawSocket.send(JSON.stringify(frame));
    };

    void deps.docker
      .resolve(id)
      .then((summary) => {
        writeAudit(deps.db, {
          action: 'docker.logs.open',
          actor: session.username,
          target: `${summary.name} (${summary.shortId})`,
          detail: `tail ${tail}`,
          ip: request.ip,
          now: Date.now(),
        });
        return summary;
      })
      .then((summary) => {
        send({ type: 'open', payload: { id: summary.id, name: summary.name, tail } });

        return deps.docker.followLogs(id, {
          tail,
          onLine: (line) => {
            // Backpressure: if this client is behind, drop the frame instead of
            // buffering it forever. It gets told, once, how many it lost.
            if (rawSocket.bufferedAmount > MAX_BUFFERED_BYTES) {
              dropped += 1;
              return;
            }

            if (dropped > 0) {
              send({ type: 'dropped', payload: { count: dropped } });
              dropped = 0;
            }

            send({
              type: 'line',
              payload: { line: line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line },
            });
          },
          onEnd: (reason) => {
            if (closed) return;
            send({ type: 'end', payload: { reason } });
          },
        });
      })
      .then((stop) => {
        stopStream = stop;
        // The socket may already be gone by the time docker answered.
        if (closed) stop();
      })
      .catch((error: unknown) => {
        const message = error instanceof AppError ? error.message : 'Could not open the log stream';
        send({ type: 'error', payload: { message } });
        rawSocket.close(WS_POLICY_VIOLATION, 'log stream failed');
      });

    const cleanup = (): void => {
      closed = true;
      deps.registry.remove(session.sessionId, rawSocket);
      stopStream?.();
      stopStream = null;
    };

    rawSocket.on('close', cleanup);
    rawSocket.on('error', cleanup);
  });

  // ------------------------------------------------------------ stats stream
  app.get('/ws/docker/stats', { websocket: true }, (socket, request) => {
    const rawSocket = socket as unknown as WsSocket;
    const upgrade = authenticateUpgrade(request, deps);

    if (!upgrade.ok) {
      rawSocket.close(WS_POLICY_VIOLATION, upgrade.reason === 'origin' ? 'origin not allowed' : 'authentication required');
      return;
    }

    const session = upgrade.session;
    deps.registry.add(session.sessionId, rawSocket);

    send(rawSocket, {
      type: 'hello',
      payload: { intervalMs: deps.statsIntervalMs },
    });

    const unsubscribe = deps.statsPoller.subscribe((payload) => {
      if (rawSocket.readyState !== WS_OPEN) return;
      // Stats are a snapshot, not a log: skipping one frame is harmless.
      if (rawSocket.bufferedAmount > MAX_BUFFERED_BYTES) return;

      rawSocket.send(JSON.stringify({ type: 'stats', payload }));
    });

    const cleanup = (): void => {
      unsubscribe();
      deps.registry.remove(session.sessionId, rawSocket);
    };

    rawSocket.on('close', cleanup);
    rawSocket.on('error', cleanup);
  });
}

// ---------------------------------------------------------------- helpers

function send(socket: WsSocket, frame: unknown): void {
  if (socket.readyState !== WS_OPEN) return;
  socket.send(JSON.stringify(frame));
}

/** Counts the action and refuses past the per-session budget. */
function consumeAction(
  deps: DockerRoutesDeps,
  sessionId: string,
  ip: string | undefined,
  action: string,
): void {
  const result = deps.actions.consume(sessionId);
  if (result.allowed) return;

  writeAudit(deps.db, {
    action: 'docker.action.rate_limited',
    actor: 'session',
    target: action,
    detail: 'per-session action budget exhausted',
    ip: ip ?? null,
    success: false,
    now: Date.now(),
  });

  throw new AppError(429, 'rate_limited', 'Too many Docker actions. Wait a moment.', {
    'retry-after': String(result.retryAfterSeconds),
  });
}

/**
 * Records a refusal on a protected container BEFORE the service throws, so the
 * audit log keeps the attempt with its container name.
 */
async function auditDenial(
  deps: DockerRoutesDeps,
  actor: string,
  ip: string | undefined,
  action: string,
  summary: ContainerSummary,
): Promise<void> {
  if (!summary.protected) return;

  writeAudit(deps.db, {
    action: 'docker.container.denied',
    actor,
    target: `${summary.name} (${summary.shortId})`,
    detail: `${action} refused: ${summary.protectedReason ?? 'protected container'}`,
    ip: ip ?? null,
    success: false,
    now: Date.now(),
  });
}
