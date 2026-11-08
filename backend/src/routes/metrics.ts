import type {} from '@fastify/cookie';
import type { AppInstance } from '../server.js';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/connection.js';
import { queryHistory, type MetricsSnapshot } from '../db/metrics.repo.js';
import type { Logger } from '../logger.js';
import type { AuthService } from '../services/auth.js';
import type { MetricsSampler } from '../services/metrics.js';
import type { SocketRegistry } from '../services/socketRegistry.js';
import { isOriginAllowed } from '../utils/origin.js';

/** Only these windows are offered in the UI, so only these are accepted. */
const RANGE_MS = {
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
} as const;

type Range = keyof typeof RANGE_MS;

/** Fixed allowlist: arbitrary buckets would let a caller ask for 43k points. */
const BUCKET_ALLOWLIST_SECONDS = [30, 60, 300, 900, 1800, 3600] as const;
type BucketSeconds = (typeof BUCKET_ALLOWLIST_SECONDS)[number];

/** Default bucket per range keeps the chart at a sane width. */
const DEFAULT_BUCKET: Record<Range, BucketSeconds> = {
  '1h': 60,
  '6h': 300,
  '24h': 900,
};

/** Absolute ceiling on returned rows, whatever the query says. */
const MAX_ROWS = 720;

export const HistoryQuerySchema = z.object({
  range: z.enum(['1h', '6h', '24h']).default('1h'),
  bucket: z
    .union([z.string(), z.number()])
    .transform((raw) => Number(raw))
    .refine(
      (value): value is BucketSeconds => BUCKET_ALLOWLIST_SECONDS.includes(value as BucketSeconds),
      { message: `bucket must be one of ${BUCKET_ALLOWLIST_SECONDS.join(', ')}` },
    )
    .optional(),
});

export interface MetricsRoutesDeps {
  db: Db;
  sampler: MetricsSampler;
  config: AppConfig;
  logger: Logger;
  auth: AuthService;
  registry: SocketRegistry;
}

/** Minimal structural view of the ws socket, so this module needs no ws types. */
interface MetricsSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  close(code?: number, reason?: string): void;
}

const WS_OPEN = 1;
/** If a client is this far behind, drop a frame instead of growing memory. */
const MAX_BUFFERED_BYTES = 1_000_000;
/** 1008 = policy violation: close, and do not reconnect with the same creds. */
const WS_POLICY_VIOLATION = 1008;

/**
 * Fans one sampler result out to every connected socket.
 * Kept separate from the route so the fan-out logic is unit testable.
 */
export function createMetricsHub() {
  const clients = new Set<MetricsSocket>();

  return {
    add(socket: MetricsSocket): void {
      clients.add(socket);
      socket.on('close', () => clients.delete(socket));
      socket.on('error', () => clients.delete(socket));
    },
    broadcast(snapshot: MetricsSnapshot): number {
      const frame = JSON.stringify({ type: 'snapshot', payload: snapshot } satisfies WsFrame);
      let delivered = 0;

      for (const socket of clients) {
        if (socket.readyState !== WS_OPEN) {
          clients.delete(socket);
          continue;
        }
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) continue; // slow consumer
        socket.send(frame);
        delivered += 1;
      }
      return delivered;
    },
    size(): number {
      return clients.size;
    },
    clear(): void {
      clients.clear();
    },
  };
}

export type MetricsHub = ReturnType<typeof createMetricsHub>;

interface WsFrame {
  type: 'hello' | 'snapshot' | 'error';
  payload: unknown;
}

export function registerMetricsRoutes(app: AppInstance, deps: MetricsRoutesDeps, hub: MetricsHub): void {
  // ---- GET /api/metrics/history ------------------------------------------
  app.get('/api/metrics/history', async (request) => {
    const parsed = HistoryQuerySchema.parse(request.query);
    const range = parsed.range;
    const bucketSeconds = parsed.bucket ?? DEFAULT_BUCKET[range];

    const now = Date.now();
    const fromTs = now - RANGE_MS[range];
    const wantedRows = Math.ceil(RANGE_MS[range] / (bucketSeconds * 1000));
    const limit = Math.min(wantedRows, MAX_ROWS);

    const points = queryHistory(deps.db, { fromTs, bucketSeconds, limit });

    return {
      range,
      bucketSeconds,
      from: new Date(fromTs).toISOString(),
      to: new Date(now).toISOString(),
      truncated: wantedRows > limit,
      points,
    };
  });

  // ---- WS /ws/metrics -----------------------------------------------------
  app.get('/ws/metrics', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;

    if (!isOriginAllowed(origin, deps.config.allowedOrigins)) {
      // Log the attempt: an unexpected origin is either a misconfiguration or
      // someone trying to read this machine's metrics from another page.
      deps.logger.warn({ origin: origin ?? null }, 'rejected websocket: origin not allowed');
      socket.close(WS_POLICY_VIOLATION, 'origin not allowed');
      return;
    }

    // The Origin check proves which page opened the socket, not who is behind
    // it. The session cookie is httpOnly, so a script cannot fabricate one —
    // but it can still be attached automatically by the browser, which is
    // exactly why both checks are required.
    const session = deps.auth.authenticate(request.cookies[deps.config.session.cookieName]);

    if (!session || session.kind !== 'full') {
      deps.logger.warn({ origin: origin ?? null }, 'rejected websocket: unauthenticated');
      socket.close(WS_POLICY_VIOLATION, 'authentication required');
      return;
    }

    hub.add(socket as unknown as MetricsSocket);

    // Tracked per session so logout/expiry can close this socket immediately.
    deps.registry.add(session.sessionId, socket);
    socket.on('close', () => deps.registry.remove(session.sessionId, socket));

    const send = (frame: WsFrame): void => {
      if (socket.readyState !== WS_OPEN) return;
      socket.send(JSON.stringify(frame));
    };

    send({
      type: 'hello',
      payload: {
        serverTime: new Date().toISOString(),
        intervalMs: deps.config.metricsIntervalMs,
        retentionHours: deps.config.metricsRetentionHours,
      },
    });

    // Immediate snapshot so the UI is never empty for 2 seconds.
    const last = deps.sampler.getLast();
    if (last) send({ type: 'snapshot', payload: last });

    // Clients are consumers only; a message from them is a protocol error.
    socket.on('message', () => {
      send({ type: 'error', payload: { message: 'this channel is read-only' } });
    });
  });
}
