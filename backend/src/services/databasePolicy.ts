import { AppError } from '../utils/errors.js';
import { clampResources, type ContainerPolicyLimits } from './containerPolicy.js';

/**
 * The database container policy — the app policy plus exactly one exception.
 *
 * Applications may mount nothing. A database needs its data to survive a container
 * replacement, so it gets **one named volume and only that**:
 *
 *   Binds: ["capturehost-db-<id>:/var/lib/postgresql/data"]
 *
 * The rule is enforced twice, like the app policy: the builder never takes a path
 * from user input, and `assertSafeDatabaseOptions` re-checks the finished payload
 * against the volume that this database is *supposed* to have. Everything else
 * stays refused — no host paths, no `docker.sock`, no `:ro`/`:rw` suffixes, no
 * `Mounts` array, no privileged mode, no devices, no host networking, and no
 * capability beyond `CapDrop: ['ALL']` (Postgres runs as uid 999, it never needs
 * to bind a privileged port).
 */

export const DATABASE_IMAGE_REPO = 'postgres';
/** The only tags that may be used. Never `latest`, never a user-supplied tag. */
export const DATABASE_ALLOWED_VERSIONS = ['16-alpine', '17-alpine'] as const;
export type DatabaseVersion = (typeof DATABASE_ALLOWED_VERSIONS)[number];

export const DATABASE_DATA_PATH = '/var/lib/postgresql/data';
export const DATABASE_VOLUME_PREFIX = 'capturehost-db-';
export const DATABASE_CONTAINER_PREFIX = 'capturehost-db-';
export const DATABASE_CONTAINER_PORT = 5432;
export const DATABASE_OWNER = 'capturehost';
/**
 * What the Postgres image genuinely needs under a capability-dropping runtime.
 *
 * The official entrypoint starts as root, `chown`s the data directory and
 * `/var/run/postgresql`, then drops to uid 999:
 *   chown  -> CAP_CHOWN
 *   chmod  -> CAP_FOWNER (root can only chmod what it owns without it)
 *   drop   -> CAP_SETUID / CAP_SETGID
 * Nothing else, and none of these escapes the container: they act on files inside
 * its own volumes. Without them the container crash-loops with
 * "chown: /var/lib/postgresql/data/pgdata: Operation not permitted".
 */
export const DATABASE_CAPABILITIES = ['CHOWN', 'FOWNER', 'SETUID', 'SETGID'] as const;
/** Ports published for local tools come from the app range, on loopback only. */
export const DATABASE_LABEL = 'capturehost.database';

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;
const VERSION_PATTERN = /^[0-9]+-alpine$/;

export function assertDatabaseName(name: string): string {
  const value = name.trim().toLowerCase();
  if (!NAME_PATTERN.test(value)) {
    throw AppError.badRequest(
      'Name must be 3-30 characters: lowercase letters, digits and dashes, starting with a letter',
      'invalid_database_name',
    );
  }
  return value;
}

export function assertDatabaseVersion(version: string): DatabaseVersion {
  if (!VERSION_PATTERN.test(version) || !DATABASE_ALLOWED_VERSIONS.includes(version as DatabaseVersion)) {
    throw AppError.badRequest(
      `Version must be one of ${DATABASE_ALLOWED_VERSIONS.join(', ')}`,
      'invalid_database_version',
    );
  }
  return version as DatabaseVersion;
}

export function databaseVolumeName(id: number): string {
  if (!Number.isInteger(id) || id < 1) throw AppError.badRequest('Database id is invalid', 'invalid_database_id');
  return `${DATABASE_VOLUME_PREFIX}${id}`;
}

export function databaseContainerName(id: number): string {
  if (!Number.isInteger(id) || id < 1) throw AppError.badRequest('Database id is invalid', 'invalid_database_id');
  return `${DATABASE_CONTAINER_PREFIX}${id}`;
}

export function databaseImage(version: string): string {
  return `${DATABASE_IMAGE_REPO}:${assertDatabaseVersion(version)}`;
}

export interface DatabaseCreateRequest {
  id: number;
  password: string;
  version: string;
  dbName: string;
  username: string;
  /** When set, the container publishes this port on 127.0.0.1 only. */
  publishedPort: number | null;
  memoryLimitMb?: number | null;
  cpuLimit?: number | null;
  limits: ContainerPolicyLimits;
  /**
   * Extra labels merged into the container. Production passes none; the
   * integration test tags its containers `capturehost.test=true` so they can be
   * found and removed without touching anything real.
   */
  extraLabels?: Record<string, string>;
}

export interface BuiltDatabaseContainer {
  name: string;
  volume: string;
  options: Record<string, unknown>;
}

