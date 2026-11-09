import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { writeAudit } from '../db/audit.repo.js';
import { requireAuth } from '../middleware/auth.js';
import type { AppInstance } from '../server.js';
import type { GithubService } from '../services/github.js';
import { AppError } from '../utils/errors.js';
import { resolveClientIp } from '../utils/clientIp.js';
import type { SessionRateLimiter } from '../utils/rateLimit.js';

/**
 * GitHub integration routes.
 *
 * Read-only against GitHub (the service only issues GETs), session-required
 * against the dashboard, and write-only for the credential: no response here ever
 * carries a token.
 *
 * CSRF is handled by the global hook — these are unsafe methods, so the
 * `x-csrf-token` header and Origin check apply without anything route-specific.
 */

/** `YYYY-MM-DD`, optionally `null`. Anything else is a 400. */
const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Not a real date');

const ConnectSchema = z.object({
  token: z.string().min(20, 'That is too short to be a token').max(255),
  /** Optional: GitHub does not tell us, so the operator may record it. */
  expiresAt: DateSchema.nullish(),
});

const QuerySchema = z.object({
  query: z.string().max(100).optional().default(''),
  page: z.coerce.number().int().min(1).max(100).optional().default(1),
});

const OwnerSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'Invalid owner');
const RepoSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, 'Invalid repository name')
  .refine((value) => value !== '.' && value !== '..', 'Invalid repository name');

export interface GithubRoutesDeps {
  db: Db;
  github: GithubService;
  /** Per-session budget for the routes that talk to GitHub. */
  limiter: SessionRateLimiter;
  /** Same trusted loopback list the rest of the app uses. */
  trustedAddresses: readonly string[];
}

export function registerGithubRoutes(app: AppInstance, deps: GithubRoutesDeps): void {
  const clientIp = (request: {
    socket: { remoteAddress?: string };
    headers: Record<string, string | string[] | undefined>;
  }): string =>
    resolveClientIp({
      peer: request.socket.remoteAddress,
      cfConnectingIp: request.headers['cf-connecting-ip'],
      trustedAddresses: deps.trustedAddresses,
    });

  const consume = (sessionId: string, action: string): void => {
    const result = deps.limiter.consume(sessionId);
    if (result.allowed) return;
    writeAudit(deps.db, {
      action: 'github.rate_limited',
      actor: 'session',
      target: action,
      detail: 'per-session budget exhausted',
      success: false,
    });
    throw new AppError(429, 'rate_limited', 'Too many GitHub requests. Wait a moment.', {
      'retry-after': String(result.retryAfterSeconds),
    });
  };

  // -------------------------------------------------------------------- status
  app.get('/api/github/status', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'github.status');
    return deps.github.status();
  });

  // ------------------------------------------------------------------- connect
  app.post('/api/github/connect', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'github.connect');

    const body = ConnectSchema.parse(request.body);
    const expiresAt = body.expiresAt ? Date.parse(`${body.expiresAt}T00:00:00Z`) : null;

    if (expiresAt !== null && expiresAt < Date.now()) {
      throw AppError.badRequest('That expiry date is in the past.', 'invalid_expiry');
    }

    return deps.github.connect(body.token, {
      expiresAt,
      ctx: { actor: session.username, ip: clientIp(request) },
    });
  });

  // ---------------------------------------------------------------- disconnect
  app.delete('/api/github/disconnect', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'github.disconnect');

    const removed = deps.github.disconnect({ actor: session.username, ip: clientIp(request) });
    return { connected: false, removed };
  });

  // -------------------------------------------------------------------- repos
  app.get('/api/github/repos', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'github.repos');

    const { query, page } = QuerySchema.parse(request.query ?? {});
    return deps.github.listRepos(query, page);
  });

  // ---------------------------------------------------------------- dockerfile
  app.get('/api/github/repos/:owner/:repo/dockerfile', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'github.dockerfile');

    const params = (request as unknown as { params: Record<string, unknown> }).params;
    const owner = OwnerSchema.parse(params.owner);
    const repo = RepoSchema.parse(params.repo);

    return deps.github.hasDockerfile(owner, repo);
  });
}
