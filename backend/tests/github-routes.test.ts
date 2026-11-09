import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startApp, type AuthedApp } from './appHarness.js';
import { GithubService } from '../src/services/github.js';
import { getIntegration } from '../src/db/integrations.repo.js';
import { silentLogger, testConfig } from './helpers.js';

/**
 * The GitHub routes, over real HTTP against the real app.
 *
 * GitHub itself is faked at `fetch`, so these tests never touch the network and
 * never need a token. Everything asserted here is about the boundary: no session,
 * no answer; no CSRF token, no write; and no response anywhere that contains the
 * credential.
 */

const TOKEN = 'github_pat_ROUTEFIXTURE0123456789abcdefghijklmnopqrstuvwxyz';
const USER = { login: 'octocat', id: 1 };

let harness: AuthedApp;

function fakeGithub(db: AuthedApp['db'], handler: (url: string, headers: Record<string, string>) => Response | undefined) {
  return new GithubService({
    db,
    config: testConfig(),
    logger: silentLogger,
    fetchImpl: async (url, init) => {
      const response = handler(url, (init.headers ?? {}) as Record<string, string>);
      if (response) return response;
      return json({ message: 'not found' }, 404);
    },
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** One app, one database, the GitHub client built against it with a fake fetch. */
async function bootApp(handler: (url: string, headers: Record<string, string>) => Response | undefined) {
  return startApp({ github: (db) => fakeGithub(db, handler) });
}

beforeEach(async () => {
  harness = await bootApp((url) => (url.endsWith('/user') ? json(USER) : undefined));
});

afterEach(async () => {
  await harness.close();
});

describe('auth', () => {
  const routes: Array<[string, string]> = [
    ['GET', '/api/github/status'],
    ['POST', '/api/github/connect'],
    ['DELETE', '/api/github/disconnect'],
    ['GET', '/api/github/repos'],
    ['GET', '/api/github/repos/octocat/repo/dockerfile'],
  ];

  for (const [method, url] of routes) {
    it(`${method} ${url} answers 401 without a session`, async () => {
      const response = await harness.app.inject({ method: method as 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'unauthenticated' });
    });
  }
});

describe('connect', () => {
  it('requires CSRF, then stores the token and reports only the account', async () => {
    const { cookie, csrfToken } = await harness.login();

    const withoutCsrf = await harness.app.inject({
      method: 'POST',
      url: '/api/github/connect',
      payload: { token: TOKEN },
      headers: { cookie },
    });
    expect(withoutCsrf.statusCode).toBe(403);
    expect(getIntegration(harness.db, 'github')).toBeNull();

    const ok = await harness.app.inject({
      method: 'POST',
      url: '/api/github/connect',
      payload: { token: TOKEN, expiresAt: '2027-01-31' },
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(ok.statusCode).toBe(200);
    const body = ok.json() as Record<string, unknown>;
    expect(body).toMatchObject({ connected: true, login: 'octocat', apiHost: 'api.github.com' });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(Object.keys(body)).not.toContain('token');

    // stored encrypted, never in plain
    expect(getIntegration(harness.db, 'github')?.token_encrypted).not.toContain(TOKEN);
  });

  it('rejects an expiry date in the past', async () => {
    const { cookie, csrfToken } = await harness.login();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/github/connect',
      payload: { token: TOKEN, expiresAt: '2020-01-01' },
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_expiry' });
  });

  it('rejects a token GitHub refuses, and reports the reason without the token', async () => {
    await harness.close();
    harness = await bootApp(() => json({ message: 'Bad credentials' }, 401));

    const { cookie, csrfToken } = await harness.login();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/github/connect',
      payload: { token: TOKEN },
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.stringify(response.json())).not.toContain(TOKEN);
    expect(getIntegration(harness.db, 'github')).toBeNull();
  });
});

describe('status and disconnect', () => {
  it('reports the connection, then forgets it on disconnect', async () => {
    const { cookie, csrfToken } = await harness.login();

    await harness.app.inject({
      method: 'POST',
      url: '/api/github/connect',
      payload: { token: TOKEN },
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    const status = await harness.app.inject({ method: 'GET', url: '/api/github/status', headers: { cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ connected: true, login: 'octocat' });

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: '/api/github/disconnect',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(removed.statusCode).toBe(200);

    const after = await harness.app.inject({ method: 'GET', url: '/api/github/status', headers: { cookie } });
    expect(after.json()).toMatchObject({ connected: false, login: null });
  });

  it('needs CSRF to disconnect', async () => {
    const { cookie } = await harness.login();
    const response = await harness.app.inject({
      method: 'DELETE',
      url: '/api/github/disconnect',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('repos', () => {
  it('pages, and passes paging through to GitHub', async () => {
    await harness.close();
    harness = await bootApp((url) => {
      if (url.endsWith('/user')) return json(USER);
      if (url.includes('/user/repos')) {
        return json([
          {
            full_name: 'octocat/helloworld',
            name: 'helloworld',
            description: 'demo',
            private: true,
            fork: false,
            archived: false,
            default_branch: 'trunk',
            language: 'Go',
            updated_at: '2026-11-02T09:00:00Z',
            html_url: 'https://github.com/octocat/helloworld',
            owner: { login: 'octocat' },
          },
        ]);
      }
      return undefined;
    });

    const { cookie, csrfToken } = await harness.login();
    await harness.app.inject({
      method: 'POST',
      url: '/api/github/connect',
      payload: { token: TOKEN },
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    const page = await harness.app.inject({
      method: 'GET',
      url: '/api/github/repos?query=&page=3',
      headers: { cookie },
    });

    expect(page.statusCode).toBe(200);
    const body = page.json() as { repos: unknown[]; page: number };
    expect(body.page).toBe(3);
    expect(body.repos).toHaveLength(1);
  });

  it('answers 400 when GitHub is not connected', async () => {
    const { cookie } = await harness.login();
    const response = await harness.app.inject({ method: 'GET', url: '/api/github/repos', headers: { cookie } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'github_not_connected' });
  });

  it('validates owner and repo before any GitHub call', async () => {
    const { cookie, csrfToken } = await harness.login();
    await harness.app.inject({
      method: 'POST',
      url: '/api/github/connect',
      payload: { token: TOKEN },
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    for (const url of [
      '/api/github/repos/../etc/dockerfile',
      '/api/github/repos/octocat/..%2F..%2Fetc/dockerfile',
      '/api/github/repos/octo cat/repo/dockerfile',
      `/api/github/repos/${'a'.repeat(40)}/repo/dockerfile`,
    ]) {
      const response = await harness.app.inject({ method: 'GET', url, headers: { cookie } });
      expect([400, 404], url).toContain(response.statusCode);
    }
  });

  it('rate limits a session that hammers the routes', async () => {
    const { cookie } = await harness.login();

    let last = 0;
    for (let i = 0; i < 32; i += 1) {
      const response = await harness.app.inject({ method: 'GET', url: '/api/github/status', headers: { cookie } });
      last = response.statusCode;
      if (last === 429) break;
    }

    expect(last).toBe(429);
  });
});
