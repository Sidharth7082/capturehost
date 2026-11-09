import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The credential rule, tested where it can actually be broken.
 *
 * A private clone needs the token; nothing else in the pipeline may ever see it.
 * This file drives a whole deploy with git and Docker faked, then looks for the
 * token in every place it could leak: the deployment log (the thing streamed to
 * the browser and kept in SQLite), the audit log, the Docker build arguments, and
 * the container's config/env/labels.
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

vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, result?: { stdout: Buffer; stderr: string }) => void,
  ) => callback(null, { stdout: Buffer.from('fake-tar'), stderr: '' }),
}));

const { DeploymentService } = await import('../src/services/deployments.js');
const { createTestDb, silentLogger, testConfig } = await import('./helpers.js');
const { createProject, getDeployment, getProject } = await import('../src/db/projects.repo.js');
const { encryptString } = await import('../src/crypto/secretbox.js');

const INTEGRATION_TOKEN = 'github_pat_INTEGRATIONFIXTURE0123456789abcdefghij';
const PROJECT_TOKEN = 'github_pat_PROJECTFIXTURE0123456789abcdefghijklmn';

interface State {
  created: Array<Record<string, unknown>>;
  builds: Array<Record<string, unknown>>;
}

function createFakeDocker(state: State) {
  return {
    buildImage: async (_stream: unknown, buildOptions: Record<string, unknown>) => {
      state.builds.push(buildOptions);
      const stream = new Readable({ read() {} });
      stream.push(Buffer.from(`${JSON.stringify({ stream: 'Step 1/1 : FROM nginx:alpine\\n' })}\r\n`));
      stream.push(null);
      return stream;
    },
    createContainer: async (createOptions: Record<string, unknown>) => {
      state.created.push(createOptions);
      return { id: 'new-container-id', start: async () => undefined };
    },
    getContainer: () => ({
      inspect: async () => ({ State: { Running: true, ExitCode: 0 } }),
      remove: async () => undefined,
      stop: async () => undefined,
    }),
    getImage: () => ({ inspect: async () => ({}), remove: async () => undefined }),
    listImages: async () => [],
  };
}

function buildService(options: {
  integrationToken: (() => string | null) | undefined;
  projectToken?: string;
}) {
  const testDb = createTestDb();
  const state: State = { created: [], builds: [] };
  const logs: string[] = [];

  const config = {
    ...testConfig(),
    deploy: { ...testConfig().deploy, healthCheckTimeoutMs: 4000 },
  };

  const service = new DeploymentService({
    db: testDb.db,
    config,
    logger: silentLogger,
    client: createFakeDocker(state) as never,
    onLog: (_id, line) => logs.push(line),
    ...(options.integrationToken ? { integrationToken: options.integrationToken } : {}),
  });

  const projectId = createProject(testDb.db, {
    name: 'token-demo',
    slug: 'token-demo',
    repoUrl: 'https://github.com/owner/private-repo',
    branch: 'main',
    dockerfilePath: 'Dockerfile',
    containerPort: 80,
    healthPath: null,
    cpuLimit: 0.5,
    memoryLimitMb: 512,
    pidsLimit: 256,
    webhookSecretEncrypted: null,
    githubTokenEncrypted: options.projectToken
      ? encryptString(options.projectToken, testConfig().encryptionKey, 'project.github_token')
      : null,
    now: Date.now(),
  });

  return { service, db: testDb.db, state, logs, projectId, cleanup: testDb.cleanup };
}

async function waitForTerminal(db: ReturnType<typeof createTestDb>['db'], deploymentId: number): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const deployment = getDeployment(db, deploymentId);
    if (deployment && ['live', 'failed', 'cancelled', 'rolled-back'].includes(deployment.status)) {
      return deployment.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('deployment did not finish');
}

beforeEach(() => {
  cloneRepository.mockReset();
  assertDockerfilePresent.mockReset();
  removeWorkingTree.mockReset();

  cloneRepository.mockResolvedValue({
    commitSha: 'b'.repeat(40),
    shortSha: 'bbbbbbb',
    sizeBytes: 4096,
    path: '/tmp/capturehost-token-test/1/dep-1',
  });
  assertDockerfilePresent.mockReturnValue('/tmp/capturehost-token-test/1/dep-1/Dockerfile');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('private clone credentials', () => {
  it('gives git the integration token and leaks it nowhere else', async () => {
    const { service, db, state, logs, projectId, cleanup } = buildService({
      integrationToken: () => INTEGRATION_TOKEN,
    });

    try {
      const deploymentId = service.enqueueDeploy(getProject(db, projectId)!, 'manual');
      await expect(waitForTerminal(db, deploymentId)).resolves.toBe('live');

      // 1. git got it …
      expect(cloneRepository).toHaveBeenCalledTimes(1);
      expect(cloneRepository.mock.calls[0]?.[0]).toMatchObject({ token: INTEGRATION_TOKEN });

      // … and the URL it was given carries no credential at all
      const cloneArgs = cloneRepository.mock.calls[0]?.[0] as { repoUrl: string };
      expect(cloneArgs.repoUrl).toBe('https://github.com/owner/private-repo');
      expect(cloneArgs.repoUrl).not.toContain('@');
      expect(cloneArgs.repoUrl).not.toContain(INTEGRATION_TOKEN);

      // 2. the stored deployment log (streamed to the browser, kept in SQLite)
      const deployment = getDeployment(db, deploymentId)!;
      expect(deployment.log ?? '').not.toContain(INTEGRATION_TOKEN);
      expect(logs.join('\n')).not.toContain(INTEGRATION_TOKEN);

      // 3. the audit log
      const audit = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
      expect(audit).not.toContain(INTEGRATION_TOKEN);

      // 4. the build arguments
      expect(JSON.stringify(state.builds)).not.toContain(INTEGRATION_TOKEN);

      // 5. the container: config, env, labels, name — everything Docker saw
      expect(JSON.stringify(state.created)).not.toContain(INTEGRATION_TOKEN);
      const created = state.created[0] as { Env?: string[]; Labels?: Record<string, string> };
      expect(created.Env ?? []).not.toContain(INTEGRATION_TOKEN);
      expect(JSON.stringify(created.Labels ?? {})).not.toContain(INTEGRATION_TOKEN);
    } finally {
      cleanup();
    }
  });

  it('lets a per-project token override the integration token', async () => {
    const { service, db, projectId, cleanup } = buildService({
      integrationToken: () => INTEGRATION_TOKEN,
      projectToken: PROJECT_TOKEN,
    });

    try {
      const deploymentId = service.enqueueDeploy(getProject(db, projectId)!, 'manual');
      await waitForTerminal(db, deploymentId);

      expect(cloneRepository.mock.calls[0]?.[0]).toMatchObject({ token: PROJECT_TOKEN });
      expect(JSON.stringify(cloneRepository.mock.calls)).not.toContain(INTEGRATION_TOKEN);
    } finally {
      cleanup();
    }
  });

  it('clones anonymously when nothing is connected', async () => {
    const { service, db, projectId, cleanup } = buildService({ integrationToken: undefined });

    try {
      const deploymentId = service.enqueueDeploy(getProject(db, projectId)!, 'manual');
      await waitForTerminal(db, deploymentId);

      expect(cloneRepository.mock.calls[0]?.[0]).toMatchObject({ token: null });
    } finally {
      cleanup();
    }
  });
});
