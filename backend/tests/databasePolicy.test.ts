import { describe, expect, it } from 'vitest';
import {
  DATABASE_DATA_PATH,
  assertDatabaseName,
  assertDatabaseVersion,
  assertSafeDatabaseOptions,
  buildDatabaseCreateOptions,
  databaseContainerName,
  databaseImage,
  databaseVolumeName,
} from '../src/services/databasePolicy.js';
import type { ContainerPolicyLimits } from '../src/services/containerPolicy.js';

/**
 * The one exception to "no mounts", tested from both directions.
 *
 * A database must be allowed exactly one named volume, derived from its id, at the
 * image's data path. Everything that could reach the host — a path, the docker
 * socket, a privileged container, a second mount, a ":ro" suffix — has to keep
 * throwing. These are the tests that would catch a future "just add the bind"
 * edit.
 */

const LIMITS: ContainerPolicyLimits = {
  memoryDefaultMb: 512,
  memoryMaxMb: 4096,
  cpuDefault: 0.5,
  cpuMax: 4,
  pidsLimit: 256,
  network: 'capturehost-apps',
  portRangeStart: 8100,
  portRangeEnd: 8999,
};

function build(overrides: Partial<Parameters<typeof buildDatabaseCreateOptions>[0]> = {}) {
  return buildDatabaseCreateOptions({
    id: 7,
    password: 'fixture-password-not-real-0123456789',
    version: '17-alpine',
    dbName: 'shop',
    username: 'capturehost',
    publishedPort: null,
    limits: LIMITS,
    ...overrides,
  });
}

describe('buildDatabaseCreateOptions', () => {
  it('mounts exactly one named volume at the postgres data path', () => {
    const built = build();
    const host = built.options.HostConfig as Record<string, unknown>;

    expect(built.name).toBe('capturehost-db-7');
    expect(built.volume).toBe('capturehost-db-7');
    expect(host.Binds).toEqual([`capturehost-db-7:${DATABASE_DATA_PATH}`]);
    expect(host.Privileged).toBe(false);
    expect(host.CapDrop).toEqual(['ALL']);
    expect(host.CapAdd).toEqual(['CHOWN', 'FOWNER', 'SETUID', 'SETGID']);
    expect(host.Devices).toEqual([]);
    expect(host.NetworkMode).toBe('capturehost-apps');
  });

  it('labels the container so the generic container list can refuse it', () => {
    const built = build();
    expect(built.options.Labels).toMatchObject({
      'capturehost.managed': 'true',
      'capturehost.database': '7',
    });
  });

  it('publishes nothing by default and only on 127.0.0.1 when asked', () => {
    const internal = build().options.HostConfig as Record<string, unknown>;
    expect(internal.PortBindings).toEqual({});

    const published = build({ publishedPort: 8200 }).options.HostConfig as Record<string, unknown>;
    expect(published.PortBindings).toEqual({
      '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '8200' }],
    });
  });

  it('refuses a published port outside the app range', () => {
    expect(() => build({ publishedPort: 443 })).toThrow(/outside/i);
  });

  it('refuses an image tag that is not on the allowlist', () => {
    expect(() => build({ version: 'latest' })).toThrow(/Version must be one of/i);
    expect(() => build({ version: '15-alpine' })).toThrow(/Version must be one of/i);
  });
});

