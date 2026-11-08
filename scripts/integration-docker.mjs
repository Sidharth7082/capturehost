#!/usr/bin/env node
/**
 * Live integration check for Phase 3. NOT part of the unit test suite.
 *
 * It touches a real Docker daemon, so it only ever creates and deletes ONE
 * container, labelled `capturehost.test=true`, and it refuses to run against
 * anything else. Every existing container on the machine is left untouched.
 *
 *   DOCKER_API_PASSWORD='…' node scripts/integration-docker.mjs
 *
 * Requires: the socket proxy up, the backend running, and an admin account.
 * Optional env: DOCKER_API_URL (default http://127.0.0.1:8787),
 *               DOCKER_API_USERNAME (default sid)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const API = process.env.DOCKER_API_URL ?? 'http://127.0.0.1:8787';
const USERNAME = process.env.DOCKER_API_USERNAME ?? 'sid';
const PASSWORD = process.env.DOCKER_API_PASSWORD ?? '';
const NAME = `ch-it-${Date.now().toString(36)}`;
const LABEL = 'capturehost.test=true';

let cookie = '';
let csrf = '';

const log = (message) => console.log(`  ${message}`);
const ok = (message) => console.log(`✓ ${message}`);
const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(path, method = 'GET', withCsrf = false) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(withCsrf ? { 'x-csrf-token': csrf } : {}),
    },
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { status: response.status, body };
}

async function docker(...args) {
  const { stdout } = await run('docker', args, { timeout: 60_000 });
  return stdout.trim();
}

async function cleanup() {
  try {
    // Filter by name AND label so a typo can never remove someone else's box.
    const ids = await docker('ps', '-aq', '--filter', `name=^/${NAME}$`, '--filter', `label=${LABEL}`);
    if (ids) {
      log(`cleanup: removing ${NAME}`);
      await docker('rm', '-f', NAME);
    }
  } catch (error) {
    console.warn('cleanup failed:', error instanceof Error ? error.message : error);
  }
}

async function main() {
  if (!PASSWORD) {
    fail('DOCKER_API_PASSWORD is required (the admin password for the dashboard)');
    return;
  }

  console.log(`\nCaptureHost Docker integration check — container ${NAME}\n`);

  // ---- session -----------------------------------------------------------
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });

  assert(login.ok, `login failed with ${login.status}`);
  const setCookie = login.headers.get('set-cookie') ?? '';
  cookie = setCookie.split(';')[0];
  csrf = (await login.json()).csrfToken;
  ok('logged in');

  // ---- status ------------------------------------------------------------
  const status = await api('/api/docker/status');
  assert(status.status === 200 && status.body.available, 'docker status reports unavailable');
  ok(`engine ${status.body.version} via ${status.body.hostUrl}`);

  // ---- create our own container -----------------------------------------
  await docker(
    'run', '-d',
    '--name', NAME,
    '--label', LABEL,
    'python:3.10-slim',
    'sh', '-c', 'while true; do echo tick; sleep 1; done',
  );
  ok(`created ${NAME} (label ${LABEL})`);

  try {
    // ---- appears in the API ----------------------------------------------
    const list = await api('/api/docker/containers');
    const found = list.body.containers.find((container) => container.name === NAME);
    assert(found, 'new container is missing from /api/docker/containers');
    assert(found.state === 'running', `expected running, got ${found.state}`);
    ok(`listed with state=${found.state}`);

    // ---- stop ------------------------------------------------------------
    const stop = await api(`/api/docker/containers/${found.id}/stop`, 'POST', true);
    assert(stop.status === 200, `stop returned ${stop.status}`);
    assert(stop.body.container.state === 'exited', `expected exited, got ${stop.body.container.state}`);
    ok('stop → exited');

    // ---- start -----------------------------------------------------------
    const start = await api(`/api/docker/containers/${found.id}/start`, 'POST', true);
    assert(start.status === 200, `start returned ${start.status}`);
    assert(start.body.container.state === 'running', 'start did not reach running');
    ok('start → running');

    // ---- restart ---------------------------------------------------------
    const restart = await api(`/api/docker/containers/${found.id}/restart`, 'POST', true);
    assert(restart.status === 200, `restart returned ${restart.status}`);
    ok('restart → running');

    // ---- remove while running must be refused ---------------------------
    const refused = await api(`/api/docker/containers/${found.id}`, 'DELETE', true);
    assert(refused.status === 409, `expected 409 removing a running container, got ${refused.status}`);
    ok('remove while running → 409 (supervisor rule held)');

    // ---- stop, then remove ----------------------------------------------
    await api(`/api/docker/containers/${found.id}/stop`, 'POST', true);
    const removed = await api(`/api/docker/containers/${found.id}`, 'DELETE', true);
    assert(removed.status === 200, `remove returned ${removed.status}`);
    ok('remove → gone');

    // ---- protected container is not removable ---------------------------
    const proxy = list.body.containers.find((container) => container.name === 'capturehost-socket-proxy');
    if (proxy) {
      const denied = await api(`/api/docker/containers/${proxy.id}/stop`, 'POST', true);
      assert(denied.status === 403, `expected 403 for the socket proxy, got ${denied.status}`);
      ok('socket proxy stop → 403');
    }
  } finally {
    await cleanup();
  }

  // ---- nothing left behind ----------------------------------------------
  const stragglers = await docker('ps', '-aq', '--filter', `label=${LABEL}`);
  assert(stragglers === '', `leftover labelled containers: ${stragglers}`);
  ok('no labelled containers left behind');
}

main().catch(async (error) => {
  fail(error instanceof Error ? error.message : String(error));
  await cleanup();
  process.exitCode = 1;
});
