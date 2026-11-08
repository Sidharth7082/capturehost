import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, getProject } from '../src/db/projects.repo.js';
import { createFakeDeployments, type FakeDeployments } from './deployFake.js';
import { startApp, type AuthedApp } from './appHarness.js';

/**
 * Route-level contract for Phase 4: validation, CSRF, secret handling and the
 * deploy/rollback/cancel wiring. The pipeline itself is stubbed — it is tested
 * separately in pipeline.test.ts.
 */

let harness: AuthedApp;
let fake: FakeDeployments;
let cookie: string;
let csrf: string;

const validProject = {
  name: 'demo-app',
  repoUrl: 'https://github.com/Sidharth7082/capturehost-test-app',
  branch: 'main',
  dockerfilePath: 'Dockerfile',
  containerPort: 80,
};

function authHeaders(): Record<string, string> {
  return { cookie, 'x-csrf-token': csrf };
}

async function createDemo(overrides: Record<string, unknown> = {}): Promise<number> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: authHeaders(),
    payload: { ...validProject, ...overrides },
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as { project: { id: number } }).project.id;
}

beforeEach(async () => {
  fake = createFakeDeployments();
  harness = await startApp({ deployments: fake.service });
  const login = await harness.login();
  cookie = login.cookie;
  csrf = login.csrfToken;
});

afterEach(async () => {
  await harness.close();
});

describe('POST /api/projects', () => {
  it('creates a project and returns the webhook secret exactly once', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: authHeaders(),
      payload: validProject,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      project: { id: number; status: string; slug: string; hasWebhookSecret: boolean; hasToken: boolean };
      webhookSecret: string;
    };

    expect(body.project.slug).toBe('demo-app');
    expect(body.project.status).toBe('idle');
    expect(body.project.hasWebhookSecret).toBe(true);
    expect(body.project.hasToken).toBe(false);
    expect(typeof body.webhookSecret).toBe('string');
    expect(body.webhookSecret.length).toBeGreaterThan(30);
  });

  it('never returns the secret in the project list', async () => {
    await createDemo();
    const response = await harness.app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('webhookSecret');
    expect(response.body).not.toContain('github_token');
  });

  it('rejects a non-GitHub repository URL', async () => {
    for (const repoUrl of [
      'git@github.com:owner/repo.git',
      'file:///etc/passwd',
      'https://gitlab.com/owner/repo',
      '--upload-pack=/bin/sh',
    ]) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: authHeaders(),
        payload: { ...validProject, name: 'other', repoUrl },
      });
      expect(response.statusCode, repoUrl).toBe(400);
    }
  });

  it('rejects an invalid name and a duplicate name', async () => {
    const badName = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: authHeaders(),
      payload: { ...validProject, name: 'Demo App' },
    });
    expect(badName.statusCode).toBe(400);

    await createDemo();
    const duplicate = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: authHeaders(),
      payload: validProject,
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('clamps resource requests to the configured maximum', async () => {
    // Within the schema's absolute bounds, above this config's ceiling.
    const id = await createDemo({ memoryLimitMb: 8192, cpuLimit: 8 });
    const project = getProject(harness.db, id)!;

    expect(project.memory_limit_mb).toBe(4096);
    expect(project.cpu_limit).toBe(4);
  });

  it('requires CSRF on create', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: validProject,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET/PATCH /api/projects/:id', () => {
  it('returns a project with its deployment history', async () => {
    const id = await createDemo();
    const response = await harness.app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { project: { id: number }; deployments: unknown[] };
    expect(body.project.id).toBe(id);
    expect(body.deployments).toEqual([]);
  });

  it('returns 404 for an unknown project', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/projects/4242', headers: { cookie } });
    expect(response.statusCode).toBe(404);
  });

  it('updates fields and re-clamps limits', async () => {
    const id = await createDemo();
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      headers: authHeaders(),
      payload: { branch: 'release/1.0', memoryLimitMb: 8192 },
    });

    expect(response.statusCode).toBe(200);
    const project = getProject(harness.db, id)!;
    expect(project.branch).toBe('release/1.0');
    expect(project.memory_limit_mb).toBe(4096);
  });
});

