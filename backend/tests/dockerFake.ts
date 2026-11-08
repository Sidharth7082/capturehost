import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';

/**
 * A tiny stand-in for the dockerode client.
 *
 * Only the calls DockerService makes are implemented, so the tests exercise the
 * real mapping/protection/error code paths without a daemon.
 */

export interface FakeContainerSpec {
  id: string;
  name: string;
  image?: string;
  state?: 'running' | 'exited' | 'paused' | 'restarting' | 'created';
  labels?: Record<string, string>;
  env?: string[];
  statusText?: string;
  ports?: { PrivatePort: number; PublicPort?: number; Type: string; IP?: string }[];
  created?: number;
  /** TTY containers skip docker's 8-byte multiplexing header. */
  tty?: boolean;
  mounts?: { Type: string; Source: string; Destination: string; Mode?: string; RW?: boolean }[];
  networks?: Record<string, { IPAddress?: string; Gateway?: string }>;
}

export interface FakeDocker {
  client: Docker;
  calls: string[];
  logsStreams: PassThrough[];
  setState: (id: string, state: FakeContainerSpec['state']) => void;
  setAvailable: (available: boolean) => void;
  setFailure: (failure: { statusCode: number; message: string } | null) => void;
}

function containerInfo(spec: FakeContainerSpec) {
  return {
    Id: spec.id,
    Names: [`/${spec.name}`],
    Image: spec.image ?? 'nginx:latest',
    ImageID: 'sha256:abc',
    State: spec.state ?? 'running',
    Status: spec.statusText ?? 'Up 3 minutes',
    Created: spec.created ?? Math.floor(Date.now() / 1000) - 300,
    Ports: spec.ports ?? [],
    Labels: spec.labels ?? {},
    StartedAt: new Date(Date.now() - 180_000).toISOString(),
  };
}

function containerInspect(spec: FakeContainerSpec) {
  return {
    Id: spec.id,
    Name: `/${spec.name}`,
    Created: new Date(Date.now() - 600_000).toISOString(),
    Image: 'sha256:abc',
    Config: {
      Image: spec.image ?? 'nginx:latest',
      Env: spec.env ?? ['PATH=/usr/bin', 'DATABASE_URL=postgres://user:hunter2@db/app'],
      Cmd: ['nginx', '-g', 'daemon off;'],
      Entrypoint: ['/docker-entrypoint.sh'],
      WorkingDir: '/',
      Tty: spec.tty ?? false,
      ExposedPorts: { '80/tcp': {} },
      Labels: spec.labels ?? {},
    },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } },
    State: {
      Status: spec.state ?? 'running',
      Running: (spec.state ?? 'running') === 'running',
      Restarting: spec.state === 'restarting',
      Paused: spec.state === 'paused',
      ExitCode: 0,
      StartedAt: new Date(Date.now() - 180_000).toISOString(),
      FinishedAt: '0001-01-01T00:00:00Z',
    },
    Mounts: spec.mounts ?? [],
    NetworkSettings: {
      Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] },
      Networks: spec.networks ?? { bridge: { IPAddress: '172.17.0.2', Gateway: '172.17.0.1' } },
    },
  };
}

const STATS_PAYLOAD = {
  cpu_stats: {
    cpu_usage: { total_usage: 3_000_000, percpu_usage: [1, 1, 1, 1] },
    system_cpu_usage: 20_000_000,
    online_cpus: 4,
  },
  // 1s of work on 4 cpus: (1e6/8e6)*4*100 = 50 %
  precpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 12_000_000 },
  memory_stats: { usage: 200 * 1024 * 1024, limit: 1024 * 1024 * 1024, stats: { cache: 50 * 1024 * 1024 } },
  networks: { eth0: { rx_bytes: 1024, tx_bytes: 2048 } },
  pids_stats: { current: 7 },
};

export function createFakeDocker(specs: FakeContainerSpec[]): FakeDocker {
  const containers = new Map(specs.map((spec) => [spec.id, { ...spec }]));
  const calls: string[] = [];
  const logsStreams: PassThrough[] = [];
  let available = true;
  let failure: { statusCode: number; message: string } | null = null;

  const find = (id: string): FakeContainerSpec | undefined =>
    containers.get(id) ?? [...containers.values()].find((spec) => spec.name === id);

  const client = {
    version: async () => {
      if (!available) {
        const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        throw error;
      }
      return { Version: '29.9.2', ApiVersion: '1.56', Os: 'linux' };
    },

    listContainers: async () => {
      if (!available) {
        const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        throw error;
      }
      calls.push('listContainers');
      return [...containers.values()].map(containerInfo);
    },

    getContainer: (id: string) => {
      const spec = find(id);
      const notFound = () => Object.assign(new Error('no such container'), { statusCode: 404 });

      return {
        inspect: async () => {
          calls.push(`inspect:${id}`);
          if (failure) throw Object.assign(new Error(failure.message), { statusCode: failure.statusCode });
          if (!spec) throw notFound();
          return containerInspect(spec);
        },
        start: async () => {
          calls.push(`start:${spec?.name ?? id}`);
          if (failure) throw Object.assign(new Error(failure.message), { statusCode: failure.statusCode });
          if (!spec) throw notFound();
          if (spec.state === 'running') {
            throw Object.assign(new Error('container is already running'), { statusCode: 304 });
          }
          spec.state = 'running';
        },
        stop: async () => {
          calls.push(`stop:${spec?.name ?? id}`);
          if (!spec) throw notFound();
          if (spec.state !== 'running') {
            throw Object.assign(new Error('container is not running'), { statusCode: 304 });
          }
          spec.state = 'exited';
        },
        restart: async () => {
          calls.push(`restart:${spec?.name ?? id}`);
          if (!spec) throw notFound();
          spec.state = 'running';
        },
        remove: async () => {
          calls.push(`remove:${spec?.name ?? id}`);
          if (!spec) throw notFound();
          if (spec.state === 'running') {
            throw Object.assign(new Error('You cannot remove a running container'), { statusCode: 409 });
          }
          containers.delete(spec.id);
        },
        stats: async () => {
          calls.push(`stats:${spec?.name ?? id}`);
          if (!spec) throw notFound();
          return STATS_PAYLOAD;
        },
        logs: async () => {
          calls.push(`logs:${spec?.name ?? id}`);
          if (!spec) throw notFound();
          const stream = new PassThrough();
          logsStreams.push(stream);
          return stream;
        },
      };
    },

    modem: {
      // Non-TTY path only; tests use tty: true containers so raw data is read.
      demuxStream: (stream: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): void => {
        stream.on('data', (chunk: Buffer) => stdout.write(chunk));
      },
    },
  } as unknown as Docker;

  return {
    client,
    calls,
    logsStreams,
    setState: (id, state) => {
      const spec = find(id);
      if (spec) spec.state = state;
    },
    setAvailable: (value) => {
      available = value;
    },
    setFailure: (value) => {
      failure = value;
    },
  };
}
