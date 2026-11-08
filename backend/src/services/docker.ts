import Docker from 'dockerode';
import type { ContainerInfo, ContainerStats } from 'dockerode';
import { PassThrough } from 'node:stream';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { AppError } from '../utils/errors.js';

/**
 * Everything that touches Docker lives here.
 *
 * The client is always pointed at the socket proxy (http://127.0.0.1:2375),
 * never at /var/run/docker.sock: if the dashboard is compromised, the blast
 * radius is "the handful of endpoints the proxy allows", not root on the host.
 */

export type ContainerState =
  | 'running'
  | 'exited'
  | 'created'
  | 'restarting'
  | 'paused'
  | 'removing'
  | 'dead'
  | 'unknown';

export interface PortMapping {
  privatePort: number;
  publicPort: number | null;
  type: string;
  ip: string | null;
}

export interface ContainerSummary {
  id: string;
  shortId: string;
  name: string;
  image: string;
  imageId: string;
  state: ContainerState;
  statusText: string;
  ports: PortMapping[];
  createdAt: number;
  /** Epoch ms the container last started, when the engine reports it. */
  startedAt: number | null;
  labels: Record<string, string>;
  protected: boolean;
  protectedReason: string | null;
}

export interface ContainerStatsSample {
  id: string;
  cpuPct: number;
  memUsedBytes: number;
  memLimitBytes: number;
  memPct: number;
  netRxBytes: number;
  netTxBytes: number;
  pids: number;
}

export interface DockerStatus {
  available: boolean;
  version: string | null;
  apiVersion: string | null;
  os: string | null;
  containersRunning: number;
  containersTotal: number;
  images: number | null;
  error: string | null;
  hostUrl: string;
}

export interface InspectDto {
  id: string;
  shortId: string;
  name: string;
  image: string;
  imageId: string;
  created: number;
  state: { status: string; running: boolean; restarting: boolean; paused: boolean; exitCode: number; startedAt: string | null; finishedAt: string | null };
  config: {
    /** KEY NAMES ONLY — values are stripped before they leave this module. */
    envKeys: string[];
    entrypoint: string | null;
    cmd: string[];
    workingDir: string;
    restartPolicy: { name: string; maximumRetryCount: number };
    exposedPorts: string[];
    labels: Record<string, string>;
  };
  ports: PortMapping[];
  mounts: { type: string; source: string; destination: string; mode: string; readOnly: boolean }[];
  networks: { name: string; ipAddress: string | null; gateway: string | null }[];
  protected: boolean;
  protectedReason: string | null;
}

export interface LogOptions {
  tail: number;
  onLine: (line: string) => void;
  onEnd?: (reason: 'stream-ended' | 'error') => void;
}

/** How many stats calls we run at once when summarising the dashboard. */
const STATS_CONCURRENCY = 4;
/**
 * Seconds Docker waits for SIGTERM before SIGKILL.
 *
 * This MUST stay well under DOCKER_TIMEOUT_MS: the HTTP response only arrives
 * once the container is actually down, so a 10s grace against a 5s client
 * timeout looks exactly like an unreachable proxy ("socket hang up").
 */
const STOP_GRACE_SECONDS = 5;
/** Never return more than this from a single log tail. */
export const LOG_TAIL_MAX = 2000;
export const LOG_TAIL_DEFAULT = 200;

export interface DockerServiceDeps {
  config: AppConfig;
  logger: Logger;
  /** Injectable for tests: a fake with the same shape as dockerode. */
  client?: Docker;
}

/** Docker's `Status` string ("Up 8 minutes") is all the list API gives us. */
const TIME_UNIT_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
  year: 31_536_000,
};

/**
 * Best-effort uptime from the container's status text.
 *
 * `listContainers` does not include StartedAt (that is inspect-only), so the
 * only cheap source is the human string Docker already computed: "Up 8 minutes",
 * "Up About a minute", "Up 3 weeks". Returns null for anything else — the UI
 * shows "—" rather than inventing a number.
 */
export function parseDockerUptime(statusText: string): number | null {
  const trimmed = statusText.trim();
  if (!trimmed.startsWith('Up ')) return null;

  const body = trimmed
    .slice(3)
    .replace(/^About /, '')
    .replace(/\s*\(.*\)$/, '')
    .replace(/^Less than a second$/, '1 second');

  const match = /^(\d+|a|an) (second|minute|hour|day|week|month|year)/.exec(body);
  if (!match) return null;

  const quantity = match[1] === 'a' || match[1] === 'an' ? 1 : Number(match[1]);
  const unit = TIME_UNIT_SECONDS[match[2] ?? ''];
  if (!Number.isFinite(quantity) || unit === undefined) return null;

  return quantity * unit;
}

