import type { AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import type { DeploymentService } from '../src/services/deployments.js';
import type { CaddyService } from '../src/services/caddy.js';
import { DockerService } from '../src/services/docker.js';
import { createFakeDocker, type FakeContainerSpec, type FakeDocker } from './dockerFake.js';
import { createTestDb, seedAdmin, silentLogger, testConfig, TEST_PASSWORD, TEST_USERNAME, type TestDb } from './helpers.js';

export interface AuthedApp {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: TestDb['db'];
  port: number;
  docker: FakeDocker;
  /** Cookie + CSRF pair for an authenticated browser-like client. */
  login: (password?: string) => Promise<{ cookie: string; csrfToken: string; response: LightMyRequestResponse }>;
  close: () => Promise<void>;
}

const DEFAULT_DOCKER_SPECS: FakeContainerSpec[] = [
  {
    id: 'a'.repeat(64),
    name: 'capturehost-socket-proxy',
    image: 'tecnativa/docker-socket-proxy:0.2.0',
    state: 'running',
    labels: { 'capturehost.protected': 'true' },
  },
  { id: 'b'.repeat(64), name: 'web', image: 'nginx:1.27', state: 'running', tty: true },
  { id: 'c'.repeat(64), name: 'db', image: 'postgres:16', state: 'exited' },
];

/**
 * Boots the real app on an ephemeral port with a seeded admin and a fake Docker
 * client, so the hook chain (auth guard, CSP, cookie parsing, CSRF) is the same
 * one production runs without needing a daemon in CI.
 */
export async function startApp(
  options: {
    seed?: boolean;
    dockerSpecs?: FakeContainerSpec[];
    /** Pipeline stub so route tests never shell out to git or docker. */
    deployments?: DeploymentService;
    /** Caddy stub so route tests never need a real controller. */
    caddy?: CaddyService;
  } = {},
): Promise<AuthedApp> {
  const testDb = createTestDb();
  const config = testConfig();
  const dockerFake = createFakeDocker(options.dockerSpecs ?? DEFAULT_DOCKER_SPECS);

  if (options.seed !== false) await seedAdmin(testDb.db);

  const app = await buildApp({
    config,
    db: testDb.db,
    logger: silentLogger,
    gpuProbe: async () => null,
    startSampler: true,
    dockerService: new DockerService({ config, logger: silentLogger, client: dockerFake.client }),
    ...(options.deployments ? { deploymentService: options.deployments } : {}),
    ...(options.caddy ? { caddyService: options.caddy } : {}),
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;

  return {
    app,
    db: testDb.db,
    port,
    docker: dockerFake,
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
