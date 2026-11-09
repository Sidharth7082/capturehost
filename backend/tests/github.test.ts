import { describe, expect, it, vi } from 'vitest';
import { createTestDb, silentLogger, testConfig } from './helpers.js';
import { GithubService } from '../src/services/github.js';
import { getIntegration } from '../src/db/integrations.repo.js';
import { AppError } from '../src/utils/errors.js';

/**
 * The GitHub client, with GitHub faked at the `fetch` boundary.
 *
 * No test in this file touches the network, and no real token is ever used: the
 * fixture string below is the only credential that exists in these tests, and
 * several assertions exist purely to prove it never escapes into storage, audit
 * rows, error messages or notifications.
 */

const TOKEN = 'github_pat_TESTFIXTURE0123456789abcdefghijklmnopqrstuvwxyz';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect?: string;
}

function harness(handlers: Array<(call: Call) => Response | undefined> = []) {
  const calls: Call[] = [];
  const notify = vi.fn(async () => ({ stored: true, delivered: false }));
  const testDb = createTestDb();
  let clock = 1_700_000_000_000;

  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const call: Call = {
      url: input,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      redirect: init.redirect,
    };
    calls.push(call);

    for (const handler of handlers) {
      const response = handler(call);
      if (response) return response;
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  const github = new GithubService({
    db: testDb.db,
    config: testConfig(),
    logger: silentLogger,
    notifications: { notify },
    fetchImpl,
    now: () => clock,
  });

  return {
    github,
    calls,
    notify,
    db: testDb.db,
    cleanup: testDb.cleanup,
    setClock: (value: number) => {
      clock = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const USER = { login: 'octocat', id: 1 };

function repoFixture(index: number) {
  return {
    full_name: `octocat/repo-${index}`,
    name: `repo-${index}`,
    description: `repository ${index}`,
    private: index % 2 === 0,
    fork: false,
    archived: false,
    default_branch: 'main',
    language: 'TypeScript',
    updated_at: '2026-11-01T10:00:00Z',
    html_url: `https://github.com/octocat/repo-${index}`,
    owner: { login: 'octocat' },
  };
}

describe('connect', () => {
  it('validates the token with GET /user, stores it encrypted, and returns no token', async () => {
    const h = harness([(call) => (call.url.endsWith('/user') ? jsonResponse(USER) : undefined)]);

    const status = await h.github.connect(TOKEN, {
      expiresAt: Date.parse('2027-01-31T00:00:00Z'),
      ctx: { actor: 'admin', ip: '127.0.0.1' },
    });

    try {
      expect(status.connected).toBe(true);
      expect(status.login).toBe('octocat');
      expect(JSON.stringify(status)).not.toContain(TOKEN);

      const row = getIntegration(h.db, 'github');
      expect(row).not.toBeNull();
      expect(row?.token_encrypted).not.toContain(TOKEN);
      expect(row?.token_encrypted.length).toBeGreaterThan(40);

      // the request was to the fixed host, over https, without following redirects
      expect(h.calls[0]?.url).toBe('https://api.github.com/user');
      expect(h.calls[0]?.redirect).toBe('error');
      expect(h.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);

      // nothing secret reached the audit log
      const audit = h.db.prepare('SELECT action, detail FROM audit_log').all() as { action: string; detail: string }[];
      expect(audit.map((row) => row.action)).toContain('github.connected');
      expect(JSON.stringify(audit)).not.toContain(TOKEN);
    } finally {
      h.cleanup();
    }
  });

  it('rejects a token GitHub refuses, and stores nothing', async () => {
    const h = harness([(call) => (call.url.endsWith('/user') ? jsonResponse({ message: 'Bad credentials' }, 401) : undefined)]);

    try {
      await expect(h.github.connect(TOKEN, { expiresAt: null, ctx: { actor: 'admin' } })).rejects.toThrow(AppError);
      expect(getIntegration(h.db, 'github')).toBeNull();

      const audit = h.db.prepare('SELECT action, detail FROM audit_log').all() as { action: string; detail: string }[];
      expect(audit.map((row) => row.action)).toContain('github.validation_failed');
      expect(JSON.stringify(audit)).not.toContain(TOKEN);

      // a rejected token is a notification, not a silent failure
      expect(h.notify).toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });

  it('refuses a malformed token before calling GitHub at all', async () => {
    const h = harness();
    try {
      await expect(h.github.connect('short', { expiresAt: null, ctx: { actor: 'admin' } })).rejects.toMatchObject({
        code: 'invalid_token_format',
      });
      expect(h.calls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('treats a /user response without a login as a bad response', async () => {
    const h = harness([(call) => (call.url.endsWith('/user') ? jsonResponse({ id: 7 }) : undefined)]);
    try {
      await expect(h.github.connect(TOKEN, { expiresAt: null, ctx: { actor: 'admin' } })).rejects.toMatchObject({
        code: 'github_bad_response',
      });
      expect(getIntegration(h.db, 'github')).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe('disconnect', () => {
  it('deletes the stored token and audits it', async () => {
    const h = harness([(call) => (call.url.endsWith('/user') ? jsonResponse(USER) : undefined)]);
    try {
      await h.github.connect(TOKEN, { expiresAt: null, ctx: { actor: 'admin' } });
      expect(h.github.disconnect({ actor: 'admin' })).toBe(true);
      expect(getIntegration(h.db, 'github')).toBeNull();
      expect(h.github.tokenForClone()).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe('listRepos', () => {
  it('uses /user/repos with paging and maps only known fields', async () => {
    const h = harness([
      (call) => (call.url.endsWith('/user') ? jsonResponse(USER) : undefined),
      (call) =>
        call.url.includes('/user/repos')
          ? jsonResponse([repoFixture(1), { ...repoFixture(2), description: null }, { nonsense: true }])
          : undefined,
    ]);

    try {
      await h.github.connect(TOKEN, { expiresAt: null, ctx: { actor: 'admin' } });
      const page = await h.github.listRepos('', 2);

      const url = new URL(h.calls.at(-1)!.url);
      expect(url.pathname).toBe('/user/repos');
      expect(url.searchParams.get('page')).toBe('2');
      expect(url.searchParams.get('per_page')).toBe('30');

      expect(page.repos).toHaveLength(2); // the malformed entry is dropped
      expect(page.repos[0]).toMatchObject({ fullName: 'octocat/repo-1', defaultBranch: 'main', language: 'TypeScript' });
      expect(page.repos[1]?.description).toBeNull();
      expect(page.cached).toBe(false);
      expect(page.totalCount).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('reports hasMore only when the page is full', async () => {
    const h = harness([
      (call) => (call.url.endsWith('/user') ? jsonResponse(USER) : undefined),
      (call) =>
        call.url.includes('/user/repos')
          ? jsonResponse(Array.from({ length: 30 }, (_, i) => repoFixture(i)))
          : undefined,
    ]);
    try {
      await h.github.connect(TOKEN, { expiresAt: null, ctx: { actor: 'admin' } });
      expect((await h.github.listRepos('', 1)).hasMore).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('searches server-side, scoped to the token account', async () => {
    const h = harness([
      (call) => (call.url.endsWith('/user') ? jsonResponse(USER) : undefined),
      (call) =>
        call.url.includes('/search/repositories')
          ? jsonResponse({ total_count: 1, items: [repoFixture(3)] })
          : undefined,
    ]);
    try {
      await h.github.connect(TOKEN, { expiresAt: null, ctx: { actor: 'admin' } });
      const page = await h.github.listRepos('api server', 1);

      const url = new URL(h.calls.at(-1)!.url);
      expect(url.pathname).toBe('/search/repositories');
      expect(url.searchParams.get('q')).toBe('api server user:octocat');
      expect(page.totalCount).toBe(1);
      expect(page.repos[0]?.fullName).toBe('octocat/repo-3');
    } finally {
      h.cleanup();
    }
  });

  it('answers from the ETag cache inside the TTL and revalidates after it', async () => {
    let repoHits = 0;
    const h = harness([
      (call) => (call.url.endsWith('/user') ? jsonResponse(USER) : undefined),
      (call) => {
        if (!call.url.includes('/user/repos')) return undefined;
        repoHits += 1;
        if (call.headers['if-none-match'] === 'W/"etag-1"') {
          return new Response(null, { status: 304, headers: { etag: 'W/"etag-1"' } });
        }
        return jsonResponse([repoFixture(1)], 200, { etag: 'W/"etag-1"' });
      },
    ]);

    try {
      await h.github.connect(TOKEN, { expiresAt: null, ctx: { actor: 'admin' } });

      const first = await h.github.listRepos('', 1);
      expect(first.cached).toBe(false);
      expect(repoHits).toBe(1);

      // inside the 60 s window: no request at all
      h.advance(30_000);
      const second = await h.github.listRepos('', 1);
      expect(second.cached).toBe(true);
      expect(repoHits).toBe(1);

      // after the window: one revalidation, 304, still served from cache
      h.advance(31_000);
      const third = await h.github.listRepos('', 1);
      expect(repoHits).toBe(2);
      expect(third.cached).toBe(true);
      expect(h.calls.at(-1)?.headers['if-none-match']).toBe('W/"etag-1"');
    } finally {
      h.cleanup();
    }
  });

  it('maps a rate-limited 403 to a 429 that says when to retry', async () => {
    const h = harness([
      (call) => (call.url.endsWith('/user') ? jsonResponse(USER) : undefined),
      () =>
        jsonResponse(
          { message: 'API rate limit exceeded' },
          403,
          { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(1_700_000_000_000 / 1000) + 120) },
        ),
    ]);

    try {
      await h.github.connect(TOKEN, { expiresAt: null, ctx: { actor: 'admin' } });
      const error = await h.github.listRepos('', 1).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(429);
      expect((error as AppError).code).toBe('rate_limited');
      expect(Number((error as AppError).headers['retry-after'])).toBeGreaterThan(60);
      expect((error as AppError).message).toMatch(/rate limit/i);
    } finally {
      h.cleanup();
    }
  });

  it('treats a 401 as an expired connection: alerts and records the reason', async () => {
    const h = harness([
      (call) => (call.url.endsWith('/user') ? jsonResponse(USER) : undefined),
      () => jsonResponse({ message: 'Bad credentials' }, 401),
    ]);

    try {
      await h.github.connect(TOKEN, { expiresAt: null, ctx: { actor: 'admin' } });
      h.notify.mockClear();

      const error = await h.github.listRepos('', 1).catch((err: unknown) => err);
      expect((error as AppError).code).toBe('github_unauthorized');
      expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'github.token_invalid' }));
      expect(h.github.status().lastError).toMatch(/401/);
      expect(JSON.stringify(h.notify.mock.calls)).not.toContain(TOKEN);
    } finally {
      h.cleanup();
    }
  });

  it('rejects a malformed payload instead of inventing a list', async () => {
    const h = harness([
      (call) => (call.url.endsWith('/user') ? jsonResponse(USER) : undefined),
      () => new Response('<html>nope</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ]);
    try {
      await h.github.connect(TOKEN, { expiresAt: null, ctx: { actor: 'admin' } });
      await expect(h.github.listRepos('', 1)).rejects.toMatchObject({ code: 'github_bad_response' });
    } finally {
      h.cleanup();
    }
  });

  it('refuses to call GitHub at all when nothing is connected', async () => {
    const h = harness();
    try {
      await expect(h.github.listRepos('', 1)).rejects.toMatchObject({ code: 'github_not_connected' });
      expect(h.calls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

describe('hasDockerfile', () => {
  it('reports true for a 200 and false for a 404', async () => {
    const h = harness([
      (call) => (call.url.endsWith('/user') ? jsonResponse(USER) : undefined),
      (call) =>
        call.url.includes('/contents/Dockerfile')
          ? call.url.includes('without') ? jsonResponse({ message: 'Not Found' }, 404) : jsonResponse({ type: 'file' })
          : undefined,
    ]);

    try {
      await h.github.connect(TOKEN, { expiresAt: null, ctx: { actor: 'admin' } });
      expect(await h.github.hasDockerfile('octocat', 'repo-with')).toEqual({ exists: true });
      expect(await h.github.hasDockerfile('octocat', 'repo-without')).toEqual({ exists: false });
      expect(h.calls.at(-1)!.url).toContain('/repos/octocat/repo-without/contents/Dockerfile');
    } finally {
      h.cleanup();
    }
  });
});

describe('expiry', () => {
  it('notifies once per expiry date when the token is inside the warning window', async () => {
    const h = harness([(call) => (call.url.endsWith('/user') ? jsonResponse(USER) : undefined)]);
    try {
      const expiresAt = Date.parse('2026-11-20T00:00:00Z');
      h.setClock(Date.parse('2026-11-10T00:00:00Z'));

      await h.github.connect(TOKEN, { expiresAt, ctx: { actor: 'admin' } });

      expect(h.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'github.token_expiring',
          dedupeKey: expect.stringContaining('2026-11-20'),
        }),
      );
      expect(h.github.status().daysUntilExpiry).toBe(10);
      expect(JSON.stringify(h.notify.mock.calls)).not.toContain(TOKEN);
    } finally {
      h.cleanup();
    }
  });

  it('stays quiet when the expiry is far away', async () => {
    const h = harness([(call) => (call.url.endsWith('/user') ? jsonResponse(USER) : undefined)]);
    try {
      h.setClock(Date.parse('2026-11-10T00:00:00Z'));
      await h.github.connect(TOKEN, { expiresAt: Date.parse('2027-11-10T00:00:00Z'), ctx: { actor: 'admin' } });
      expect(h.notify).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });
});