export class DockerService {
  private readonly docker: Docker;
  private readonly config: AppConfig;
  private readonly logger: Logger;

  constructor(deps: DockerServiceDeps) {
    this.config = deps.config;
    this.logger = deps.logger;

    this.docker =
      deps.client ??
      new Docker({
        host: new URL(deps.config.docker.hostUrl).hostname,
        port: Number(new URL(deps.config.docker.hostUrl).port || 2375),
        protocol: new URL(deps.config.docker.hostUrl).protocol === 'https:' ? 'https' : 'http',
        timeout: deps.config.docker.timeoutMs,
      });
  }

  // ------------------------------------------------------------------ status

  async status(): Promise<DockerStatus> {
    const base: DockerStatus = {
      available: false,
      version: null,
      apiVersion: null,
      os: null,
      containersRunning: 0,
      containersTotal: 0,
      images: null,
      error: null,
      hostUrl: this.config.docker.hostUrl,
    };

    try {
      const version = (await this.docker.version()) as {
        Version?: string;
        ApiVersion?: string;
        Os?: string;
      };

      // listContainers(all) doubles as a cheap count source; if the engine is
      // up but listing fails we still report "available" with a version.
      let running = 0;
      let total = 0;
      try {
        const containers = await this.docker.listContainers({ all: true });
        total = containers.length;
        running = containers.filter((container) => container.State === 'running').length;
      } catch {
        /* counts stay 0 */
      }

      return {
        ...base,
        available: true,
        version: version.Version ?? null,
        apiVersion: version.ApiVersion ?? null,
        os: version.Os ?? null,
        containersRunning: running,
        containersTotal: total,
      };
    } catch (error) {
      this.logger.warn({ err: error }, 'docker status check failed');
      return { ...base, error: 'Docker proxy unreachable' };
    }
  }

  // ------------------------------------------------------------------- list

  async list(): Promise<ContainerSummary[]> {
    const raw = await this.guard(() => this.docker.listContainers({ all: true }));
    return raw.map((info) => this.mapContainer(info));
  }

  /** CPU/RAM for the running containers, for the dashboard bars. */
  async statsFor(ids: readonly string[]): Promise<Map<string, ContainerStatsSample>> {
    const result = new Map<string, ContainerStatsSample>();
    const queue = [...ids];

    const worker = async (): Promise<void> => {
      for (;;) {
        const id = queue.shift();
        if (id === undefined) return;

        try {
          const stats = await this.rawStats(id);
          result.set(id, stats);
        } catch {
          // A container that stopped between list and stats is normal.
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(STATS_CONCURRENCY, ids.length) }, worker));
    return result;
  }

  /** One snapshot, no stream. Returns null when the container is not running. */
  async rawStats(id: string): Promise<ContainerStatsSample> {
    const container = this.docker.getContainer(id);
    const raw = (await container.stats({ stream: false })) as ContainerStats;
    return mapStats(id, raw);
  }

  // ---------------------------------------------------------------- inspect

  async inspect(id: string): Promise<InspectDto> {
    const raw = await this.guard(() => this.docker.getContainer(id).inspect());
    return this.mapInspect(id, raw as InspectRaw);
  }

  // ---------------------------------------------------------------- control

  /**
   * start / stop / restart with the protected-container rule applied.
   * `name` is only used for the audit trail and the error message.
   */
  async action(id: string, action: 'start' | 'stop' | 'restart'): Promise<{ id: string; name: string }> {
    const target = await this.resolve(id);

    if (target.protected) {
      throw new AppError(
        403,
        'container_protected',
        `${target.name} is protected and cannot be ${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'} from the dashboard`,
      );
    }

    const container = this.docker.getContainer(id);

    await this.guard(async () => {
      if (action === 'start') await container.start();
      else if (action === 'stop') await container.stop({ t: STOP_GRACE_SECONDS });
      else await container.restart({ t: STOP_GRACE_SECONDS });
    });

    return { id: target.id, name: target.name };
  }

