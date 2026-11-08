import { describe, expect, it } from 'vitest';
import {
  assertSafeContainerOptions,
  buildContainerCreateOptions,
  clampResources,
  type ContainerPolicyLimits,
  type ContainerRequest,
} from '../src/services/containerPolicy.js';

/**
 * These tests exist to be adversarial. Phase 4 lets a cloned Dockerfile run on
 * the machine, so the create payload is the last line of defence: anything that
 * could hand a container more power than a normal process must be refused.
 */

const limits: ContainerPolicyLimits = {
  memoryDefaultMb: 512,
  memoryMaxMb: 4096,
  cpuDefault: 0.5,
  cpuMax: 4,
  pidsLimit: 256,
  network: 'capturehost-apps',
  portRangeStart: 8100,
  portRangeEnd: 8999,
};

const baseRequest: ContainerRequest = {
  projectId: 1,
  projectSlug: 'demo',
  deploymentId: 12,
  image: 'capturehost/demo:abc1234',
  containerPort: 80,
  hostPort: 8100,
  env: { NODE_ENV: 'production' },
  memoryLimitMb: 512,
  cpuLimit: 0.5,
  pidsLimit: 256,
};

function host(options: Record<string, unknown>): Record<string, unknown> {
  return options.HostConfig as Record<string, unknown>;
}

describe('buildContainerCreateOptions', () => {
  it('produces a locked-down container by default', () => {
    const { name, options } = buildContainerCreateOptions(baseRequest, limits);
    const config = host(options);

    expect(name).toBe('capturehost-demo-12');
    expect(options.Image).toBe('capturehost/demo:abc1234');

    expect(options.Labels).toEqual({
      'capturehost.managed': 'true',
      'capturehost.project': '1',
      'capturehost.deployment': '12',
    });

    expect(config.Privileged).toBe(false);
    expect(config.CapDrop).toEqual(['ALL']);
    // Only the four safe ones come back, and only these four ever can.
    expect(config.CapAdd).toEqual(['NET_BIND_SERVICE', 'CHOWN', 'SETUID', 'SETGID']);
    expect(config.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(config.Binds).toEqual([]);
    expect(config.Devices).toEqual([]);
    expect(config.NetworkMode).toBe('capturehost-apps');
    expect(config.RestartPolicy).toEqual({ Name: 'unless-stopped', MaximumRetryCount: 0 });
    expect(config.Memory).toBe(512 * 1024 * 1024);
    expect(config.MemorySwap).toBe(512 * 1024 * 1024);
    expect(config.NanoCpus).toBe(500_000_000);
    expect(config.PidsLimit).toBe(256);
  });

  it('publishes the port on loopback only', () => {
    const { options } = buildContainerCreateOptions(baseRequest, limits);
    expect(host(options).PortBindings).toEqual({
      '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8100' }],
    });
  });

  it('never spreads caller input into the payload', () => {
    // Extra fields on the request must not appear anywhere in the result.
    const sneaky = {
      ...baseRequest,
      Privileged: true,
      HostConfig: { Binds: ['/:/host'] },
      Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
      env: { OK: 'yes' },
    } as ContainerRequest;

    const { options } = buildContainerCreateOptions(sneaky, limits);
    const serialised = JSON.stringify(options);

    expect(serialised).not.toContain('/var/run/docker.sock');
    expect(serialised).not.toContain('/:/host');
    expect(host(options).Privileged).toBe(false);
  });

  it('rejects a host port outside the configured range', () => {
    expect(() => buildContainerCreateOptions({ ...baseRequest, hostPort: 22 }, limits)).toThrow(
      /outside the allowed range/,
    );
    expect(() => buildContainerCreateOptions({ ...baseRequest, hostPort: 9999 }, limits)).toThrow(
      /outside the allowed range/,
    );
  });

  it('rejects an invalid project slug', () => {
    expect(() => buildContainerCreateOptions({ ...baseRequest, projectSlug: 'Bad Slug' }, limits)).toThrow(
      /slug/i,
    );
  });

  it('rejects env keys that are not identifiers', () => {
    for (const key of ['BAD KEY', 'WITH=EQUALS', 'NEW\nLINE', '']) {
      expect(() => buildContainerCreateOptions({ ...baseRequest, env: { [key]: 'x' } }, limits), key).toThrow(
        /Environment key/i,
      );
    }
  });

  it('clamps resources to the hard ceiling', () => {
    const { options } = buildContainerCreateOptions(
      { ...baseRequest, memoryLimitMb: 99_999, cpuLimit: 64, pidsLimit: 99_999 },
      limits,
    );
    const config = host(options);

    expect(config.Memory).toBe(4096 * 1024 * 1024);
    expect(config.NanoCpus).toBe(4_000_000_000);
    expect(config.PidsLimit).toBe(4096);
  });
});

