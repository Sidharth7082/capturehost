import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '../src/db/projects.repo.js';
import { encryptString } from '../src/crypto/secretbox.js';
import { verifySignature } from '../src/routes/webhook.js';
import { testConfig } from './helpers.js';
import { startApp, type AuthedApp } from './appHarness.js';
import { createFakeDeployments, type FakeDeployments } from './deployFake.js';

/**
 * The webhook is the only unauthenticated POST endpoint. Every test here tries
 * to get a deployment started without a valid signature, or to replay one.
 */

const SECRET = 'webhook-secret-for-tests';
const BRANCH = 'main';

let harness: AuthedApp;
let fake: FakeDeployments;
let projectId: number;

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
}

function pushBody(ref = `refs/heads/${BRANCH}`, after = 'a'.repeat(40)): string {
  return JSON.stringify({
    ref,
    after,
    repository: { full_name: 'owner/repo' },
  });
}

async function deliver(
  body: string,
  options: { signature?: string; event?: string; deliveryId?: string } = {},
): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: `/api/webhooks/github/${projectId}`,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': options.signature ?? sign(body),
      'x-github-event': options.event ?? 'push',
      'x-github-delivery': options.deliveryId ?? `delivery-${Math.random().toString(36).slice(2)}`,
    },
    payload: body,
  });

  return { statusCode: response.statusCode, json: response.json() as Record<string, unknown> };
}

beforeEach(async () => {
  fake = createFakeDeployments();
  harness = await startApp({ deployments: fake.service });

  const config = testConfig();
  projectId = createProject(harness.db, {
    name: 'webhook-demo',
    slug: 'webhook-demo',
    repoUrl: 'https://github.com/owner/repo',
    branch: BRANCH,
    dockerfilePath: 'Dockerfile',
    containerPort: 80,
    healthPath: null,
    cpuLimit: 0.5,
    memoryLimitMb: 512,
    pidsLimit: 256,
    webhookSecretEncrypted: encryptString(SECRET, config.encryptionKey, 'project.webhook_secret'),
    githubTokenEncrypted: null,
    now: Date.now(),
  });
});

afterEach(async () => {
  await harness.close();
});