describe('environment variables', () => {
  it('stores values encrypted and never returns them', async () => {
    const id = await createDemo();

    const put = await harness.app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/env`,
      headers: authHeaders(),
      payload: { key: 'DATABASE_URL', value: 'postgres://user:secret@db/app' },
    });
    expect(put.statusCode).toBe(200);

    const list = await harness.app.inject({ method: 'GET', url: `/api/projects/${id}/env`, headers: { cookie } });
    expect(list.json()).toEqual({ env: [{ key: 'DATABASE_URL', masked: true }] });
    expect(list.body).not.toContain('postgres://');

    const stored = harness.db
      .prepare('SELECT value_encrypted FROM env_vars WHERE project_id = ? AND key = ?')
      .get(id, 'DATABASE_URL') as { value_encrypted: string };
    expect(stored.value_encrypted).not.toContain('postgres://');
    expect(stored.value_encrypted.startsWith('v1.')).toBe(true);
  });

  it('replaces an existing value on conflict and deletes by key', async () => {
    const id = await createDemo();

    for (const value of ['one', 'two']) {
      await harness.app.inject({
        method: 'PUT',
        url: `/api/projects/${id}/env`,
        headers: authHeaders(),
        payload: { key: 'API_KEY', value },
      });
    }

    const count = harness.db
      .prepare('SELECT COUNT(*) AS c FROM env_vars WHERE project_id = ?')
      .get(id) as { c: number };
    expect(count.c).toBe(1);

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}/env/API_KEY`,
      headers: authHeaders(),
    });
    expect(removed.statusCode).toBe(200);

    const after = harness.db.prepare('SELECT COUNT(*) AS c FROM env_vars WHERE project_id = ?').get(id) as {
      c: number;
    };
    expect(after.c).toBe(0);
  });

  it('rejects an invalid environment key', async () => {
    const id = await createDemo();
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/env`,
      headers: authHeaders(),
      payload: { key: 'BAD KEY', value: 'x' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('deploy lifecycle', () => {
  it('queues a manual deployment', async () => {
    const id = await createDemo();
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/projects/${id}/deploy`,
      headers: authHeaders(),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(fake.calls.deploy).toHaveLength(1);
    expect(fake.calls.deploy[0]?.id).toBe(id);
  });

  it('rolls back to the previous successful image', async () => {
    const id = await createDemo();
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/projects/${id}/rollback`,
      headers: authHeaders(),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(fake.calls.rollback).toHaveLength(1);
    expect(fake.calls.rollback[0]?.target.image_tag).toBe('capturehost/demo:fffffff');
  });

  it('returns a clear error when there is nothing to roll back to', async () => {
    const id = await createDemo();
    fake.rollbackTarget = null;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/projects/${id}/rollback`,
      headers: authHeaders(),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('no_rollback_target');
  });

  it('cancels a deployment belonging to the project', async () => {
    const id = await createDemo();
    harness.db
      .prepare(
        `INSERT INTO deployments (project_id, status, trigger, log, created_at)
         VALUES (?, 'building', 'manual', '', ?)`,
      )
      .run(id, Date.now());

    const deploymentId = Number(
      (harness.db.prepare('SELECT MAX(id) AS id FROM deployments').get() as { id: number }).id,
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/projects/${id}/deployments/${deploymentId}/cancel`,
      headers: authHeaders(),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(fake.calls.cancel).toEqual([deploymentId]);
  });

  it('refuses to cancel a deployment from another project', async () => {
    const id = await createDemo();
    const otherId = createProject(harness.db, {
      name: 'other',
      slug: 'other',
      repoUrl: 'https://github.com/owner/other',
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

    harness.db
      .prepare(`INSERT INTO deployments (project_id, status, trigger, log, created_at) VALUES (?, 'building', 'manual', '', ?)`)
      .run(otherId, Date.now());
    const deploymentId = Number(
      (harness.db.prepare('SELECT MAX(id) AS id FROM deployments').get() as { id: number }).id,
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/projects/${id}/deployments/${deploymentId}/cancel`,
      headers: authHeaders(),
      payload: {},
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /api/projects/:id', () => {
  it('requires the project name as confirmation', async () => {
    const id = await createDemo();

    const wrong = await harness.app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}?confirm=nope`,
      headers: authHeaders(),
    });
    expect(wrong.statusCode).toBe(400);
    expect(getProject(harness.db, id)).not.toBeNull();

    const right = await harness.app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}?confirm=demo-app`,
      headers: authHeaders(),
    });
    expect(right.statusCode).toBe(200);
    expect(getProject(harness.db, id)).toBeNull();
  });
});