  /** Removal is only allowed for stopped containers. */
  async remove(id: string): Promise<{ id: string; name: string }> {
    const target = await this.resolve(id);

    if (target.protected) {
      throw new AppError(403, 'container_protected', `${target.name} is protected and cannot be removed from the dashboard`);
    }
    if (target.state === 'running') {
      throw new AppError(409, 'container_running', 'Stop the container before removing it');
    }

    await this.guard(() => this.docker.getContainer(id).remove({ force: false }));

    return { id: target.id, name: target.name };
  }

  /** Resolves an id/name to a summary, or throws a 404-style AppError. */
  async resolve(id: string): Promise<ContainerSummary> {
    try {
      const raw = await this.docker.getContainer(id).inspect();
      const info = raw as InspectRaw;

      return this.mapContainer({
        Id: info.Id,
        Names: [`/${info.Name.replace(/^\//, '')}`],
        Image: info.Config?.Image ?? '',
        ImageID: '',
        State: info.State?.Status ?? 'unknown',
        Status: info.State?.Status ?? 'unknown',
        Created: Math.floor(new Date(info.Created).getTime() / 1000),
        Ports: [],
        Labels: (info.Config?.Labels ?? {}) as Record<string, string>,
        // StartedAt is ISO-8601; the mapper converts it.
        StartedAt: info.State?.StartedAt,
      } as unknown as ContainerInfo);
    } catch (error) {
      throw this.toAppError(error, id);
    }
  }

  // ------------------------------------------------------------------- logs