describe('POST /api/webhooks/github/:projectId', () => {
  it('accepts a correctly signed push and queues a deployment', async () => {
    const result = await deliver(pushBody());
    expect(result.statusCode).toBe(202);
    expect(fake.calls.deploy).toHaveLength(1);
    expect(fake.calls.deploy[0]?.id).toBe(projectId);
  });

  it('does not require a session (it is public by design)', async () => {
    const result = await deliver(pushBody());
    expect(result.statusCode).not.toBe(401);
  });

  it('rejects a bad signature with 401 and does not deploy', async () => {
    const result = await deliver(pushBody(), { signature: sign(pushBody(), 'wrong-secret') });
    expect(result.statusCode).toBe(401);
    expect(fake.calls.deploy).toHaveLength(0);
  });

  it('rejects a missing signature header', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/webhooks/github/${projectId}`,
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      payload: pushBody(),
    });
    expect(response.statusCode).toBe(401);
    expect(fake.calls.deploy).toHaveLength(0);
  });

  it('rejects a signature that is not a hex digest', async () => {
    const result = await deliver(pushBody(), { signature: 'sha256=not-hex' });
    expect(result.statusCode).toBe(401);
  });

  it('answers ping with 200 and does not deploy', async () => {
    const result = await deliver(JSON.stringify({ zen: 'hi' }), { event: 'ping' });
    expect(result.statusCode).toBe(200);
    expect(result.json).toMatchObject({ pong: true });
    expect(fake.calls.deploy).toHaveLength(0);
  });

  it('ignores other events', async () => {
    const result = await deliver(JSON.stringify({ action: 'opened' }), { event: 'pull_request' });
    expect(result.statusCode).toBe(202);
    expect(result.json).toMatchObject({ ignored: true });
    expect(fake.calls.deploy).toHaveLength(0);
  });

  it('ignores a push to a different branch', async () => {
    const result = await deliver(pushBody('refs/heads/feature-x'));
    expect(result.statusCode).toBe(202);
    expect(result.json).toMatchObject({ ignored: true });
    expect(fake.calls.deploy).toHaveLength(0);
  });

  it('ignores a tag push', async () => {
    const result = await deliver(pushBody('refs/tags/v1.0.0'));
    expect(result.statusCode).toBe(202);
    expect(fake.calls.deploy).toHaveLength(0);
  });

  it('processes a delivery id only once', async () => {
    const first = await deliver(pushBody(), { deliveryId: 'delivery-abc-123' });
    const second = await deliver(pushBody(), { deliveryId: 'delivery-abc-123' });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json).toMatchObject({ duplicate: true });
    expect(fake.calls.deploy).toHaveLength(1);
  });

  it('returns 404 for an unknown project without revealing anything', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/webhooks/github/999999',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      payload: pushBody(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects an oversized body with 413', async () => {
    const huge = JSON.stringify({ ref: `refs/heads/${BRANCH}`, padding: 'x'.repeat(1_100_000) });
    const result = await deliver(huge);
    expect(result.statusCode).toBe(413);
    expect(fake.calls.deploy).toHaveLength(0);
  });

  it('writes an audit row for accepted and rejected deliveries', async () => {
    await deliver(pushBody());
    await deliver(pushBody(), { signature: sign(pushBody(), 'nope') });

    const rows = harness.db
      .prepare("SELECT action, success FROM audit_log WHERE action LIKE 'webhook.%' ORDER BY id")
      .all() as Array<{ action: string; success: number }>;

    expect(rows.map((row) => row.action)).toContain('webhook.accepted');
    expect(rows.map((row) => row.action)).toContain('webhook.rejected');
  });
});

describe('verifySignature', () => {
  const body = Buffer.from('{"ref":"refs/heads/main"}');

  it('accepts a digest produced over the raw bytes', () => {
    const header = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    expect(verifySignature(body, SECRET, header)).toBe(true);
  });

  it('rejects a signature computed over different bytes', () => {
    const header = `sha256=${createHmac('sha256', SECRET).update(Buffer.from('other')).digest('hex')}`;
    expect(verifySignature(body, SECRET, header)).toBe(false);
  });

  it('rejects the wrong algorithm prefix, missing header and short digests', () => {
    const good = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifySignature(body, SECRET, `sha1=${good}`)).toBe(false);
    expect(verifySignature(body, SECRET, undefined)).toBe(false);
    expect(verifySignature(body, SECRET, 'sha256=')).toBe(false);
    expect(verifySignature(body, SECRET, `sha256=${good.slice(0, 10)}`)).toBe(false);
  });

  it('rejects a body that only differs by one byte (no timing shortcut)', () => {
    const header = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    const tampered = Buffer.from('{"ref":"refs/heads/maiN"}');
    expect(verifySignature(tampered, SECRET, header)).toBe(false);
  });
});

describe('repeated rejections', () => {
  it('raises exactly one notification after five rejected signatures', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // A fresh delivery id each time: the rejection is the signature, not the id.
      await deliver(pushBody(), {
        signature: sign(pushBody(), `wrong-secret-${attempt}`),
        deliveryId: `bad-${attempt}`,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 20));

    const rows = harness.db
      .prepare("SELECT event, title FROM notifications WHERE event = 'webhook.rejected_repeatedly'")
      .all() as { event: string; title: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toContain('5 rejected webhooks');
    expect(fake.calls.deploy).toHaveLength(0);
  });

  it('does not notify below the threshold', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await deliver(pushBody(), {
        signature: sign(pushBody(), `wrong-secret-${attempt}`),
        deliveryId: `bad-low-${attempt}`,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 20));

    const count = harness.db
      .prepare("SELECT COUNT(*) AS count FROM notifications WHERE event = 'webhook.rejected_repeatedly'")
      .get() as { count: number };

    expect(count.count).toBe(0);
  });
});
