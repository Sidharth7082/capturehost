import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pipeline state machine with git and Docker mocked.
 *
 * The point is not to test Docker; it is to prove the order of operations and,
 * above all, that a failed health check leaves the previously running container
 * untouched. A wrong "fix" here would take the live site down on every bad
 * build.
 */

const { cloneRepository, assertDockerfilePresent, removeWorkingTree } = vi.hoisted(() => ({
  cloneRepository: vi.fn(),
  assertDockerfilePresent: vi.fn(),
  removeWorkingTree: vi.fn(),
}));

vi.mock('../src/services/git.js', () => ({
  cloneRepository,
  assertDockerfilePresent,
  removeWorkingTree,
}));

// `tar` is shelled out to by the pipeline; the mock returns a tiny fake archive.
vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, result?: { stdout: Buffer; stderr: string }) => void,
  ) => callback(null, { stdout: Buffer.from('fake-tar'), stderr: '' }),
}));

const { DeploymentService } = await import('../src/services/deployments.js');
const { createTestDb } = await import('./helpers.js');
const { createProject, getDeployment, getProject, setProjectRuntime } = await import(
  '../src/db/projects.repo.js'
);

interface FakeDockerState {
  created: Array<Record<string, unknown>>;
  started: string[];
  removed: string[];
  stopped: string[];
  builds: string[];
  healthReported: boolean;
}

function createFakeDocker(state: FakeDockerState, options: { healthy?: boolean; runOnStart?: boolean } = {}) {
  const healthy = options.healthy ?? true;
  const runOnStart = options.runOnStart ?? true;

  return {
    buildImage: async (_stream: unknown, buildOptions: { t: string }) => {
      state.builds.push(buildOptions.t);
      const stream = new Readable({ read() {} });
      stream.push(Buffer.from(`${JSON.stringify({ stream: 'Step 1/1 : FROM nginx:alpine\n' })}\r\n`));
      stream.push(Buffer.from(`${JSON.stringify({ stream: 'Successfully built abc1234\n' })}\r\n`));
      stream.push(null);
      return stream;
    },
    createContainer: async (createOptions: Record<string, unknown>) => {
      state.created.push(createOptions);
      return {
        id: 'new-container-id',
        start: async () => {
          state.started.push(String(createOptions.name));
        },
      };
    },
    getContainer: (ref: string) => ({
      inspect: async () => {
        if (String(ref) === 'old-container-id' || runOnStart) {
          state.healthReported = true;
          return { State: { Running: true, ExitCode: 0 } };
        }
        return { State: { Running: false, ExitCode: 1 } };
      },
      remove: async () => {
        state.removed.push(String(ref));
      },
      stop: async () => {
        state.stopped.push(String(ref));
      },
    }),
    getImage: () => ({
      inspect: async () => ({}),
      remove: async () => ({}),
    }),
    listImages: async () => [],
    // Health checks that ask for HTTP fail because nothing listens on the port.
    __healthy: healthy,
  };
}

function makeService(state: FakeDockerState, overrides: { healthy?: boolean } = {}) {
  const testDb = createTestDb();
  const config = {
    ...testConfigBase(),
    deploy: {
      ...testConfigBase().deploy,
      // Long enough for the two-sample "stays up" check to complete.
      healthCheckTimeoutMs: 4000,
    },
  };

  const service = new DeploymentService({
    db: testDb.db,
    config,
    logger: silentLoggerBase(),
    client: createFakeDocker(state, overrides) as never,
  });

  return { service, db: testDb.db, cleanup: testDb.cleanup };
}

// Kept separate so the module-level vi.mock hoisting cannot interfere.
function testConfigBase() {
  return {
    nodeEnv: 'test' as const,
    logLevel: 'silent' as const,
    host: '127.0.0.1',
    port: 0,
    dbPath: ':memory:',
    allowedOrigins: [],
    metricsIntervalMs: 2000,
    metricsRetentionHours: 24,
    isProduction: false,
    encryptionKey: Buffer.alloc(32, 3),
    session: {
      idleMs: 1_800_000,
      absoluteMs: 43_200_000,
      pendingMs: 300_000,
      cookieName: 'capturehost_sid',
      secure: false,
    },
    argon2: { memoryCost: 8192, timeCost: 2, parallelism: 1 },
    login: { maxFailures: 3, windowMs: 600_000, lockoutMs: 300_000 },
    trustProxy: false,
    docker: {
      hostUrl: 'http://127.0.0.1:2375',
      timeoutMs: 2000,
      statsIntervalMs: 2500,
      protectedContainers: [],
      actionsPerMinute: 30,
    },
    deploy: {
      dataDir: '/tmp/capturehost-pipeline-test',
      buildTimeoutMs: 30_000,
      keepImages: 3,
      maxLogBytes: 65_536,
      maxCloneBytes: 10 * 1024 * 1024,
      actionsPerMinute: 10,
      gitTimeoutMs: 20_000,
      memoryDefaultMb: 512,
      memoryMaxMb: 4096,
      cpuDefault: 0.5,
      cpuMax: 4,
      pidsLimit: 256,
      portRangeStart: 18_080,
      portRangeEnd: 18_099,
      network: 'capturehost-apps',
      healthCheckTimeoutMs: 30_000,
    },
    webhook: { maxBodyBytes: 1_048_576 },
  };
}