describe('assertSafeDatabaseOptions — the refusals that must survive', () => {
  const good = () => build().options as Record<string, unknown>;
  const withHost = (mutate: (host: Record<string, unknown>) => void) => {
    const options = structuredClone(good());
    mutate(options.HostConfig as Record<string, unknown>);
    return options;
  };

  it('accepts the payload the builder produces', () => {
    expect(() => assertSafeDatabaseOptions(good(), 'capturehost-db-7')).not.toThrow();
  });

  it('refuses a host bind', () => {
    expect(() =>
      assertSafeDatabaseOptions(withHost((h) => {
        h.Binds = ['/srv/data:/var/lib/postgresql/data'];
      }), 'capturehost-db-7'),
    ).toThrow(/not "capturehost-db-7"/);
  });

  it('refuses the docker socket', () => {
    expect(() =>
      assertSafeDatabaseOptions(withHost((h) => {
        h.Binds = ['/var/run/docker.sock:/var/run/docker.sock'];
      }), 'capturehost-db-7'),
    ).toThrow(/not "capturehost-db-7"/);
  });

  it('refuses someone else\'s volume', () => {
    expect(() =>
      assertSafeDatabaseOptions(withHost((h) => {
        h.Binds = ['capturehost-db-99:/var/lib/postgresql/data'];
      }), 'capturehost-db-7'),
    ).toThrow(/not "capturehost-db-7"/);
  });

  it('refuses a volume mounted somewhere else', () => {
    expect(() =>
      assertSafeDatabaseOptions(withHost((h) => {
        h.Binds = ['capturehost-db-7:/etc'];
      }), 'capturehost-db-7'),
    ).toThrow(/is not \/var\/lib\/postgresql\/data/);
  });

  it('refuses a read-only or optioned mount', () => {
    expect(() =>
      assertSafeDatabaseOptions(withHost((h) => {
        h.Binds = ['capturehost-db-7:/var/lib/postgresql/data,ro'];
      }), 'capturehost-db-7'),
    ).toThrow(/options|is not \/var\/lib\/postgresql\/data/);
  });

  it('refuses a second mount', () => {
    expect(() =>
      assertSafeDatabaseOptions(withHost((h) => {
        h.Binds = ['capturehost-db-7:/var/lib/postgresql/data', 'capturehost-db-7:/backup'];
      }), 'capturehost-db-7'),
    ).toThrow(/exactly one volume/);
  });

  it('refuses privileged mode, devices and host namespaces', () => {
    expect(() => assertSafeDatabaseOptions(withHost((h) => { h.Privileged = true; }), 'capturehost-db-7')).toThrow(/privileged/);
    expect(() => assertSafeDatabaseOptions(withHost((h) => { h.Devices = ['/dev/sda']; }), 'capturehost-db-7')).toThrow(/devices/);
    expect(() => assertSafeDatabaseOptions(withHost((h) => { h.PidMode = 'host'; }), 'capturehost-db-7')).toThrow(/host namespace/);
    expect(() => assertSafeDatabaseOptions(withHost((h) => { h.NetworkMode = 'host'; }), 'capturehost-db-7')).toThrow(/network mode/);
  });

  it('refuses extra capabilities and dropped-all being removed', () => {
    expect(() => assertSafeDatabaseOptions(withHost((h) => { h.CapAdd = ['SYS_ADMIN']; }), 'capturehost-db-7')).toThrow(/capability/);
    expect(() => assertSafeDatabaseOptions(withHost((h) => { h.CapDrop = []; }), 'capturehost-db-7')).toThrow(/not dropped/);
  });

  it('refuses a published port that is not loopback', () => {
    expect(() =>
      assertSafeDatabaseOptions(withHost((h) => {
        h.PortBindings = { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '8200' }] };
      }), 'capturehost-db-7'),
    ).toThrow(/127\.0\.0\.1/);
  });
});

describe('names, versions and derived identifiers', () => {
  it('accepts sane names and refuses the rest', () => {
    expect(assertDatabaseName('shop-db')).toBe('shop-db');
    expect(assertDatabaseName('  My-DB ')).toBe('my-db');
    for (const bad of ['ab', '1shop', '-shop', 'shop_db', 'shop.db', 'a'.repeat(31)]) {
      expect(() => assertDatabaseName(bad), bad).toThrow();
    }
  });

  it('ders the volume and container from the id only', () => {
    expect(databaseVolumeName(12)).toBe('capturehost-db-12');
    expect(databaseContainerName(12)).toBe('capturehost-db-12');
    expect(() => databaseVolumeName(0)).toThrow();
    expect(() => databaseContainerName(-1)).toThrow();
  });

  it('builds the pinned image reference', () => {
    expect(databaseImage('16-alpine')).toBe('postgres:16-alpine');
    expect(() => assertDatabaseVersion('16')).toThrow();
  });
});
