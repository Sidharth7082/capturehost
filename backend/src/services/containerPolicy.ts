import { AppError } from '../utils/errors.js';

/**
 * Container safety policy — the most security-sensitive file in the project.
 *
 * Why this exists: the socket proxy filters by URL and method, not by request
 * body. It cannot tell a harmless container-create from a privileged one with
 * the host root filesystem mounted. Once BUILD/POST are enabled, *this* module
 * is the only thing standing between a cloned Dockerfile and root on the
 * machine, so every container CaptureHost creates is built from a fixed
 * whitelist here and then re-validated before it is sent to Docker.
 *
 * Nothing user-supplied is spread into the create options. The project can only
 * choose values inside the limits below; everything structural (privileged,
 * mounts, networking, capabilities, restart policy) is decided in this file.
 */

export interface ContainerPolicyLimits {
  memoryDefaultMb: number;
  memoryMaxMb: number;
  cpuDefault: number;
  cpuMax: number;
  pidsLimit: number;
  network: string;
  portRangeStart: number;
  portRangeEnd: number;
}

export interface ContainerRequest {
  projectId: number;
  projectSlug: string;
  deploymentId: number;
  image: string;
  containerPort: number;
  hostPort: number;
  /** Injected at run time only. Keys are validated, values are never logged. */
  env: Record<string, string>;
  memoryLimitMb: number;
  cpuLimit: number;
  pidsLimit: number;
  /** Capabilities to add back after dropping ALL. Validated against the allowlist. */
  capabilities?: readonly string[];
}

export interface BuiltContainer {
  name: string;
  options: Record<string, unknown>;
}

/**
 * The only capabilities this application will ever add back after `CapDrop: ALL`.
 *
 * Everything here is unprivileged in practice: none of them can mount a
 * filesystem, load a kernel module or escape the container. Stock nginx:alpine
 * needs all four (bind :80, own its temp dirs, then drop to the worker user).
 * Anything not on this list — CAP_SYS_ADMIN, CAP_NET_ADMIN, CAP_SYS_PTRACE —
 * is refused outright, no matter what a project asks for.
 */
export const CAPABILITY_ALLOWLIST: readonly string[] = [
  'NET_BIND_SERVICE',
  'CHOWN',
  'SETUID',
  'SETGID',
];

const DEFAULT_CAPABILITIES = [...CAPABILITY_ALLOWLIST];

/** Stored form of the default set, used when a project does not choose. */
export const DEFAULT_CAPABILITIES_CSV = DEFAULT_CAPABILITIES.join(',');

/** Normalises `cap_add` values; throws on anything outside the allowlist. */
export function parseCapabilities(input: readonly string[] | string | null | undefined): string[] {
  if (input === null || input === undefined) return DEFAULT_CAPABILITIES;

  const raw = typeof input === 'string' ? input.split(',') : input;
  const result: string[] = [];

  for (const entry of raw) {
    const name = String(entry).trim().toUpperCase().replace(/^CAP_/, '');
    if (name === '') continue;

    if (!CAPABILITY_ALLOWLIST.includes(name)) {
      throw AppError.badRequest(
        `Capability "${name}" is not allowed. Allowed: ${CAPABILITY_ALLOWLIST.join(', ')}`,
        'capability_not_allowed',
      );
    }

    if (!result.includes(name)) result.push(name);
  }

  return result;
}

export function serializeCapabilities(input: readonly string[] | string | null | undefined): string {
  return parseCapabilities(input).join(',');
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Clamps a project's requested resources into the configured hard ceilings. */
export function clampResources(
  requested: { memoryLimitMb?: number | null; cpuLimit?: number | null; pidsLimit?: number | null },
  limits: ContainerPolicyLimits,
): { memoryLimitMb: number; cpuLimit: number; pidsLimit: number } {
  const memory = requested.memoryLimitMb ?? limits.memoryDefaultMb;
  const cpu = requested.cpuLimit ?? limits.cpuDefault;
  const pids = requested.pidsLimit ?? limits.pidsLimit;

  return {
    memoryLimitMb: Math.min(Math.max(64, Math.floor(memory)), limits.memoryMaxMb),
    cpuLimit: Math.min(Math.max(0.1, cpu), limits.cpuMax),
    pidsLimit: Math.min(Math.max(16, Math.floor(pids)), 4096),
  };
}

function assertPort(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw AppError.badRequest(`${label} must be a port between 1 and 65535`, 'invalid_port');
  }
}

/** Validates env keys so nothing can smuggle a newline or an "=" into the entry. */
function buildEnvList(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => {
      if (!ENV_KEY_PATTERN.test(key)) {
        throw AppError.badRequest(`Environment key "${key.slice(0, 40)}" is not a valid name`, 'invalid_env_key');
      }
      // Values may contain anything except NUL; Docker rejects NUL itself.
      return `${key}=${value.replace(/\u0000/g, '')}`;
    });
}

/**
 * Builds the only create payload this application will ever send.
 *
 * Every field is explicit. There is no spread of caller input, no `...extra`,
 * and no passthrough of a raw request body.
 */