function silentLoggerBase() {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop, debug: noop, child: () => silentLoggerBase() } as never;
}

async function waitForTerminal(
  db: ReturnType<typeof createTestDb>['db'],
  deploymentId: number,
): Promise<string> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const deployment = getDeployment(db, deploymentId);
    if (deployment && ['live', 'failed', 'cancelled', 'rolled-back'].includes(deployment.status)) {
      return deployment.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('deployment did not reach a terminal state');
}

/** Waits for a terminal state and, on mismatch, prints the stored error. */
async function expectStatus(
  db: ReturnType<typeof createTestDb>['db'],
  deploymentId: number,
  expected: string,
): Promise<string> {
  const status = await waitForTerminal(db, deploymentId);
  const deployment = getDeployment(db, deploymentId);
  expect(status, `deployment #${deploymentId} error: ${deployment?.error ?? '(none)'}`).toBe(expected);
  return status;
}

function seedProject(db: ReturnType<typeof createTestDb>['db']) {
  return createProject(db, {
    name: 'pipeline-demo',
    slug: 'pipeline-demo',
    repoUrl: 'https://github.com/owner/repo',
    branch: 'main',
    dockerfilePath: 'Dockerfile',
    containerPort: 80,
    healthPath: null,
    cpuLimit: 0.5,
    memoryLimitMb: 512,
    pidsLimit: 256,
    webhookSecretEncrypted: null,
    githubTokenEncrypted: null,
    now: Date.now(),
  });
}

let state: FakeDockerState;

beforeEach(() => {
  state = { created: [], started: [], removed: [], stopped: [], builds: [], healthReported: false };
  cloneRepository.mockReset();
  assertDockerfilePresent.mockReset();
  removeWorkingTree.mockReset();

  cloneRepository.mockResolvedValue({
    commitSha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    sizeBytes: 2048,
    path: '/tmp/capturehost-pipeline-test/1/dep-1',
  });
  assertDockerfilePresent.mockReturnValue('/tmp/capturehost-pipeline-test/1/dep-1/Dockerfile');
});