  /**
   * Streams logs line by line. Returns a stop function — the caller MUST call
   * it when the socket closes, otherwise the Docker stream leaks.
   */
  async followLogs(id: string, options: LogOptions): Promise<() => void> {
    const container = this.docker.getContainer(id);

    const inspected = (await this.guard(() => container.inspect())) as InspectRaw;
    const isTty = Boolean(inspected.Config?.Tty);

    const stream = (await this.guard(() =>
      container.logs({
        // Always follow: the route decides when to stop by calling the returned
        // function. dockerode's types only offer the streaming overload when
        // `follow` is the literal `true`, and a follow:false call would return
        // one giant multiplexed buffer we would have to demux anyway.
        follow: true,
        stdout: true,
        stderr: true,
        tail: options.tail,
        timestamps: false,
        since: Math.max(0, Math.floor(Date.now() / 1000) - 1),
      }),
    )) as NodeJS.ReadableStream;

    let buffer = '';
    let stopped = false;

    const pushChunk = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');

      // Guard against a single enormous line (a binary dump, a missing newline).
      if (buffer.length > 1_000_000) {
        options.onLine(buffer.slice(0, 1000));
        buffer = '';
        return;
      }

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) options.onLine(stripAnsi(line));
        newlineIndex = buffer.indexOf('\n');
      }
    };

    if (isTty) {
      // TTY containers emit raw bytes, no multiplexing header to strip.
      stream.on('data', (chunk: Buffer) => pushChunk(chunk));
    } else {
      // Non-TTY output is multiplexed with an 8-byte header per frame.
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on('data', (chunk: Buffer) => pushChunk(chunk));
      stderr.on('data', (chunk: Buffer) => pushChunk(chunk));
      this.docker.modem.demuxStream(stream, stdout, stderr);
    }

    const cleanup = (): void => {
      if (stopped) return;
      stopped = true;
      try {
        (stream as unknown as { destroy?: () => void }).destroy?.();
      } catch {
        /* already gone */
      }
      options.onEnd?.('stream-ended');
    };

    stream.on('end', cleanup);
    stream.on('error', (error: Error) => {
      this.logger.warn({ err: error, id }, 'container log stream failed');
      options.onEnd?.('error');
      cleanup();
    });

    return () => {
      if (stopped) return;
      stopped = true;
      (stream as unknown as { destroy?: () => void }).destroy?.();
    };
  }

  // ---------------------------------------------------------------- helpers

  isProtected(info: { name: string; id: string; labels: Record<string, string> }): {
    protected: boolean;
    reason: string | null;
  } {
    if (info.labels['capturehost.protected'] === 'true') {
      return { protected: true, reason: 'labelled capturehost.protected=true' };
    }

    const normalisedName = info.name.replace(/^\//, '').toLowerCase();
    const match = this.config.docker.protectedContainers.find((entry) => {
      const needle = entry.toLowerCase();
      return needle === normalisedName || (needle.length >= 6 && info.id.startsWith(needle));
    });

    if (match) return { protected: true, reason: `listed in DOCKER_PROTECTED_CONTAINERS (${match})` };

    return { protected: false, reason: null };
  }

  private mapContainer(info: ContainerInfo): ContainerSummary {
    const name = (info.Names?.[0] ?? info.Id.slice(0, 12)).replace(/^\//, '');
    const labels = (info.Labels ?? {}) as Record<string, string>;
    const protection = this.isProtected({ name, id: info.Id, labels });

    const startedAtRaw = (info as unknown as { StartedAt?: string }).StartedAt;
    const uptimeSeconds = startedAtRaw ? null : parseDockerUptime(info.Status ?? '');

    return {
      id: info.Id,
      shortId: info.Id.slice(0, 12),
      name,
      image: info.Image,
      imageId: info.ImageID ?? '',
      state: normaliseState(info.State),
      statusText: info.Status ?? '',
      ports: (info.Ports ?? []).map((port) => ({
        privatePort: port.PrivatePort,
        publicPort: port.PublicPort ?? null,
        type: port.Type,
        ip: port.IP ?? null,
      })),
      createdAt: (info.Created ?? 0) * 1000,
      // Prefer the exact timestamp when a caller supplied one (inspect path);
      // otherwise derive it from the status string the list API returns.
      startedAt: startedAtRaw
        ? Date.parse(startedAtRaw)
        : uptimeSeconds === null
          ? null
          : Date.now() - uptimeSeconds * 1000,
      labels,
      protected: protection.protected,
      protectedReason: protection.reason,
    };
  }

  private mapInspect(id: string, raw: InspectRaw): InspectDto {
    const name = raw.Name.replace(/^\//, '');
    const labels = (raw.Config?.Labels ?? {}) as Record<string, string>;
    const protection = this.isProtected({ name, id: raw.Id, labels });

    return {
      id: raw.Id,
      shortId: raw.Id.slice(0, 12),
      name,
      image: raw.Config?.Image ?? '',
      imageId: raw.Image ?? '',
      created: Date.parse(raw.Created),
      state: {
        status: raw.State?.Status ?? 'unknown',
        running: Boolean(raw.State?.Running),
        restarting: Boolean(raw.State?.Restarting),
        paused: Boolean(raw.State?.Paused),
        exitCode: raw.State?.ExitCode ?? 0,
        startedAt: raw.State?.StartedAt ?? null,
        finishedAt: raw.State?.FinishedAt ?? null,
      },
      config: {
        // The whole point of this list: KEY NAMES. `Env` holds secrets like
        // DATABASE_URL with passwords; values never leave the server.
        envKeys: (raw.Config?.Env ?? []).map((entry) => entry.split('=')[0] ?? entry).filter(Boolean).sort(),
        entrypoint: Array.isArray(raw.Config?.Entrypoint) ? raw.Config.Entrypoint.join(' ') : (raw.Config?.Entrypoint ?? null),
        cmd: raw.Config?.Cmd ?? [],
        workingDir: raw.Config?.WorkingDir ?? '',
        restartPolicy: {
          name: raw.HostConfig?.RestartPolicy?.Name ?? 'no',
          maximumRetryCount: raw.HostConfig?.RestartPolicy?.MaximumRetryCount ?? 0,
        },
        exposedPorts: Object.keys(raw.Config?.ExposedPorts ?? {}),
        labels,
      },
      ports: Object.entries(raw.NetworkSettings?.Ports ?? {}).map(([containerPort, bindings]) => {
        const [privatePortRaw, type] = containerPort.split('/');
        const binding = (bindings ?? [])[0];
        return {
          privatePort: Number(privatePortRaw),
          publicPort: binding?.HostPort ? Number(binding.HostPort) : null,
          type: type ?? 'tcp',
          ip: binding?.HostIp ?? null,
        };
      }),
      mounts: (raw.Mounts ?? []).map((mount) => ({
        type: mount.Type ?? 'volume',
        source: mount.Source ?? '',
        destination: mount.Destination ?? '',
        mode: mount.Mode ?? '',
        readOnly: Boolean(mount.RW === false),
      })),
      networks: Object.entries(raw.NetworkSettings?.Networks ?? {}).map(([networkName, network]) => ({
        name: networkName,
        ipAddress: network?.IPAddress ?? null,
        gateway: network?.Gateway ?? null,
      })),
      protected: protection.protected,
      protectedReason: protection.reason,
    };
  }

  /** Wraps dockerode calls: unreachable proxy becomes a clean 503. */
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.toAppError(error);
    }
  }

  private toAppError(error: unknown, id?: string): AppError {
    const err = error as { statusCode?: number; status?: number; message?: string; code?: string; reason?: string };
    const status = err.statusCode ?? err.status;
    const text = `${err.message ?? ''} ${err.reason ?? ''}`;

    if (status === 404 || /no such container/i.test(text)) {
      return AppError.notFound(id ? `Container ${id} not found` : 'Container not found');
    }
    if (status === 409 || status === 304 || /container is running|is already (started|stopped|running)|removal of container/i.test(text)) {
      return new AppError(409, 'container_conflict', "Docker refused the request in the container's current state");
    }
    if (
      err.code === 'ECONNREFUSED' ||
      err.code === 'ENOENT' ||
      err.code === 'ETIMEDOUT' ||
      /socket hang up|connect ECONNREFUSED|EHOSTUNREACH/i.test(text)
    ) {
      return new AppError(503, 'docker_unavailable', 'Docker unavailable');
    }

    // Unknown shapes are still Docker's problem, not the client's: 502, generic.
    return new AppError(502, 'docker_error', 'Docker could not complete the request');
  }
}

