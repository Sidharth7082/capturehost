import { Duplex, Readable } from 'node:stream';
import { existsSync, readFileSync, rmSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatabaseService, demuxBuffer, type PgLike } from '../src/services/databases.js';
import { createProject } from '../src/db/projects.repo.js';
import { getDatabase, listLinksForDatabase } from '../src/db/databases.repo.js';
import { createTestDb, silentLogger, testConfig } from './helpers.js';

/**
 * The database service, with Docker and Postgres both faked.
 *
 * What is asserted here is the part that would hurt: the credential never leaves
 * the calls that need it, the volume is always the one derived from the id, and
 * every destructive path refuses unless the rules are met.
 */

const CTX = { actor: 'admin', ip: '127.0.0.1' };
const DUMP = Buffer.from('PGDMP-fake-archive-payload');

function frameStream(payload: Buffer): Readable {
  const header = Buffer.alloc(8);
  header[0] = 1; // stdout
  header.writeUInt32BE(payload.length, 4);
  const stream = new Readable({ read() {} });
  stream.push(Buffer.concat([header, payload]));
  stream.push(null);
  return stream;
}

function fakeDocker(options: { failCreate?: boolean } = {}) {
  const created: Record<string, unknown>[] = [];
  const removed: string[] = [];
  const stopped: string[] = [];

  const container = () => ({
    start: async () => undefined,
    stop: async () => {
      stopped.push('c');
    },
    restart: async () => undefined,
    remove: async () => {
      removed.push('c');
    },
    wait: async () => ({ StatusCode: 0 }),
    putArchive: async () => undefined,
    // `pg_dump` streams out; `pg_restore` takes the archive on stdin, so the fake
    // has to be writable in that case (a Duplex that ends immediately on read).
    attach: async (options?: { stdin?: boolean }) =>
      options?.stdin
        ? new Duplex({
            read() {
              this.push(null);
            },
            write(_chunk, _encoding, callback) {
              callback();
            },
          })
        : frameStream(DUMP),
    inspect: async () => ({
      NetworkSettings: { Networks: { 'capturehost-apps': { IPAddress: '172.18.0.5' } } },
    }),
  });

  const client = {
    createContainer: async (payload: Record<string, unknown>) => {
      if (options.failCreate) throw new Error('docker said no');
      created.push(payload);
      return container();
    },
    getContainer: () => container(),
  };

  return { client: client as never, created, removed, stopped };
}

function fakePg(responses: Array<{ match: RegExp; rows: Array<Record<string, unknown>>; fields?: string[] }>) {
  const calls: string[] = [];
  const factory = () => ({
    query: async (input: { text: string } | string) => {
      const text = typeof input === 'string' ? input : input.text;
      calls.push(text);
      const hit = responses.find((entry) => entry.match.test(text));
      const rows = hit?.rows ?? [];
      return {
        rows,
        fields: (hit?.fields ?? Object.keys(rows[0] ?? {})).map((name) => ({ name })),
        rowCount: rows.length,
      };
    },
    end: async () => undefined,
  }) as PgLike;
  return { factory: () => factory, calls };
}

function harness(options: { failCreate?: boolean } = {}) {
  const testDb = createTestDb();
  const docker = fakeDocker(options);
  const pg = fakePg([
    { match: /pg_database_size/, rows: [{ size: '16384' }] },
    { match: /pg_stat_activity/, rows: [{ count: 2 }] },
    { match: /SHOW server_version/, rows: [{ server_version: '17.2' }] },
    { match: /information_schema\.tables/, rows: [{ table_schema: 'public', table_name: 'orders' }] },
    {
      match: /information_schema\.columns/,
      rows: [{ table_schema: 'public', table_name: 'orders', column_name: 'id', data_type: 'integer', is_nullable: 'NO' }],
    },
    { match: /^SELECT \* FROM/, rows: [{ id: 1 }], fields: ['id'] },
  ]);

  const dir = mkdtempSync(join(tmpdir(), 'db-backups-'));
  const config = { ...testConfig(), databases: { ...testConfig().databases, dir } };

  const service = new DatabaseService({
    db: testDb.db,
    config,
    logger: silentLogger,
    client: docker.client,
    pgFactory: pg.factory(),
  });

  return { service, db: testDb.db, docker, dir, pg, cleanup: () => {
    testDb.cleanup();
    rmSync(dir, { recursive: true, force: true });
  } };
}