describe('DeploymentService', () => {
  it('clones, builds, starts and marks the deployment live', async () => {
    const { service, db, cleanup } = makeService(state);
    try {
      const projectId = seedProject(db);
      const project = getProject(db, projectId)!;
      const deploymentId = service.enqueueDeploy(project, 'manual');

      await expectStatus(db, deploymentId, 'live');

      const deployment = getDeployment(db, deploymentId)!;
      expect(deployment.commit_sha).toBe('a'.repeat(40));
      expect(deployment.image_tag).toBe('capturehost/pipeline-demo:aaaaaaa');
      expect(deployment.log).toContain('Cloned commit aaaaaaa');
      expect(deployment.log).toContain('Live on http://127.0.0.1:18080');

      expect(state.builds).toEqual(['capturehost/pipeline-demo:aaaaaaa']);
      expect(state.started).toEqual(['capturehost-pipeline-demo-' + deploymentId]);

      const updated = getProject(db, projectId)!;
      expect(updated.status).toBe('running');
      expect(updated.host_port).toBe(18_080);
      expect(updated.current_deployment_id).toBe(deploymentId);
    } finally {
      cleanup();
    }
  });

  it('applies the safety policy to the container it creates', async () => {
    const { service, db, cleanup } = makeService(state);
    try {
      const projectId = seedProject(db);
      const deploymentId = service.enqueueDeploy(getProject(db, projectId)!, 'manual');
      await waitForTerminal(db, deploymentId);

      const created = state.created[0] as {
        HostConfig: Record<string, unknown>;
        Labels: Record<string, string>;
      };

      expect(created.HostConfig.Privileged).toBe(false);
      expect(created.HostConfig.CapDrop).toEqual(['ALL']);
      expect(created.HostConfig.Binds).toEqual([]);
      expect(created.HostConfig.NetworkMode).toBe('capturehost-apps');
      expect(created.Labels['capturehost.managed']).toBe('true');
      expect(created.HostConfig.PortBindings).toEqual({
        '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }],
      });
    } finally {
      cleanup();
    }
  });

  it('keeps the old container running when the new one fails its health check', async () => {
    const { service, db, cleanup } = makeService(state, { healthy: false });
    try {
      const projectId = seedProject(db);

      // Pretend this project already has a live container from a past deploy.
      db.prepare(
        "UPDATE projects SET health_path = '/__capturehost_unreachable_probe__', container_id = 'old-container-id', status = 'running' WHERE id = ?",
      ).run(
        projectId,
      );

      const deploymentId = service.enqueueDeploy(getProject(db, projectId)!, 'manual');
      await expectStatus(db, deploymentId, 'failed');

      const deployment = getDeployment(db, deploymentId)!;
      expect(deployment.error).toMatch(/Health check did not pass/);

      // The old container must never be stopped or removed on a failure.
      expect(state.stopped).not.toContain('old-container-id');
      expect(state.removed).not.toContain('old-container-id');

      const project = getProject(db, projectId)!;
      expect(project.container_id).toBe('old-container-id');
      expect(project.status).toBe('failed');
    } finally {
      cleanup();
    }
  }, 20_000);

  it('swaps out the old container only after the new one is healthy', async () => {
    const { service, db, cleanup } = makeService(state);
    try {
      const projectId = seedProject(db);
      db.prepare("UPDATE projects SET container_id = 'old-container-id' WHERE id = ?").run(projectId);

      const deploymentId = service.enqueueDeploy(getProject(db, projectId)!, 'manual');
      await expectStatus(db, deploymentId, 'live');

      expect(state.stopped).toContain('old-container-id');
      expect(state.removed).toContain('old-container-id');
      expect(getProject(db, projectId)!.container_id).toBe('new-container-id');
    } finally {
      cleanup();
    }
  });

  it('never writes environment values into the deployment log', async () => {
    const { service, db, cleanup } = makeService(state);
    try {
      const projectId = seedProject(db);

      db.prepare(
        `INSERT INTO env_vars (project_id, key, value_encrypted, created_at) VALUES (?, 'DATABASE_URL', ?, ?)`,
      ).run(
        projectId,
        (await import('../src/crypto/secretbox.js')).encryptString(
          'postgres://user:supersecret@db/app',
          Buffer.alloc(32, 3),
          'project.env.DATABASE_URL',
        ),
        Date.now(),
      );

      const deploymentId = service.enqueueDeploy(getProject(db, projectId)!, 'manual');
      await waitForTerminal(db, deploymentId);

      const deployment = getDeployment(db, deploymentId)!;
      expect(deployment.log).not.toContain('supersecret');
      expect(deployment.log).not.toContain('postgres://');

      // The value did reach the container, though.
      const created = state.created[0] as { Env: string[] };
      expect(created.Env).toContain('DATABASE_URL=postgres://user:supersecret@db/app');
    } finally {
      cleanup();
    }
  });

  it('rolls back to a previous image without cloning or building', async () => {
    const { service, db, cleanup } = makeService(state);
    try {
      const projectId = seedProject(db);
      db.prepare("UPDATE projects SET container_id = 'old-container-id' WHERE id = ?").run(projectId);

      const target = {
        id: 99,
        project_id: projectId,
        commit_sha: 'b'.repeat(40),
        image_tag: 'capturehost/pipeline-demo:bbbbbbb',
        status: 'live',
        log: '',
        error: null,
        trigger: 'manual' as const,
        duration_ms: 1000,
        rollback_of: null,
        container_id: 'old-container-id',
        started_at: Date.now() - 1000,
        finished_at: Date.now(),
        created_at: Date.now() - 1000,
      };

      const deploymentId = service.enqueueRollback(getProject(db, projectId)!, target);
      await expectStatus(db, deploymentId, 'live');

      expect(cloneRepository).not.toHaveBeenCalled();
      expect(state.builds).toHaveLength(0);

      const deployment = getDeployment(db, deploymentId)!;
      expect(deployment.trigger).toBe('rollback');
      expect(deployment.rollback_of).toBe(99);
      expect(deployment.image_tag).toBe('capturehost/pipeline-demo:bbbbbbb');
    } finally {
      cleanup();
    }
  });

  it('cancels a queued deployment before it starts', async () => {
    const { service, db, cleanup } = makeService(state);
    try {
      const projectId = seedProject(db);
      const first = service.enqueueDeploy(getProject(db, projectId)!, 'manual');
      const second = service.enqueueDeploy(getProject(db, projectId)!, 'manual');

      service.cancel(second);

      await expectStatus(db, second, 'cancelled');
      await expectStatus(db, first, 'live');
      expect(getDeployment(db, second)!.error).toMatch(/Cancelled/);
    } finally {
      cleanup();
    }
  });

  it('marks the project failed when the clone fails', async () => {
    const { service, db, cleanup } = makeService(state);
    try {
      cloneRepository.mockRejectedValueOnce(new Error('Repository not found, or the access token is missing'));
      const projectId = seedProject(db);

      const deploymentId = service.enqueueDeploy(getProject(db, projectId)!, 'manual');
      await expectStatus(db, deploymentId, 'failed');
      expect(getDeployment(db, deploymentId)!.error).toMatch(/Repository not found/);
      expect(state.created).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

// Keeps the unused import of setProjectRuntime out of the bundle warning noise.
void setProjectRuntime;
