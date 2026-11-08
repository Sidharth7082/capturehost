#!/usr/bin/env node
/**
 * End-to-end deployment check — NOT part of the test suite.
 *
 * It creates its own project ("capturehost-test-lab"), deploys the test
 * repository, redeploys, rolls back, fetches the running app, and then deletes
 * exactly that project (which removes only the container and images whose
 * labels/tags belong to it). Nothing else on the machine is touched.
 *
 *   node scripts/integration-deploy.mjs [repoUrl]
 *
 * Authentication: it mints a one-shot session row in the local SQLite file,
 * which is the same power as shell access to that file. Run it only on your
 * own machine.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? join(here, '..', 'data', 'capturehost.db');
const base = process.env.CAPTUREHOST_URL ?? 'http://127.0.0.1:8787';
const repoUrl = process.argv[2] ?? 'https://github.com/Sidharth7082/capturehost-test-app';

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Start the backend once first.`);
  process.exit(1);
}

const PROJECT_NAME = 'capturehost-test-lab';

// ---------------------------------------------------------------- session
const db = new Database(dbPath);
const token = randomBytes(32).toString('hex');
const csrf = randomBytes(32).toString('hex');
const now = Date.now();

db.prepare(
  `INSERT INTO sessions (id, admin_id, csrf_token, ip, user_agent, created_at, last_seen_at,
                         expires_at, absolute_expires_at, kind)
   VALUES (?, 1, ?, '127.0.0.1', 'integration-deploy', ?, ?, ?, ?, 'full')`,
).run(
  createHash('sha256').update(token).digest('hex'),
  csrf,
  now,
  now,
  now + 30 * 60_000,
  now + 60 * 60_000,
);

const cookie = `capturehost_sid=${token}`;

async function api(path, init = {}) {
  const method = (init.method ?? 'GET').toUpperCase();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      cookie,
      ...(method === 'GET' || method === 'HEAD' ? {} : { 'x-csrf-token': csrf }),
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${body.error ?? ''}`);
  return body;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDeployment(projectId, deploymentId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { deployments } = await api(`/api/projects/${projectId}/deployments`);
    const deployment = deployments.find((entry) => entry.id === deploymentId);
    if (!deployment) throw new Error(`deployment ${deploymentId} disappeared`);
    if (['live', 'failed', 'cancelled', 'rolled-back'].includes(deployment.status)) return deployment;
    await sleep(2000);
  }

  throw new Error(`deployment ${deploymentId} did not finish in time`);
}

function step(label) {
  console.log(`\n▸ ${label}`);
}

// ------------------------------------------------------------------- flow
let projectId = null;

try {
  step('Existing test project?');
  const { projects } = await api('/api/projects');
  const existing = projects.find((project) => project.name === PROJECT_NAME);
  if (existing) {
    projectId = existing.id;
    console.log(`  reusing project #${projectId} (${existing.repoUrl})`);
  }

  if (!projectId) {
    step('Creating the test project');
    const created = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: PROJECT_NAME,
        repoUrl,
        branch: 'main',
        dockerfilePath: 'Dockerfile',
        containerPort: 80,
      }),
    });
    projectId = created.project.id;
    console.log(`  project #${projectId} created, webhook secret issued`);
  }

  step('First deployment');
  const first = await api(`/api/projects/${projectId}/deploy`, { method: 'POST', body: '{}' });
  const firstDone = await waitForDeployment(projectId, first.deploymentId);
  console.log(`  #${firstDone.id} ${firstDone.status} in ${Math.round((firstDone.durationMs ?? 0) / 1000)}s (${firstDone.imageTag})`);
  if (firstDone.status !== 'live') throw new Error(`first deployment ended ${firstDone.status}: ${firstDone.error}`);

  step('Fetching the running app');
  const afterFirst = await api(`/api/projects/${projectId}`);
  const firstPort = afterFirst.project.hostPort;
  const firstResponse = await fetch(`http://127.0.0.1:${firstPort}/`);
  const html = await firstResponse.text();
  console.log(`  GET http://127.0.0.1:${firstPort}/ -> ${firstResponse.status}, ${html.length} bytes`);
  if (!firstResponse.ok) throw new Error('the deployed app did not answer 200');

  step('Second deployment (the redeploy path)');
  const second = await api(`/api/projects/${projectId}/deploy`, { method: 'POST', body: '{}' });
  const secondDone = await waitForDeployment(projectId, second.deploymentId);
  console.log(`  #${secondDone.id} ${secondDone.status}`);
  if (secondDone.status !== 'live') throw new Error(`second deployment ended ${secondDone.status}`);

  step('Rollback to the previous image');
  const rollback = await api(`/api/projects/${projectId}/rollback`, { method: 'POST', body: '{}' });
  const rollbackDone = await waitForDeployment(projectId, rollback.deploymentId);
  console.log(`  #${rollbackDone.id} ${rollbackDone.status} -> ${rollbackDone.imageTag}`);
  if (rollbackDone.status !== 'live') throw new Error(`rollback ended ${rollbackDone.status}`);

  step('Fetching the app again');
  const afterRollback = await api(`/api/projects/${projectId}`);
  const finalResponse = await fetch(`http://127.0.0.1:${afterRollback.project.hostPort}/`);
  console.log(`  GET http://127.0.0.1:${afterRollback.project.hostPort}/ -> ${finalResponse.status}`);
  if (!finalResponse.ok) throw new Error('the app stopped answering after the rollback');

  step('Environment variable round trip');
  await api(`/api/projects/${projectId}/env`, {
    method: 'PUT',
    body: JSON.stringify({ key: 'INTEGRATION_MARKER', value: 'present' }),
  });
  const { env } = await api(`/api/projects/${projectId}/env`);
  const leaked = JSON.stringify(env).includes('present');
  console.log(`  key stored: ${env.map((entry) => entry.key).join(', ') || 'none'} | value leaked to API: ${leaked}`);
  if (leaked) throw new Error('the API returned an env value');

  console.log('\nAll deployment checks passed.');
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  // Cleanup is scoped to this project by name; the API removes only the
  // container and `capturehost/<slug>:*` images that belong to it.
  if (projectId) {
    step(`Cleaning up project #${projectId}`);
    try {
      await api(`/api/projects/${projectId}?confirm=${encodeURIComponent(PROJECT_NAME)}`, { method: 'DELETE' });
      console.log('  project, container and images removed');
    } catch (error) {
      console.error(`  cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }

  db.prepare('DELETE FROM sessions WHERE user_agent = ?').run('integration-deploy');
  db.close();
}
