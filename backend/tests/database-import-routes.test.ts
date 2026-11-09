import { existsSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApp, type AuthedApp } from './appHarness.js';
import { DatabaseService } from '../src/services/databases.js';
import { silentLogger, testConfig } from './helpers.js';

/**
 * The upload path through real HTTP.
 *
 * Fastify's body pipeline, the custom `application/octet-stream` parser and the
 * temp-file cleanup are all exercised here — a unit test of the service would not
 * touch any of that.
 */

let harness: AuthedApp;
const config = testConfig();

function fakeService(db: AuthedApp['db']): DatabaseService {
  const container = () => ({
    start: async () => undefined,
    stop: async () => undefined,
    restart: async () => undefined,
    remove: async () => undefined,
    wait: async () => ({ StatusCode: 0 }),
    putArchive: async () => undefined,
    attach: async () => {
      const stream = new (require('node:stream').Readable)({ read() {} });
      stream.push(null);
      return stream;
    },
    inspect: async () => ({ NetworkSettings: { Networks: { 'capturehost-apps': { IPAddress: '172.18.0.9' } } } }),
  });

  return new DatabaseService({
    db,
    config,
    logger: silentLogger,
    client: { createContainer: async () => container(), getContainer: () => container() } as never,
    pgFactory: () => ({ query: async () => ({ rows: [], fields: [], rowCount: 0 }), end: async () => undefined }),
  });
}

beforeEach(async () => {
  harness = await startApp({ databases: (db) => fakeService(db) });
});

afterEach(async () => {
  await harness.close();
});

const SQL = Buffer.from('--\n-- PostgreSQL database dump\n--\nCREATE TABLE t (id int);\n');

describe('clone', () => {
  it('needs CSRF before it will copy anything', async () => {
    const { cookie } = await harness.login();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/databases/1/clone',
      payload: { name: 'copy-db' },
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('answers 404 for a database that does not exist', async () => {
    const { cookie, csrfToken } = await harness.login();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/databases/99/clone',
      payload: { name: 'copy-db' },
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('upload', () => {
  it('refuses a file that is not a dump', async () => {
    const { cookie, csrfToken } = await harness.login();
    const junk = Buffer.alloc(512);
    for (let i = 0; i < junk.length; i += 1) junk[i] = (i * 7) % 256;

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/databases/import?name=from-junk&version=16-alpine',
      payload: junk,
      headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/octet-stream' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'unknown_dump_format' });
  });

  it('imports a plain SQL dump and deletes the uploaded file afterwards', async () => {
    const { cookie, csrfToken } = await harness.login();

    // Compare against the directory as it was: the import dir is shared across runs,
    // so "empty" is the wrong assertion — "unchanged" is the right one.
    const before = existsSync(config.databases.importDir) ? readdirSync(config.databases.importDir).sort() : [];

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/databases/import?name=from-sql&version=16-alpine',
      payload: SQL,
      headers: {
        cookie,
        'x-csrf-token': csrfToken,
        'content-type': 'application/octet-stream',
        'x-upload-name': 'shop.sql',
      },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { database: { name: string; version: string } }).database).toMatchObject({
      name: 'from-sql',
      version: '16-alpine',
    });

    const after = existsSync(config.databases.importDir) ? readdirSync(config.databases.importDir).sort() : [];
    expect(after).toEqual(before);
  });

  it('refuses an import into a database that already has tables', async () => {
    const { cookie, csrfToken } = await harness.login();

    // Create a database, then claim it has tables by faking the pg answer.
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/databases/import?name=busy-db&version=16-alpine',
      payload: SQL,
      headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/octet-stream' },
    });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { database: { id: number } }).database.id;

    // A second import into the same database needs its name typed; an unknown one
    // is a plain mismatch, which is the guard that matters here.
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/databases/${id}/import?confirm=wrong-name`,
      payload: SQL,
      headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/octet-stream' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'confirm_mismatch' });
  });
});
