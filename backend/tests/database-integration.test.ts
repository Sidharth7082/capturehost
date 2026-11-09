import { existsSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseService, detectDumpFormat } from '../src/services/databases.js';
import { decryptString } from '../src/crypto/secretbox.js';
import { createTestDb, silentLogger, testConfig } from './helpers.js';

/**
 * Real Postgres, real pg_dump, real pg_restore.
 *
 * Opt-in (`DATABASE_INTEGRATION=1`) because it pulls a ~90 MB image, starts two
 * containers and takes about a minute. Everything it creates is labelled
 * `capturehost.test=true` and removed at the end, including the volumes — through
 * the host CLI, because the app's socket proxy deliberately cannot delete volumes.
 *
 * Run it with:
 *   DATABASE_INTEGRATION=1 npx vitest run tests/database-integration.test.ts
 */

const enabled = process.env.DATABASE_INTEGRATION === '1';
const suffix = process.env.DATABASE_INTEGRATION_SUFFIX ?? '';
const createdNames: string[] = [];
const createdVolumes: string[] = [];
let dir = '';
let db_rows: () => Array<{ container_name: string; volume: string }> = () => [];

function dockerClient(): Docker {
  return new Docker({ host: '127.0.0.1', port: 2375 });
}

describe.skipIf(!enabled)('database round trip against real Postgres', () => {
  const testDb = createTestDb();
  db_rows = () =>
    testDb.db.prepare('SELECT container_name, volume FROM databases').all() as Array<{
      container_name: string;
      volume: string;
    }>;
  dir = mkdtempSync(join(tmpdir(), 'db-int-'));
  const config = { ...testConfig(), databases: { ...testConfig().databases, dir } };

  const service = new DatabaseService({
    db: testDb.db,
    config,
    logger: silentLogger,
    client: dockerClient(),
    extraLabels: { 'capturehost.test': 'true' },
  });

  afterAll(() => {
    // Read the rows BEFORE closing the in-memory database.
    const rows = db_rows();
    testDb.cleanup();
    rmSync(dir, { recursive: true, force: true });

    // The app cannot delete volumes (VOLUMES=0 by design); the test cleans up
    // out-of-band so repeated runs do not accumulate 100 MB of postgres data.
    // The test database is the inventory: a restore that fails halfway still
    // created container 2, and its name has to go too.
    for (const row of rows) {
      try {
        execFileSync('docker', ['rm', '-f', row.container_name], { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
      try {
        execFileSync('docker', ['volume', 'rm', row.volume], { stdio: 'ignore' });
      } catch {
        /* in use or gone */
      }
    }
    for (const name of createdNames) {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    }
    for (const volume of createdVolumes) {
      try {
        execFileSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
      } catch {
        /* in use or gone */
      }
    }
  });

  it('creates, writes, dumps, restores into a new database and reads the data back', async () => {
    const base = `chtest-${suffix || Date.now().toString(36)}`.slice(0, 28);

    const created = await service.create({
      name: base,
      version: '16-alpine',
      published: false,
      ctx: { actor: 'integration-test' },
    });
    createdNames.push(created.database.containerName);
    createdVolumes.push(created.database.volume);

    // The container is labelled for the generic container list to refuse it.
    const inspect = (await dockerClient().getContainer(created.database.containerName).inspect()) as {
      Config: { Labels: Record<string, string> };
    };
    expect(inspect.Config.Labels['capturehost.database']).toBe(String(created.database.id));

    // Wait for accept-connections, then write something worth restoring.
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      try {
        await service.query(created.database.id, 'select 1', { actor: 'integration-test' });
        ready = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    expect(ready, 'postgres did not become reachable in 60 s').toBe(true);

    await service.query(
      created.database.id,
      'create table items (id serial primary key, name text not null)',
      { actor: 'integration-test' },
    );
    await service.query(created.database.id, "insert into items (name) values ('hello'), ('world')", {
      actor: 'integration-test',
    });

    const tables = await service.tables(created.database.id);
    expect(tables.map((table) => table.name)).toContain('items');

    // ---- dump ----
    const backup = await service.createBackup(created.database.id, { actor: 'integration-test' });
    const path = join(dir, String(created.database.id), backup.fileName);
    expect(existsSync(path)).toBe(true);
    const onDisk = readFileSync(path);
    expect(onDisk.length).toBeGreaterThan(0);
    // Encrypted at rest: the PGDMP magic of an unencrypted pg_dump must not appear.
    expect(onDisk.subarray(0, 5).toString('utf8')).not.toBe('PGDMP');

    // ---- restore into a NEW database ----
    const restoredName = `${base}-r`.slice(0, 30);
    const restored = await service.restoreBackup(created.database.id, backup.fileName, restoredName, {
      actor: 'integration-test',
    });
    createdNames.push(restored.database.containerName);
    createdVolumes.push(restored.database.volume);

    let rows: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const result = await service.query(restored.database.id, 'select name from items order by id', {
          actor: 'integration-test',
        });
        rows = result.rows;
        if (rows.length === 2) break;
      } catch {
        /* still starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    expect(rows.map((row) => row.name)).toEqual(['hello', 'world']);

    // The source database is untouched by the restore.
    const source = await service.query(created.database.id, 'select count(*)::int as n from items', {
      actor: 'integration-test',
    });
    expect(source.rows[0]).toEqual({ n: 2 });
  }, 240_000);

  it('clones a running database, and imports a decrypted snapshot into a new one', async () => {
    const base = `chimp-${suffix || Date.now().toString(36)}`.slice(0, 28);

    const source = await service.create({ name: base, version: '16-alpine', published: false, ctx: { actor: 'it' } });
    createdNames.push(source.database.containerName);
    createdVolumes.push(source.database.volume);

    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      try {
        await service.query(source.database.id, 'select 1', { actor: 'it' });
        ready = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    expect(ready).toBe(true);
    await service.query(source.database.id, 'create table notes (id serial primary key, body text)', { actor: 'it' });
    await service.query(source.database.id, "insert into notes (body) values ('from-source')", { actor: 'it' });

    // ---- clone ----
    const clone = await service.cloneDatabase(source.database.id, `${base}-c`.slice(0, 30), { actor: 'it' });
    createdNames.push(clone.database.containerName);
    createdVolumes.push(clone.database.volume);

    const cloneRows = await service.query(clone.database.id, 'select body from notes', { actor: 'it' });
    expect(cloneRows.rows).toEqual([{ body: 'from-source' }]);

    // ---- import from a real dump file, decrypted the way an operator would ----
    const backup = await service.createBackup(source.database.id, { actor: 'it' });
    const encrypted = readFileSync(join(dir, String(source.database.id), backup.fileName), 'utf8');
    const plain = Buffer.from(decryptString(encrypted, config.encryptionKey, 'database.backup'), 'base64');
    expect(detectDumpFormat(plain)).toBe('custom');

    const dumpPath = join(dir, 'uploaded.dump');
    writeFileSync(dumpPath, plain);

    const imported = await service.importDump({
      name: `${base}-i`.slice(0, 30),
      version: '16-alpine',
      filePath: dumpPath,
      fileName: 'uploaded.dump',
      format: 'custom',
      ctx: { actor: 'it' },
    });
    createdNames.push(imported.database.containerName);
    createdVolumes.push(imported.database.volume);

    let importedRows: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        importedRows = (await service.query(imported.database.id, 'select body from notes', { actor: 'it' })).rows;
        if (importedRows.length > 0) break;
      } catch {
        /* still starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    expect(importedRows).toEqual([{ body: 'from-source' }]);
  }, 300_000);
});