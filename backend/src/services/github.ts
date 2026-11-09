import { decryptString, encryptString } from '../crypto/secretbox.js';
import type { AppConfig } from '../config.js';
import { writeAudit } from '../db/audit.repo.js';
import type { Db } from '../db/connection.js';
import {
  deleteIntegration,
  getIntegration,
  touchIntegration,
  upsertIntegration,
  type IntegrationRow,
} from '../db/integrations.repo.js';
import type { Logger } from '../logger.js';
import { AppError } from '../utils/errors.js';
import type { NotificationService } from './notifications.js';

/**
 * GitHub integration — read-only, by construction.
 *
 * Three rules hold this together:
 *
 *  1. **One host.** Every request goes to `api.github.com` over HTTPS, built from a
 *     constant base plus a path this file writes. There is no user-supplied URL,
 *     no redirect is followed (`redirect: 'error'`), and the host is asserted
 *     again immediately before each call — a base URL that drifted could not turn
 *     this into an open proxy.
 *  2. **The token is write-only.** It is encrypted with APP_ENCRYPTION_KEY and
 *     lives in one column. It is never returned, logged, audited, put in an error
 *     message, or handed to anything except the git askpass helper.
 *  3. **No writes to GitHub.** The only methods used are GET, and the permission
 *     set the README asks for is Contents:Read + Metadata:Read.
 */

export const GITHUB_INTEGRATION_NAME = 'github';
const TOKEN_CONTEXT = 'integration.github.token';
const ALLOWED_HOST = 'api.github.com';
const CACHE_LIMIT = 100;

export interface GithubStatus {
  connected: boolean;
  login: string | null;
  /** Epoch ms. Null when the operator did not record one — GitHub does not expose it. */
  expiresAt: number | null;
  daysUntilExpiry: number | null;
  lastValidatedAt: number | null;
  /** Last failure, shown in the UI; never contains a token. */
  lastError: string | null;
  apiHost: string;
}

export interface GithubRepo {
  fullName: string;
  name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  defaultBranch: string;
  language: string | null;
  updatedAt: string | null;
  htmlUrl: string;
}

export interface RepoPage {
  repos: GithubRepo[];
  page: number;
  perPage: number;
  hasMore: boolean;
  totalCount: number | null;
  /** True when the answer came from the 60 s ETag cache. */
  cached: boolean;
}

export interface GithubAuditContext {
  actor: string;
  ip?: string | null;
}

interface CacheEntry {
  etag: string | null;
  at: number;
  page: RepoPage;
}

export interface GithubServiceDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
  notifications?: Pick<NotificationService, 'notify'>;
  /** Tests inject a fake; production uses global fetch. */
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