export function buildContainerCreateOptions(request: ContainerRequest, limits: ContainerPolicyLimits): BuiltContainer {
  if (!SLUG_PATTERN.test(request.projectSlug)) {
    throw AppError.badRequest('Project slug is invalid', 'invalid_slug');
  }
  assertPort(request.containerPort, 'Container port');
  assertPort(request.hostPort, 'Host port');

  if (request.hostPort < limits.portRangeStart || request.hostPort > limits.portRangeEnd) {
    throw AppError.badRequest(
      `Host port ${request.hostPort} is outside the allowed range ${limits.portRangeStart}-${limits.portRangeEnd}`,
      'port_out_of_range',
    );
  }

  if (request.image.length === 0 || request.image.length > 255) {
    throw AppError.badRequest('Image reference is invalid', 'invalid_image');
  }

  const resources = clampResources(request, limits);
  const capabilities = parseCapabilities(request.capabilities);
  const name = `capturehost-${request.projectSlug}-${request.deploymentId}`;
  const portKey = `${request.containerPort}/tcp`;

  const options = {
    name,
    Image: request.image,
    Env: buildEnvList(request.env),
    Labels: {
      'capturehost.managed': 'true',
      'capturehost.project': String(request.projectId),
      'capturehost.deployment': String(request.deploymentId),
    },
    ExposedPorts: { [portKey]: {} },
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    OpenStdin: false,
    // No host networking ever: the app joins the dedicated bridge network.
    HostConfig: {
      NetworkMode: limits.network,
      Privileged: false,
      // Drop everything, then add back only allowlisted capabilities.
      CapDrop: ['ALL'],
      CapAdd: capabilities,
      SecurityOpt: ['no-new-privileges:true'],
      // Bind mounts are never constructed — no host paths, no docker.sock.
      Binds: [],
      Devices: [],
      // Published only on loopback; Caddy fronts it in Phase 5.
      PortBindings: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: String(request.hostPort) }] },
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      Memory: resources.memoryLimitMb * 1024 * 1024,
      // Equal to Memory so the container gets no swap headroom.
      MemorySwap: resources.memoryLimitMb * 1024 * 1024,
      NanoCpus: Math.round(resources.cpuLimit * 1_000_000_000),
      PidsLimit: resources.pidsLimit,
      AutoRemove: false,
      ReadonlyRootfs: false, // most images write to their own filesystem
      OomKillDisable: false,
    },
  };

  assertSafeContainerOptions(options);
  return { name, options };
}

/**
 * Re-validates a finished create payload.
 *
 * Belt and braces: even if someone later edits the builder above, or a future
 * code path builds options some other way, this refuses anything that would
 * hand a container more power than the policy allows.
 */
export function assertSafeContainerOptions(options: Record<string, unknown>): void {
  const host = options.HostConfig as Record<string, unknown> | undefined;
  if (!host) throw unsafe('missing HostConfig');

  if (host.Privileged === true || host.Privileged === 'true') throw unsafe('privileged mode');
  if (Array.isArray(host.Binds) && host.Binds.length > 0) throw unsafe('bind mounts');
  if (Array.isArray(host.Mounts) && host.Mounts.length > 0) throw unsafe('mounts');
  if (Array.isArray(host.Devices) && host.Devices.length > 0) throw unsafe('devices');
  if (Array.isArray(host.VolumeDriver)) throw unsafe('volume driver');

  const networkMode = String(host.NetworkMode ?? '');
  if (['host', 'none', 'default', 'bridge'].includes(networkMode) || networkMode.startsWith('container:')) {
    throw unsafe(`network mode "${networkMode}"`);
  }

  for (const key of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupParent']) {
    if (host[key] === 'host') throw unsafe(`${key} host`);
  }

  const capDrop = Array.isArray(host.CapDrop) ? (host.CapDrop as string[]) : [];
  if (!capDrop.includes('ALL')) throw unsafe('capabilities are not dropped');

  const capAdd = Array.isArray(host.CapAdd) ? (host.CapAdd as string[]) : [];
  for (const capability of capAdd) {
    if (!CAPABILITY_ALLOWLIST.includes(String(capability).toUpperCase().replace(/^CAP_/, ''))) {
      throw unsafe(`capability ${capability}`);
    }
  }

  const securityOpt = Array.isArray(host.SecurityOpt) ? (host.SecurityOpt as string[]) : [];
  if (!securityOpt.some((opt) => opt.startsWith('no-new-privileges'))) {
    throw unsafe('no-new-privileges missing');
  }

  if (typeof host.Memory !== 'number' || host.Memory <= 0) throw unsafe('memory limit missing');
  const nanoCpus = typeof host.NanoCpus === 'number' ? host.NanoCpus : 0;
  if (nanoCpus <= 0) throw unsafe('cpu limit missing');
  if (typeof host.PidsLimit !== 'number' || host.PidsLimit <= 0) throw unsafe('pids limit missing');

  const bindings = (host.PortBindings ?? {}) as Record<string, { HostIp?: string; HostPort?: string }[]>;
  for (const [portKey, entries] of Object.entries(bindings)) {
    for (const entry of entries ?? []) {
      if (entry.HostIp !== '127.0.0.1') {
        throw unsafe(`port ${portKey} published on ${entry.HostIp ?? 'all interfaces'}`);
      }
    }
  }

  const restart = host.RestartPolicy as { Name?: string } | undefined;
  if (restart?.Name !== 'unless-stopped') throw unsafe('unexpected restart policy');
}

function unsafe(reason: string): AppError {
  return new AppError(400, 'unsafe_container_config', `Refused to create the container: ${reason} is not allowed`);
}

/** Names/ids of containers this app owns, used to scope destructive calls. */
export function isManagedContainer(labels: Record<string, string> | undefined): boolean {
  return labels?.['capturehost.managed'] === 'true';
}