export function buildDatabaseCreateOptions(request: DatabaseCreateRequest): BuiltDatabaseContainer {
  const volume = databaseVolumeName(request.id);
  const name = databaseContainerName(request.id);
  const image = databaseImage(request.version);
  const resources = clampResources(
    { memoryLimitMb: request.memoryLimitMb ?? null, cpuLimit: request.cpuLimit ?? null },
    request.limits,
  );

  if (request.publishedPort !== null) {
    assertPort(request.publishedPort, 'Published port');
    if (request.publishedPort < request.limits.portRangeStart || request.publishedPort > request.limits.portRangeEnd) {
      throw AppError.badRequest(
        `Published port ${request.publishedPort} is outside ${request.limits.portRangeStart}-${request.limits.portRangeEnd}`,
        'port_out_of_range',
      );
    }
  }

  const portKey = `${DATABASE_CONTAINER_PORT}/tcp`;
  const options = {
    name,
    Image: image,
    Env: [
      `POSTGRES_USER=${request.username}`,
      `POSTGRES_PASSWORD=${request.password}`,
      `POSTGRES_DB=${request.dbName}`,
      // Predictable on-disk layout under the volume mount.
      'PGDATA=/var/lib/postgresql/data/pgdata',
    ],
    Labels: {
      'capturehost.managed': 'true',
      [DATABASE_LABEL]: String(request.id),
      'capturehost.database.name': request.dbName,
      ...(request.extraLabels ?? {}),
    },
    ExposedPorts: { [portKey]: {} },
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    OpenStdin: false,
    Healthcheck: {
      Test: ['CMD-SHELL', `pg_isready -U ${request.username} -d ${request.dbName} -h 127.0.0.1`],
      Interval: 5_000_000_000,
      Timeout: 3_000_000_000,
      Retries: 12,
      StartPeriod: 10_000_000_000,
    },
    HostConfig: {
      NetworkMode: request.limits.network,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: [...DATABASE_CAPABILITIES],
      // The single exception. Built from the id, never from user input.
      Binds: [`${volume}:${DATABASE_DATA_PATH}`],
      Devices: [],
      PortBindings:
        request.publishedPort === null
          ? {}
          : { [portKey]: [{ HostIp: '127.0.0.1', HostPort: String(request.publishedPort) }] },
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      Memory: resources.memoryLimitMb * 1024 * 1024,
      MemorySwap: resources.memoryLimitMb * 1024 * 1024,
      NanoCpus: Math.round(resources.cpuLimit * 1_000_000_000),
      PidsLimit: resources.pidsLimit,
      AutoRemove: false,
      SecurityOpt: ['no-new-privileges:true'],
      OomKillDisable: false,
    },
  };

  assertSafeDatabaseOptions(options, volume);
  return { name, volume, options };
}

/**
 * Re-validates a finished create payload for a database.
 *
 * The only thing this permits that the app policy does not is the one expected
 * named volume. Every other refusal is kept, so a future edit to the builder (or a
 * payload built somewhere else) cannot quietly hand a container the host.
 */
export function assertSafeDatabaseOptions(options: Record<string, unknown>, expectedVolume: string): void {
  const unsafe = (what: string): AppError =>
    AppError.badRequest(`Refusing an unsafe database container: ${what}`, 'unsafe_container');

  const host = options.HostConfig as Record<string, unknown> | undefined;
  if (!host) throw unsafe('missing HostConfig');

  const binds = host.Binds;
  if (!Array.isArray(binds)) throw unsafe('binds are not a list');
  if (binds.length !== 1) throw unsafe(`${binds.length} mount(s) instead of exactly one volume`);

  const bind = String(binds[0]);
  const separator = bind.lastIndexOf(':');
  if (separator <= 0) throw unsafe('a bind without a source:target pair');

  const source = bind.slice(0, separator);
  const target = bind.slice(separator + 1);

  if (source !== expectedVolume) throw unsafe(`volume "${source}" is not "${expectedVolume}"`);
  if (!source.startsWith(DATABASE_VOLUME_PREFIX)) throw unsafe('volume is not a CaptureHost database volume');
  if (source.includes('/') || source.includes('..')) throw unsafe('volume source looks like a path');
  if (target !== DATABASE_DATA_PATH) throw unsafe(`mount target "${target}" is not ${DATABASE_DATA_PATH}`);
  // ":ro", ":rw", ":z", ":Z" would all appear here as part of the target.
  if (target.includes(',')) throw unsafe('mount carries options');

  if (Array.isArray(host.Mounts) && host.Mounts.length > 0) throw unsafe('mounts');
  if (host.Privileged === true || host.Privileged === 'true') throw unsafe('privileged mode');
  if (Array.isArray(host.Devices) && host.Devices.length > 0) throw unsafe('devices');
  if (host.PidMode === 'host' || host.IpcMode === 'host' || host.UTSMode === 'host') throw unsafe('host namespace');

  const networkMode = String(host.NetworkMode ?? '');
  if (['host', 'none', 'default', 'bridge'].includes(networkMode) || networkMode.startsWith('container:')) {
    throw unsafe(`network mode "${networkMode}"`);
  }

  const capDrop = Array.isArray(host.CapDrop) ? (host.CapDrop as string[]) : [];
  if (!capDrop.includes('ALL')) throw unsafe('capabilities are not dropped');
  const capAdd = Array.isArray(host.CapAdd) ? (host.CapAdd as string[]) : [];
  for (const capability of capAdd) {
    const name = String(capability).toUpperCase().replace(/^CAP_/, '');
    if (!(DATABASE_CAPABILITIES as readonly string[]).includes(name)) {
      throw unsafe(`capability ${capability} is not needed by Postgres`);
    }
  }

  const bindings = host.PortBindings as Record<string, Array<Record<string, unknown>>> | undefined;
  for (const entries of Object.values(bindings ?? {})) {
    for (const entry of entries) {
      if (String(entry.HostIp ?? '') !== '127.0.0.1') throw unsafe('a published port is not on 127.0.0.1');
    }
  }
}

function assertPort(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw AppError.badRequest(`${label} must be between 1 and 65535`, 'invalid_port');
  }
}