describe('clampResources', () => {
  it('falls back to the configured defaults', () => {
    expect(clampResources({}, limits)).toEqual({
      memoryLimitMb: 512,
      cpuLimit: 0.5,
      pidsLimit: 256,
    });
  });

  it('enforces a floor so a project cannot ask for 1 MB', () => {
    expect(clampResources({ memoryLimitMb: 1, cpuLimit: 0.01, pidsLimit: 1 }, limits)).toEqual({
      memoryLimitMb: 64,
      cpuLimit: 0.1,
      pidsLimit: 16,
    });
  });
});

describe('capabilities', () => {
  it('accepts a subset from the allowlist', () => {
    const { options } = buildContainerCreateOptions({ ...baseRequest, capabilities: ['NET_BIND_SERVICE'] }, limits);
    expect(host(options).CapAdd).toEqual(['NET_BIND_SERVICE']);
  });

  it('normalises the CAP_ prefix and duplicates', () => {
    const { options } = buildContainerCreateOptions(
      { ...baseRequest, capabilities: ['cap_chown', 'CHOWN', 'Setuid'] },
      limits,
    );
    expect(host(options).CapAdd).toEqual(['CHOWN', 'SETUID']);
  });

  it('allows dropping capabilities entirely', () => {
    const { options } = buildContainerCreateOptions({ ...baseRequest, capabilities: [] }, limits);
    expect(host(options).CapAdd).toEqual([]);
  });

  it('refuses anything outside the allowlist', () => {
    for (const capability of ['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'DAC_READ_SEARCH', 'SYS_MODULE']) {
      expect(() => buildContainerCreateOptions({ ...baseRequest, capabilities: [capability] }, limits), capability).toThrow(
        /not allowed/,
      );
    }
  });

  it('refuses a capability smuggled into a finished payload', () => {
    const options = buildContainerCreateOptions(baseRequest, limits).options;
    host(options).CapAdd = ['SYS_ADMIN'];
    expect(() => assertSafeContainerOptions(options)).toThrow(/capability/i);
  });
});

describe('assertSafeContainerOptions', () => {
  const safe = () => buildContainerCreateOptions(baseRequest, limits).options;

  it('accepts the payload the builder produces', () => {
    expect(() => assertSafeContainerOptions(safe())).not.toThrow();
  });

  // Each case takes a valid payload and injects one dangerous field. This is
  // the "try to sneak it in" suite the phase requires.
  const attacks: Array<[string, (options: Record<string, unknown>) => void]> = [
    ['privileged mode', (o) => (host(o).Privileged = true)],
    ['bind mounts', (o) => (host(o).Binds = ['/:/host'])],
    ['the docker socket as a mount', (o) => (host(o).Binds = ['/var/run/docker.sock:/var/run/docker.sock'])],
    ['host networking', (o) => (host(o).NetworkMode = 'host')],
    ['host PID namespace', (o) => (host(o).PidMode = 'host')],
    ['host IPC namespace', (o) => (host(o).IpcMode = 'host')],
    ['host devices', (o) => (host(o).Devices = [{ PathOnHost: '/dev/sda' }])],
    ['missing capability drop', (o) => (host(o).CapDrop = [])],
    ['missing no-new-privileges', (o) => (host(o).SecurityOpt = [])],
    ['no memory limit', (o) => delete host(o).Memory],
    ['no cpu limit', (o) => delete host(o).NanoCpus],
    ['no pids limit', (o) => delete host(o).PidsLimit],
    ['publishing on all interfaces', (o) => {
      host(o).PortBindings = { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8100' }] };
    }],
    ['another network mode', (o) => (host(o).NetworkMode = 'container:abc')],
    ['a different restart policy', (o) => (host(o).RestartPolicy = { Name: 'always' })],
  ];

  for (const [name, attack] of attacks) {
    it(`refuses ${name}`, () => {
      const options = safe();
      attack(options);
      expect(() => assertSafeContainerOptions(options)).toThrow(/not allowed/i);
    });
  }

  it('refuses a payload with no HostConfig at all', () => {
    expect(() => assertSafeContainerOptions({ Image: 'x' })).toThrow(/HostConfig/);
  });
});