export class GithubService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly notifications?: Pick<NotificationService, 'notify'>;
  private readonly doFetch: (input: string, init: RequestInit) => Promise<Response>;
  private readonly now: () => number;

  private readonly cache = new Map<string, CacheEntry>();
  private lastExpiryCheckAt = 0;

  constructor(deps: GithubServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger;
    this.notifications = deps.notifications;
    this.doFetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
  }

  // ------------------------------------------------------------- integration

  /** What the UI and the doctor may see. Deliberately has no token field. */
  status(): GithubStatus {
    const row = getIntegration(this.db, GITHUB_INTEGRATION_NAME);
    const now = this.now();
    return {
      connected: row !== null,
      login: row?.login ?? null,
      expiresAt: row?.token_expires_at ?? null,
      daysUntilExpiry:
        row?.token_expires_at !== null && row?.token_expires_at !== undefined
          ? Math.ceil((row.token_expires_at - now) / 86_400_000)
          : null,
      lastValidatedAt: row?.last_validated_at ?? null,
      lastError: row?.last_error ?? null,
      apiHost: ALLOWED_HOST,
    };
  }

  /**
   * Validates a personal access token against GET /user and stores it.
   *
   * A failed validation is audited with the *reason*, never the credential, and
   * nothing is stored — a bad token never gets written to the database.
   */
  async connect(
    rawToken: string,
    options: { expiresAt: number | null; ctx: GithubAuditContext },
  ): Promise<GithubStatus> {
    const token = rawToken.trim();
    if (token.length < 20 || token.length > 255 || /\s/.test(token)) {
      this.audit('github.validation_failed', options.ctx, 'malformed token');
      throw AppError.badRequest('That does not look like a GitHub token.', 'invalid_token_format');
    }

    let login: string;
    const started = this.now();
    try {
      const response = await this.request('/user', token);
      if (!response.ok) {
        const reason = await this.describeFailure(response, token);
        this.audit('github.validation_failed', options.ctx, `GET /user answered ${response.status}`);
        throw reason;
      }
      const body = (await this.safeJson(response)) as { login?: unknown } | null;
      if (!body || typeof body.login !== 'string' || body.login === '') {
        this.audit('github.validation_failed', options.ctx, 'GET /user returned no login');
        throw new AppError(502, 'github_bad_response', 'GitHub returned an unexpected response.');
      }
      login = body.login;
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.audit('github.validation_failed', options.ctx, 'network error');
      this.logger.warn({ err: error instanceof Error ? error.message : 'unknown' }, 'github token validation failed');
      throw new AppError(502, 'github_unreachable', 'Could not reach GitHub. Check the connection and try again.');
    }

    upsertIntegration(this.db, {
      name: GITHUB_INTEGRATION_NAME,
      tokenEncrypted: encryptString(token, this.config.encryptionKey, TOKEN_CONTEXT),
      login,
      tokenExpiresAt: options.expiresAt,
      now: started,
    });

    this.cache.clear();
    this.audit('github.connected', options.ctx, `account ${login}`);
    await this.maybeNotifyExpiry();
    return this.status();
  }

  disconnect(ctx: GithubAuditContext): boolean {
    const existed = deleteIntegration(this.db, GITHUB_INTEGRATION_NAME);
    this.cache.clear();
    if (existed) this.audit('github.disconnected', ctx, 'token deleted');
    return existed;
  }

  /**
   * The token for cloning, or null when not connected.
   *
   * Callers must treat this as write-only: pass it straight to the git askpass
   * helper. It must never reach a log line, an argument list or a container.
   */
  tokenForClone(): string | null {
    const row = this.row();
    if (!row) return null;
    try {
      return decryptString(row.token_encrypted, this.config.encryptionKey, TOKEN_CONTEXT);
    } catch {
      this.logger.error({}, 'stored GitHub token could not be decrypted');
      return null;
    }
  }

  // -------------------------------------------------------------------- repos

  /**
   * One page of repositories, server-side paged and searched.
   *
   * Without a query this lists what the token can see (`/user/repos`); with one it
   * uses GitHub's search API filtered to the token's own account, because
   * `/user/repos` has no search parameter. Answers are cached for
   * `GITHUB_CACHE_TTL_MS` and revalidated with the ETag GitHub returns.
   */
  async listRepos(query: string, page: number): Promise<RepoPage> {
    const token = this.requireToken();
    const trimmed = query.trim().slice(0, 100);
    const perPage = this.config.github.perPage;
    const key = `${trimmed.toLowerCase()}|${page}`;

    const cached = this.cache.get(key);
    const now = this.now();
    if (cached && this.config.github.cacheTtlMs > 0 && now - cached.at < this.config.github.cacheTtlMs) {
      return { ...cached.page, cached: true };
    }

    const login = this.status().login ?? '';
    const search = trimmed !== '';
    const path = search
      ? `/search/repositories?q=${encodeURIComponent(`${trimmed} user:${login}`)}&per_page=${perPage}&page=${page}`
      : `/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`;

    const response = await this.request(path, token, cached?.etag ?? null);

    if (response.status === 304 && cached) {
      cached.at = now;
      return { ...cached.page, cached: true };
    }

    if (!response.ok) throw await this.describeFailure(response, token, true);

    const body = (await this.safeJson(response)) as unknown;
    const items = search
      ? (body as { items?: unknown } | null)?.items
      : body;
    if (!Array.isArray(items)) {
      throw new AppError(502, 'github_bad_response', 'GitHub returned an unexpected response.');
    }

    const result: RepoPage = {
      repos: items.map((item) => normaliseRepo(item)).filter((repo): repo is GithubRepo => repo !== null),
      page,
      perPage,
      hasMore: items.length === perPage,
      totalCount:
        search && typeof (body as { total_count?: unknown }).total_count === 'number'
          ? ((body as { total_count: number }).total_count)
          : null,
      cached: false,
    };

    this.remember(key, { etag: response.headers.get('etag'), at: now, page: result });
    await this.maybeNotifyExpiry();
    return result;
  }

  /**
   * Does this one repository have a Dockerfile at its root?
   *
   * Called only for the repo the operator selects — never across a list — so a
   * fifty-repo page costs one request, not fifty.
   */
  async hasDockerfile(owner: string, repo: string): Promise<{ exists: boolean }> {
    const token = this.requireToken();
    const response = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/Dockerfile`,
      token,
    );

    if (response.status === 404) return { exists: false };
    if (!response.ok) throw await this.describeFailure(response, token, true);

    return { exists: true };
  }

  // ------------------------------------------------------------ notifications

  /**
   * Warn once per expiry date when the recorded expiry is inside the warning
   * window. Throttled to one check per hour so a busy dashboard does not spray
   * GitHub calls; the notification service's own cooldown dedupes the alert.
   */
  async maybeNotifyExpiry(): Promise<void> {
    const now = this.now();
    if (now - this.lastExpiryCheckAt < 3_600_000) return;
    this.lastExpiryCheckAt = now;

    const row = this.row();
    if (!row?.token_expires_at) return;

    const days = Math.ceil((row.token_expires_at - now) / 86_400_000);
    if (days > this.config.github.expiryWarningDays) return;

    const when = new Date(row.token_expires_at).toISOString().slice(0, 10);
    await this.notifications?.notify({
      event: 'github.token_expiring',
      severity: days < 0 ? 'error' : 'warning',
      title: days < 0 ? 'GitHub token has expired' : `GitHub token expires in ${days} day(s)`,
      body: `The connected GitHub token (${row.login}) is set to expire on ${when}. Create a new one and reconnect it in Settings → Integrations.`,
      dedupeKey: `github.token-expires:${when}`,
    });
  }

  /** Raised when GitHub answers 401: the UI shows "reconnect", the operator gets an alert. */
  private async notifyRejected(): Promise<void> {
    touchIntegration(this.db, GITHUB_INTEGRATION_NAME, {
      lastError: 'GitHub rejected the token (401)',
    });
    await this.notifications?.notify({
      event: 'github.token_invalid',
      severity: 'error',
      title: 'GitHub token was rejected',
      body: 'GitHub answered 401 for the connected token. It was probably revoked or has expired — reconnect it in Settings → Integrations.',
      dedupeKey: 'github.token-invalid',
    });
  }

  // ------------------------------------------------------------------ plumbing

  private row(): IntegrationRow | null {
    return getIntegration(this.db, GITHUB_INTEGRATION_NAME);
  }

  private requireToken(): string {
    const token = this.tokenForClone();
    if (!token) {
      throw AppError.badRequest(
        'GitHub is not connected. Connect a token in Settings → Integrations.',
        'github_not_connected',
      );
    }
    return token;
  }

  /** One place builds a request, so the host can be asserted in one place too. */
  private request(path: string, token: string, etag: string | null = null): Promise<Response> {
    const url = `${this.config.github.apiBase}${path}`;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.host !== ALLOWED_HOST) {
      throw new AppError(500, 'github_bad_host', 'Refusing to talk to anything but api.github.com');
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'CaptureHost',
    };
    if (etag) headers['if-none-match'] = etag;

    return this.doFetch(url, {
      method: 'GET',
      headers,
      // No redirects, ever: a 30x could move the request (and the header) elsewhere.
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.github.timeoutMs),
    });
  }

  private async safeJson(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  /**
   * Turns a non-2xx answer into a message the UI can act on.
   *
   * `expose` is false for the connect flow, where a 404 means "GitHub is not
   * there" rather than "that repository does not exist".
   */
  private async describeFailure(response: Response, _token: string, expose = false): Promise<AppError> {
    const status = response.status;

    if (status === 401) {
      await this.notifyRejected();
      return new AppError(
        401,
        'github_unauthorized',
        'GitHub rejected the token. It may have expired or been revoked — reconnect it in Settings → Integrations.',
      );
    }

    const rateLimit = this.rateLimitSeconds(response);
    if (rateLimit !== null) {
      return AppError.tooManyRequests(
        `GitHub's rate limit is exhausted. Try again in ${rateLimit} seconds.`,
        { 'retry-after': String(rateLimit) },
      );
    }

    if (status === 404 && expose) {
      return AppError.notFound('GitHub did not find that repository.');
    }

    if (status === 403) {
      return new AppError(403, 'github_forbidden', 'GitHub refused the request. Check the token permissions.');
    }

    return new AppError(502, 'github_error', `GitHub answered ${status}.`);
  }

  /** Seconds until GitHub's reset window, or null when this is not a rate limit. */
  private rateLimitSeconds(response: Response): number | null {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    const retryAfter = response.headers.get('retry-after');

    if (response.status !== 403 && response.status !== 429) return null;
    if (response.status === 403 && remaining !== '0') return null;

    if (retryAfter !== null && /^\d+$/.test(retryAfter)) return Math.max(1, Number(retryAfter));
    if (reset !== null && /^\d+$/.test(reset)) {
      return Math.max(1, Number(reset) - Math.floor(this.now() / 1000));
    }
    return 60;
  }

  private remember(key: string, entry: CacheEntry): void {
    this.cache.set(key, entry);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
  }

  /** Audit rows carry the reason and the account, never the credential. */
  private audit(action: string, ctx: GithubAuditContext, detail: string): void {
    writeAudit(this.db, {
      action,
      actor: ctx.actor,
      target: GITHUB_INTEGRATION_NAME,
      detail,
      ip: ctx.ip ?? null,
      success: !action.endsWith('_failed'),
    });
  }
}

function normaliseRepo(value: unknown): GithubRepo | null {
  if (value === null || typeof value !== 'object') return null;
  const repo = value as Record<string, unknown>;
  if (typeof repo.full_name !== 'string' || typeof repo.name !== 'string') return null;
  if (!repo.owner || typeof repo.owner !== 'object') return null;
  const owner = (repo.owner as Record<string, unknown>).login;
  if (typeof owner !== 'string') return null;

  return {
    fullName: repo.full_name,
    name: repo.name,
    description: typeof repo.description === 'string' ? repo.description : null,
    private: repo.private === true,
    fork: repo.fork === true,
    archived: repo.archived === true,
    defaultBranch: typeof repo.default_branch === 'string' && repo.default_branch !== '' ? repo.default_branch : 'main',
    language: typeof repo.language === 'string' ? repo.language : null,
    updatedAt: typeof repo.updated_at === 'string' ? repo.updated_at : null,
    htmlUrl: typeof repo.html_url === 'string' ? repo.html_url : `https://github.com/${repo.full_name}`,
  };
}
