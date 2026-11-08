import type { AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { createTestDb, seedAdmin, silentLogger, testConfig, TEST_PASSWORD, TEST_USERNAME, type TestDb } from './helpers.js';

export interface AuthedApp {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: TestDb['db'];
  port: number;
  /** Cookie + CSRF pair for an authenticated browser-like client. */
  login: (password?: string) => Promise<{ cookie: string; csrfToken: string; response: LightMyRequestResponse }>;
  close: () => Promise<void>;
}

/**
 * Boots the real app on an ephemeral port with a seeded admin.
 *
 * The suite shares one instance per test file, so the tests exercise the same
 * hook chain (auth guard, CSP, cookie parsing) that production runs.
 */
export async function startApp(options: { seed?: boolean } = {}): Promise<AuthedApp> {
  const testDb = createTestDb();
  const config = testConfig();

  if (options.seed !== false) await seedAdmin(testDb.db);

  const app = await buildApp({
    config,
    db: testDb.db,
    logger: silentLogger,
    gpuProbe: async () => null,
    startSampler: true,
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;

  return {
    app,
    db: testDb.db,
    port,
    login: async (password = TEST_PASSWORD) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: TEST_USERNAME, password },
      });

      const cookie = response.cookies.find((entry) => entry.name.includes('capturehost_sid'));
      if (!cookie) throw new Error('login did not set a session cookie');

      const body = response.json() as { csrfToken: string };
      return { cookie: `${cookie.name}=${cookie.value}`, csrfToken: body.csrfToken, response };
    },
    close: async () => {
      await app.close();
      testDb.cleanup();
    },
  };
}