describe('webhook details endpoint', () => {
  it('returns the signing secret to an authenticated operator', async () => {
    const id = await createDemo();
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/projects/${id}/webhook`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { path: string; secret: string };
    expect(body.path).toBe(`/api/webhooks/github/${id}`);
    expect(body.secret.length).toBeGreaterThan(30);
  });
});

describe('websocket: /ws/deployments/:depId/logs', () => {
  const origin = 'http://localhost:5173';

  function socketUrl(depId: number): string {
    return `ws://127.0.0.1:${harness.port}/ws/deployments/${depId}/logs`;
  }

  /** The FK on deployments.project_id needs a real row first. */
  function ensureProject(): number {
    const existing = harness.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: number } | undefined;
    if (existing) return existing.id;

    return createProject(harness.db, {
      name: 'ws-demo',
      slug: 'ws-demo',
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

  function seedDeployment(log: string): number {
    const projectId = ensureProject();

    harness.db
      .prepare(
        `INSERT INTO deployments (project_id, status, trigger, log, created_at)
         VALUES (?, 'building', 'manual', ?, ?)`,
      )
      .run(projectId, log, Date.now());

    return Number((harness.db.prepare('SELECT MAX(id) AS id FROM deployments').get() as { id: number }).id);
  }

  it('rejects a socket with no session', async () => {
    const depId = seedDeployment('');

    const code = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(socketUrl(depId), { origin });
      socket.on('close', (status: number) => resolve(status));
      socket.on('error', () => undefined);
      setTimeout(() => reject(new Error('server did not close the socket')), 4000);
    });

    expect(code).toBe(1008);
  });

  it('rejects a valid session from a foreign origin', async () => {
    const depId = seedDeployment('');

    const code = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(socketUrl(depId), {
        origin: 'https://evil.example.com',
        headers: { Cookie: cookie },
      });
      socket.on('close', (status: number) => resolve(status));
      socket.on('error', () => undefined);
      setTimeout(() => reject(new Error('server did not close the socket')), 4000);
    });

    expect(code).toBe(1008);
  });

  it('sends the stored log first, then live lines', async () => {
    const depId = seedDeployment('09:00:00  Cloning repository\n09:00:01  Building image');

    const frames = await new Promise<string[]>((resolve, reject) => {
      const socket = new WebSocket(socketUrl(depId), { origin, headers: { Cookie: cookie } });
      const received: string[] = [];

      socket.on('message', (data: WebSocket.RawData) => {
        received.push(String(data));
        if (received.length >= 1) {
          socket.close();
          resolve(received);
        }
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('no frames received')), 4000);
    });

    const open = JSON.parse(frames[0]!) as { type: string; payload: { deploymentId: number; log: string } };
    expect(open.type).toBe('open');
    expect(open.payload.deploymentId).toBe(depId);
    expect(open.payload.log).toContain('Cloning repository');
  });

  it('refuses an unknown deployment', async () => {
    const code = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(socketUrl(999_999), { origin, headers: { Cookie: cookie } });
      socket.on('close', (status: number) => resolve(status));
      socket.on('error', () => undefined);
      setTimeout(() => reject(new Error('server did not close the socket')), 4000);
    });

    expect(code).toBe(1008);
  });
});
