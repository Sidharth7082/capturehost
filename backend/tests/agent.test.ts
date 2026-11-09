import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApp, type AuthedApp } from './appHarness.js';
import { silentLogger } from './helpers.js';
import { AgentAccessService } from '../src/services/agentAccess.js';

/**
 * The agent surface, over real HTTP.
 *
 * What is asserted is the boundary: no token means no answer, a read-only token
 * cannot deploy, a revoked token stops working immediately, and every call is
 * audited with the token's name and never with the token itself.
 */

let harness: AuthedApp;

function stubDeployments() {
  const enqueued: Array<{ projectId: number; trigger: string }> = [];
  return {
    enqueued,
    service: {
      isBusy: () => false,
      enqueueDeploy: (project: { id: number }, trigger: string) => {
        enqueued.push({ projectId: project.id, trigger });
        return 4242;
      },
    } as never,
  };
}

async function boot(options: { withProject?: boolean } = {}) {
  const stub = stubDeployments();
  const app = await startApp({ deployments: stub.service });
  // The harness seeds an admin; a project is optional for these routes.
  if (options.withProject) seedProject(app);
  return { harness: app, stub };
}

function seedProject(harness: AuthedApp): number {
  const now = Date.now();
  const result = harness.db
    .prepare(
      `INSERT INTO projects (name, slug, repo_url, branch, dockerfile_path, container_port, health_path,
                             cpu_limit, memory_limit_mb, pids_limit, webhook_secret_encrypted,
                             github_token_encrypted, created_at, updated_at, status)
       VALUES ('agent-demo', 'agent-demo', 'https://github.com/o/r', 'main', 'Dockerfile', 80, NULL,
               0.5, 512, 256, NULL, NULL, ?, ?, 'idle')`,
    )
    .run(now, now);
  return Number(result.lastInsertRowid);
}

function makeToken(harness: AuthedApp, allowDeploy: boolean): string {
  const access = new AgentAccessService({ db: harness.db, logger: silentLogger });
  return access.create({ name: `test-${allowDeploy ? 'deploy' : 'read'}`, allowDeploy }, { actor: 'admin' }).token;
}

beforeEach(async () => {
  harness = (await boot({ withProject: true })).harness;
});

afterEach(async () => {
  await harness.close();
});

const TOOL_ROUTES = [
  '/api/agent/tools/whoami',
  '/api/agent/tools/projects',
  '/api/agent/tools/projects/1',
  '/api/agent/tools/deployments/1',
  '/api/agent/tools/doctor',
];

describe('authentication', () => {
  for (const url of TOOL_ROUTES) {
    it(`${url} answers 401 without a token`, async () => {
      const response = await harness.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
    });
  }

  it('rejects a token that was never issued', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/agent/tools/whoami',
      headers: { authorization: 'Bearer agent_not-a-real-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a real token and reports its permissions', async () => {
    const token = makeToken(harness, false);
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/agent/tools/whoami',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ allowDeploy: false });
  });

  it('stops working the moment it is revoked', async () => {
    const access = new AgentAccessService({ db: harness.db, logger: silentLogger });
    const created = access.create({ name: 'short-lived', allowDeploy: false }, { actor: 'admin' });
    access.revoke(created.id, { actor: 'admin' });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/agent/tools/whoami',
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('tools', () => {
  it('lists projects without leaking container or token internals', async () => {
    const token = makeToken(harness, false);
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/agent/tools/projects',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { projects: Array<Record<string, unknown>> };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({ name: 'agent-demo', branch: 'main' });
    expect(JSON.stringify(body)).not.toContain('webhook_secret');
  });

  it('returns a deployment history with diagnoses attached', async () => {
    const token = makeToken(harness, false);
    harness.db
      .prepare(
        `INSERT INTO deployments (project_id, status, trigger, error, log, created_at)
         VALUES (1, 'failed', 'manual', 'Clone failed', 'Remote branch main not found', ?)`,
      )
      .run(Date.now());

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/agent/tools/projects/1',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { deployments: Array<{ diagnosis: { stage: string } | null }> };
    expect(body.deployments[0]?.diagnosis?.stage).toBe('clone');
  });

  it('refuses a deploy from a read-only token', async () => {
    const token = makeToken(harness, false);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/agent/tools/projects/1/deploy',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('deploy', () => {
  it('queues a deployment when the token allows it', async () => {
    const token = makeToken(harness, true);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/agent/tools/projects/1/deploy',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ queued: true, deploymentId: 4242 });
  });
});

describe('audit', () => {
  it('records every call with the token name and never the token', async () => {
    const token = makeToken(harness, false);
    await harness.app.inject({
      method: 'GET',
      url: '/api/agent/tools/projects',
      headers: { authorization: `Bearer ${token}` },
    });

    const rows = harness.db.prepare("SELECT action, actor FROM audit_log WHERE action LIKE 'agent.%'").all() as Array<{
      action: string;
      actor: string;
    }>;

    expect(rows.map((row) => row.action)).toContain('agent.list_projects');
    expect(rows.some((row) => row.actor === 'agent:test-read')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe('token management', () => {
  it('shows a new token once and never again', async () => {
    const { cookie, csrfToken } = await harness.login();

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/agent/tokens',
      payload: { name: 'hermes', allowDeploy: true },
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(created.statusCode).toBe(200);
    const body = created.json() as { token: string; tokens: Array<Record<string, unknown>> };
    expect(body.token).toMatch(/^agent_/);
    // The list that comes back already has no token material in it.
    expect(JSON.stringify(body.tokens)).not.toContain(body.token);
    expect(JSON.stringify(body.tokens)).not.toContain('token_hash');

    const listed = await harness.app.inject({ method: 'GET', url: '/api/agent/tokens', headers: { cookie } });
    expect(JSON.stringify(listed.json())).not.toContain(body.token);
  });

  it('needs a session and CSRF to create a token', async () => {
    const { cookie } = await harness.login();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/agent/tokens',
      payload: { name: 'nope' },
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });
});