// ---------------------------------------------------------------- pure helpers

function normaliseState(state: string | undefined): ContainerState {
  switch ((state ?? '').toLowerCase()) {
    case 'running':
    case 'exited':
    case 'created':
    case 'restarting':
    case 'paused':
    case 'removing':
    case 'dead':
      return state?.toLowerCase() as ContainerState;
    default:
      return 'unknown';
  }
}

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** Removes colour/control codes so the browser renders plain text. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '').replace(/\r$/, '');
}

/** Docker's cpu/memory maths, isolated so it can be unit tested. */
export function mapStats(id: string, raw: ContainerStats): ContainerStatsSample {
  const cpuDelta = (raw.cpu_stats?.cpu_usage?.total_usage ?? 0) - (raw.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (raw.cpu_stats?.system_cpu_usage ?? 0) - (raw.precpu_stats?.system_cpu_usage ?? 0);
  const onlineCpus =
    raw.cpu_stats?.online_cpus ?? raw.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;

  const cpuPct = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;

  // "usage" includes page cache; "cache" (cgroup v2: inactive_file) is not real
  // memory pressure, so subtract it the way `docker stats` does.
  const statsBag = (raw.memory_stats?.stats ?? {}) as Record<string, number>;
  const cache = statsBag.cache ?? statsBag.inactive_file ?? 0;
  const memUsed = Math.max(0, (raw.memory_stats?.usage ?? 0) - cache);
  const memLimit = raw.memory_stats?.limit ?? 0;

  let rx = 0;
  let tx = 0;
  for (const iface of Object.values(raw.networks ?? {})) {
    rx += iface?.rx_bytes ?? 0;
    tx += iface?.tx_bytes ?? 0;
  }

  return {
    id,
    cpuPct: Math.round(cpuPct * 100) / 100,
    memUsedBytes: memUsed,
    memLimitBytes: memLimit,
    memPct: memLimit > 0 ? Math.round((memUsed / memLimit) * 10000) / 100 : 0,
    netRxBytes: rx,
    netTxBytes: tx,
    pids: raw.pids_stats?.current ?? 0,
  };
}

// Minimal PassThrough so this module does not import node:stream types into
// the public surface.

interface InspectRaw {
  Id: string;
  Name: string;
  Created: string;
  Image: string;
  Config?: {
    Image?: string;
    Env?: string[];
    Entrypoint?: string[] | string | null;
    Cmd?: string[];
    WorkingDir?: string;
    Tty?: boolean;
    ExposedPorts?: Record<string, unknown>;
    Labels?: Record<string, string>;
  };
  HostConfig?: { RestartPolicy?: { Name?: string; MaximumRetryCount?: number } };
  State?: {
    Status?: string;
    Running?: boolean;
    Restarting?: boolean;
    Paused?: boolean;
    ExitCode?: number;
    StartedAt?: string;
    FinishedAt?: string;
  };
  Mounts?: { Type?: string; Source?: string; Destination?: string; Mode?: string; RW?: boolean }[];
  NetworkSettings?: {
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
    Networks?: Record<string, { IPAddress?: string; Gateway?: string }>;
  };
}