describe('create', () => {
  it('derives the volume from the id, starts the container and returns the password once', async () => {
    const h = harness();
    try {
      const created = await h.service.create({ name: 'shop-db', version: '17-alpine', published: false, ctx: CTX });

      expect(created.database.name).toBe('shop-db');
      expect(created.database.containerName).toBe(`capturehost-db-${created.database.id}`);
      expect(created.database.volume).toBe(`capturehost-db-${created.database.id}`);
      expect(created.password).toHaveLength(32);

      const payload = h.docker.created[0] as { HostConfig: { Binds: string[] }; Labels: Record<string, string> };
      expect(payload.HostConfig.Binds).toEqual([
        `capturehost-db-${created.database.id}:/var/lib/postgresql/data`,
      ]);
      expect(payload.Labels['capturehost.database']).toBe(String(created.database.id));

      // The DTO never carries the password.
      expect(JSON.stringify(created.database)).not.toContain(created.password);

      // Neither does SQLite, in plain.
      const row = getDatabase(h.db, created.database.id)!;
      expect(row.password_encrypted).not.toContain(created.password);

      // Nor the audit trail.
      const audit = JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all());
      expect(audit).toContain('database.create');
      expect(audit).not.toContain(created.password);
    } finally {
      h.cleanup();
    }
  });

  it('publishes on loopback only when asked', async () => {
    const h = harness();
    try {
      const created = await h.service.create({ name: 'local-db', version: '16-alpine', published: true, ctx: CTX });
      const payload = h.docker.created[0] as { HostConfig: { PortBindings: Record<string, unknown> } };
      const bindings = payload.HostConfig.PortBindings['5432/tcp'] as Array<Record<string, string>>;

      expect(bindings[0]).toEqual({ HostIp: '127.0.0.1', HostPort: String(created.database.port) });
      expect(created.database.published).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('marks the row failed when Docker refuses, without leaking the password', async () => {
    const h = harness({ failCreate: true });
    try {
      await expect(
        h.service.create({ name: 'nope-db', version: '17-alpine', published: false, ctx: CTX }),
      ).rejects.toMatchObject({ code: 'database_create_failed' });

      const row = h.db.prepare('SELECT status, last_error, password_encrypted FROM databases').get() as {
        status: string;
        last_error: string;
        password_encrypted: string;
      };
      expect(row.status).toBe('failed');
      expect(row.last_error).toContain('docker said no');
      expect(row.last_error).not.toContain('postgres://');
    } finally {
      h.cleanup();
    }
  });

  it('refuses a duplicate name', async () => {
    const h = harness();
    try {
      await h.service.create({ name: 'shop-db', version: '17-alpine', published: false, ctx: CTX });
      await expect(
        h.service.create({ name: 'shop-db', version: '17-alpine', published: false, ctx: CTX }),
      ).rejects.toMatchObject({ code: 'database_name_taken' });
    } finally {
      h.cleanup();
    }
  });
});

describe('lifecycle', () => {
  it('stops, starts and restarts with the row in step', async () => {
    const h = harness();
    try {
      const { database } = await h.service.create({ name: 'shop-db', version: '17-alpine', published: false, ctx: CTX });

      expect((await h.service.stop(database.id, CTX)).status).toBe('stopped');
      expect((await h.service.start(database.id, CTX)).status).toBe('running');
      expect((await h.service.restart(database.id, CTX)).status).toBe('running');
      expect(h.docker.stopped.length).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });

  it('refuses to delete a running database, a linked one, or on a wrong confirmation', async () => {
    const h = harness();
    try {
      const { database } = await h.service.create({ name: 'shop-db', version: '17-alpine', published: false, ctx: CTX });

      await expect(h.service.remove(database.id, 'shop-db', CTX)).rejects.toMatchObject({ code: 'database_running' });

      await h.service.stop(database.id, CTX);
      await expect(h.service.remove(database.id, 'not-the-name', CTX)).rejects.toMatchObject({ code: 'confirm_mismatch' });

      const projectId = createProject(h.db, {
        name: 'shop', slug: 'shop', repoUrl: 'https://github.com/o/r', branch: 'main',
        dockerfilePath: 'Dockerfile', containerPort: 80, healthPath: null, cpuLimit: 0.5,
        memoryLimitMb: 512, pidsLimit: 256, webhookSecretEncrypted: null, githubTokenEncrypted: null,
        now: Date.now(),
      });
      h.service.link(projectId, database.id, 'DATABASE_URL', CTX);

      await expect(h.service.remove(database.id, 'shop-db', CTX)).rejects.toMatchObject({ code: 'database_linked' });

      h.service.unlink(projectId, database.id, CTX);
      const removed = await h.service.remove(database.id, 'shop-db', CTX);

      expect(removed.removed).toBe(true);
      expect(removed.orphanedVolume).toBe(`capturehost-db-${database.id}`);
      expect(removed.removeCommand).toBe(`docker volume rm capturehost-db-${database.id}`);
      expect(getDatabase(h.db, database.id)).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe('links', () => {
  it('writes an encrypted DATABASE_URL and says a redeploy is needed', async () => {
    const h = harness();
    try {
      const { database } = await h.service.create({ name: 'shop-db', version: '17-alpine', published: false, ctx: CTX });
      const projectId = createProject(h.db, {
        name: 'shop', slug: 'shop', repoUrl: 'https://github.com/o/r', branch: 'main',
        dockerfilePath: 'Dockerfile', containerPort: 80, healthPath: null, cpuLimit: 0.5,
        memoryLimitMb: 512, pidsLimit: 256, webhookSecretEncrypted: null, githubTokenEncrypted: null,
        now: Date.now(),
      });

      const result = h.service.link(projectId, database.id, 'DATABASE_URL', CTX);
      expect(result).toEqual({ ok: true, redeployRequired: true, envKey: 'DATABASE_URL' });

      const env = h.db
        .prepare('SELECT key, value_encrypted FROM env_vars WHERE project_id = ?')
        .get(projectId) as { key: string; value_encrypted: string };
      expect(env.key).toBe('DATABASE_URL');
      // The stored value is ciphertext, and the audit log holds no URL at all.
      expect(env.value_encrypted).not.toContain('postgres://');
      const audit = JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all());
      expect(audit).toContain('database.link');
      expect(audit).not.toContain('postgres://');
      expect(listLinksForDatabase(h.db, database.id)).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('removes the env var on unlink, but leaves a value the operator replaced', async () => {
    const h = harness();
    try {
      const { database } = await h.service.create({ name: 'shop-db', version: '17-alpine', published: false, ctx: CTX });
      const projectId = createProject(h.db, {
        name: 'shop', slug: 'shop', repoUrl: 'https://github.com/o/r', branch: 'main',
        dockerfilePath: 'Dockerfile', containerPort: 80, healthPath: null, cpuLimit: 0.5,
        memoryLimitMb: 512, pidsLimit: 256, webhookSecretEncrypted: null, githubTokenEncrypted: null,
        now: Date.now(),
      });

      h.service.link(projectId, database.id, 'DATABASE_URL', CTX);
      h.service.unlink(projectId, database.id, CTX);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM env_vars').get()).toEqual({ n: 0 });

      // Link again, then replace the value by hand: unlink must not delete it.
      h.service.link(projectId, database.id, 'DATABASE_URL', CTX);
      h.db.prepare('UPDATE env_vars SET value_encrypted = ? WHERE project_id = ?').run('not-ours', projectId);

      h.service.unlink(projectId, database.id, CTX);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM env_vars').get()).toEqual({ n: 1 });
    } finally {
      h.cleanup();
    }
  });
});

describe('introspection', () => {
  it('reads size, connections and version through pg', async () => {
    const h = harness();
    try {
      const { database } = await h.service.create({ name: 'shop-db', version: '17-alpine', published: false, ctx: CTX });
      const metrics = await h.service.metrics(database.id);

      expect(metrics).toEqual({ sizeBytes: 16384, connections: 2, version: '17.2' });
    } finally {
      h.cleanup();
    }
  });

  it('lists tables with columns, and pages rows only for a known table', async () => {
    const h = harness();
    try {
      const { database } = await h.service.create({ name: 'shop-db', version: '17-alpine', published: false, ctx: CTX });

      const tables = await h.service.tables(database.id);
      expect(tables).toEqual([
        {
          schema: 'public',
          name: 'orders',
          rows: null,
          columns: [{ name: 'id', type: 'integer', nullable: false }],
        },
      ]);

      const page = await h.service.rows(database.id, 'public', 'orders', 1);
      expect(page.columns).toEqual(['id']);
      expect(page.rows).toEqual([{ id: 1 }]);

      await expect(h.service.rows(database.id, 'public', 'missing', 1)).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      h.cleanup();
    }
  });

  it('audits a typed statement but never its results', async () => {
    const h = harness();
    try {
      const { database } = await h.service.create({ name: 'shop-db', version: '17-alpine', published: false, ctx: CTX });
      await h.service.query(database.id, 'SELECT 1', CTX);

      const audit = h.db.prepare("SELECT detail FROM audit_log WHERE action = 'database.query'").get() as {
        detail: string;
      };
      expect(audit.detail).toBe('SELECT 1');
      expect(JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all())).not.toContain('{ id: 1 }');
    } finally {
      h.cleanup();
    }
  });
});

describe('backups', () => {
  it('dumps through a helper container, encrypts the archive and records it', async () => {
    const h = harness();
    try {
      const { database } = await h.service.create({ name: 'shop-db', version: '17-alpine', published: false, ctx: CTX });
      const backup = await h.service.createBackup(database.id, CTX);

      const helper = h.docker.created[1] as {
        Cmd: string[];
        Env: string[];
        HostConfig: { Binds: unknown[]; Privileged: boolean };
      };
      expect(helper.Entrypoint).toEqual(['pg_dump']);
      expect(helper.Cmd).toEqual(['-Fc', '-h', 'capturehost-db-1', '-p', '5432', '-U', 'capturehost', '-d', 'shop_db']);
      expect(helper.HostConfig.Binds).toEqual([]);
      expect(helper.HostConfig.Privileged).toBe(false);
      // The password travels in env only, never in the command line.
      expect(helper.Cmd.join(' ')).not.toContain('PGPASSWORD');
      expect(helper.Env.some((entry) => entry.startsWith('PGPASSWORD='))).toBe(true);

      const files = readdirSync(join(h.dir, String(database.id)));
      expect(files).toEqual([backup.fileName]);

      const onDisk = readFileSync(join(h.dir, String(database.id), backup.fileName), 'utf8');
      expect(onDisk).not.toContain('PGDMP-fake-archive-payload'); // encrypted at rest
      expect(h.service.get(database.id).lastBackupAt).not.toBeNull();

      const audit = JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all());
      expect(audit).toContain('database.backup');
      expect(audit).not.toContain(DUMP.toString('utf8'));
    } finally {
      h.cleanup();
    }
  });

  it('refuses to back up a stopped database', async () => {
    const h = harness();
    try {
      const { database } = await h.service.create({ name: 'shop-db', version: '17-alpine', published: false, ctx: CTX });
      await h.service.stop(database.id, CTX);
      await expect(h.service.createBackup(database.id, CTX)).rejects.toMatchObject({ code: 'database_stopped' });
    } finally {
      h.cleanup();
    }
  });

  it('restores into a NEW database and never the source', async () => {
    const h = harness();
    try {
      const { database } = await h.service.create({ name: 'shop-db', version: '17-alpine', published: false, ctx: CTX });
      const backup = await h.service.createBackup(database.id, CTX);

      const restored = await h.service.restoreBackup(database.id, backup.fileName, 'shop-restored', CTX);
      expect(restored.database.name).toBe('shop-restored');
      expect(restored.database.id).not.toBe(database.id);
      expect(restored.password).toHaveLength(32);

      // The source row is untouched and still holds its own snapshot list.
      expect(h.service.listBackups(database.id)).toHaveLength(1);
      expect(h.service.listBackups(restored.database.id)).toHaveLength(0);
      expect(existsSync(join(h.dir, String(database.id), backup.fileName))).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe('demuxBuffer', () => {
  it('unwraps docker framing and passes raw bytes through', () => {
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(5, 4);
    expect(demuxBuffer(Buffer.concat([header, Buffer.from('hello')]))).toBe('hello');
    expect(demuxBuffer(Buffer.from('plain text'))).toBe('plain text');
  });
});
