import { describe, expect, it } from 'vitest';
import { DatabaseService, detectDumpFormat } from '../src/services/databases.js';
import { createTestDb, silentLogger, testConfig } from './helpers.js';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Clone and import: the two paths that move data between databases.
 *
 * Docker is faked, so what is asserted is the contract — which entrypoint runs for
 * which format, that a failed import leaves no half-restored database behind, and
 * that an unknown binary never reaches a database.
 */

const CTX = { actor: 'admin', ip: '127.0.0.1' };
const CUSTOM_DUMP = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 1)]);
const SQL_DUMP = Buffer.from('--\n-- PostgreSQL database dump\n--\nCREATE TABLE t (id int);\n');

function fakeDocker() {
  const created: Record<string, unknown>[] = [];
  const removed: string[] = [];
  let failRestore = false;

  const container = (payload: Record<string, unknown>) => ({
    start: async () => undefined,
    stop: async () => undefined,
    restart: async () => undefined,
    remove: async () => {
      removed.push(String(payload.name));
    },
    wait: async () => ({
      StatusCode: failRestore && (payload.Entrypoint as string[] | undefined)?.[0] === 'pg_restore' ? 1 : 0,
    }),
    putArchive: async () => undefined,
    attach: async () => {
      // pg_dump writes frame-framed bytes to stdout.
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(CUSTOM_DUMP.length, 4);
      const stream = new (require('node:stream').Readable)({ read() {} });
      stream.push(Buffer.concat([header, CUSTOM_DUMP]));
      stream.push(null);
      return stream;
    },
    inspect: async () => ({
      NetworkSettings: { Networks: { 'capturehost-apps': { IPAddress: '172.18.0.9' } } },
    }),
  });

  return {
    client: {
      createContainer: async (payload: Record<string, unknown>) => {
        created.push(payload);
        return container(payload);
      },
      getContainer: () => container({ name: 'x' }),
    } as never,
    created,
    removed,
    setFailRestore: (value: boolean) => {
      failRestore = value;
    },
  };
}

function harness() {
  const testDb = createTestDb();
  const docker = fakeDocker();
  const dir = mkdtempSync(join(tmpdir(), 'db-import-'));

  const config = {
    ...testConfig(),
    databases: { ...testConfig().databases, dir, importDir: join(dir, 'imports') },
  };

  const service = new DatabaseService({
    db: testDb.db,
    config,
    logger: silentLogger,
    client: docker.client,
    pgFactory: () => ({ query: async () => ({ rows: [], fields: [], rowCount: 0 }), end: async () => undefined }),
  });

  return {
    service,
    db: testDb.db,
    docker,
    dir,
    cleanup: () => {
      testDb.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('detectDumpFormat', () => {
  it('recognises custom, tar and plain SQL', () => {
    expect(detectDumpFormat(CUSTOM_DUMP)).toBe('custom');
    const tar = Buffer.alloc(1024, 0);
    tar.write('ustar', 257, 'latin1');
    expect(detectDumpFormat(tar)).toBe('custom');
    expect(detectDumpFormat(SQL_DUMP)).toBe('sql');
  });

  it('refuses anything it cannot prove is a dump', () => {
    const binary = Buffer.alloc(512);
    for (let i = 0; i < binary.length; i += 1) binary[i] = i % 256;
    expect(() => detectDumpFormat(binary)).toThrow(/does not look like/i);
  });
});

describe('cloneDatabase', () => {
  it('dumps the source and restores it into a new database', async () => {
    const h = harness();
    try {
      const source = await h.service.create({ name: 'src-db', version: '16-alpine', published: false, ctx: CTX });

      const before = h.docker.created.length;
      const clone = await h.service.cloneDatabase(source.database.id, 'copy-db', CTX);

      expect(clone.database.name).toBe('copy-db');
      expect(clone.database.id).not.toBe(source.database.id);

      // One dump helper, the new container, one restore helper.
      const helpers = h.docker.created.slice(before) as Array<{ Entrypoint?: string[] }>;
      expect(helpers.map((entry) => entry.Entrypoint?.[0])).toEqual(['pg_dump', undefined, 'pg_restore']);

      const audit = JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all());
      expect(audit).toContain('database.clone');
    } finally {
      h.cleanup();
    }
  });

  it('refuses to clone a stopped database', async () => {
    const h = harness();
    try {
      const source = await h.service.create({ name: 'src-db', version: '16-alpine', published: false, ctx: CTX });
      await h.service.stop(source.database.id, CTX);
      await expect(h.service.cloneDatabase(source.database.id, 'copy-db', CTX)).rejects.toMatchObject({
        code: 'database_stopped',
      });
    } finally {
      h.cleanup();
    }
  });
});

describe('importDump', () => {
  it('replays plain SQL with psql and a custom archive with pg_restore', async () => {
    const h = harness();
    try {
      const sqlFile = join(h.dir, 'a.sql');
      writeFileSync(sqlFile, SQL_DUMP);
      const imported = await h.service.importDump({
        name: 'from-sql',
        version: '16-alpine',
        filePath: sqlFile,
        fileName: 'a.sql',
        format: 'sql',
        ctx: CTX,
      });
      expect(imported.database.name).toBe('from-sql');

      const restoreHelper = h.docker.created.at(-1) as { Entrypoint?: string[]; Cmd: string[] };
      expect(restoreHelper.Entrypoint).toEqual(['psql']);
      expect(restoreHelper.Cmd).toContain('-f');

      const customFile = join(h.dir, 'b.dump');
      writeFileSync(customFile, CUSTOM_DUMP);
      await h.service.importDump({
        name: 'from-dump',
        version: '16-alpine',
        filePath: customFile,
        fileName: 'b.dump',
        format: 'custom',
        ctx: CTX,
      });
      const customHelper = h.docker.created.at(-1) as { Entrypoint?: string[] };
      expect(customHelper.Entrypoint).toEqual(['pg_restore']);
    } finally {
      h.cleanup();
    }
  });

  it('removes the half-restored database when the replay fails', async () => {
    const h = harness();
    try {
      h.docker.setFailRestore(true);
      const file = join(h.dir, 'bad.dump');
      writeFileSync(file, CUSTOM_DUMP);

      await expect(
        h.service.importDump({
          name: 'broken',
          version: '16-alpine',
          filePath: file,
          fileName: 'bad.dump',
          format: 'custom',
          ctx: CTX,
        }),
      ).rejects.toThrow();

      // No row survived, so the operator is not left with an empty "broken" database.
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM databases').get()).toEqual({ n: 0 });
    } finally {
      h.cleanup();
    }
  });

  it('refuses an empty file', async () => {
    const h = harness();
    try {
      const file = join(h.dir, 'empty.sql');
      writeFileSync(file, '');
      await expect(
        h.service.importDump({
          name: 'nothing',
          version: '16-alpine',
          filePath: file,
          fileName: 'empty.sql',
          format: 'sql',
          ctx: CTX,
        }),
      ).rejects.toMatchObject({ code: 'import_empty' });
    } finally {
      h.cleanup();
    }
  });
});
