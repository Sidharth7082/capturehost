import type {} from '@fastify/cookie';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { AppInstance } from '../server.js';
import type { AuthContext, AuthService } from '../services/auth.js';
import { constantTimeEqual } from '../crypto/secretbox.js';
import { AppError } from '../utils/errors.js';
import { isOriginAllowed } from '../utils/origin.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only on routes the guard let through with a live session. */
    auth?: AuthContext;
  }
}

/**
 * Routes reachable without a session. Everything else under /api is closed.
 * Adding a route means adding it here deliberately (or it is protected by
 * default, which is the safe direction to fail).
 */
const PUBLIC_ROUTES = new Set([
  'GET /api/health',
  'GET /api/auth/setup-status',
  'POST /api/auth/login',
  'POST /api/auth/login/2fa',
]);

/** A pending-2FA session may only log itself out; it is not a login yet. */
const ALLOWED_WHILE_PENDING = new Set(['POST /api/auth/logout']);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthGuardDeps {
  auth: AuthService;
  allowedOrigins: readonly string[];
  cookieName: string;
  logger: Logger;
}

/**
 * Global authentication + CSRF + origin guard.
 *
 * Ordering matters and is deliberate:
 *   1. Origin check on unsafe methods (cheap, rejects cross-site writes first)
 *   2. session lookup
 *   3. public route?
 *   4. pending-2FA restrictions
 *   5. CSRF token comparison for unsafe methods
 */
export function registerAuthGuard(app: AppInstance, deps: AuthGuardDeps): void {
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || request.method === 'OPTIONS') return;

    const origin = request.headers.origin;
    if (!SAFE_METHODS.has(request.method) && origin !== undefined) {
      if (!isOriginAllowed(origin, deps.allowedOrigins)) {
        deps.logger.warn({ origin, path }, 'rejected cross-origin state change');
        throw AppError.forbidden('Origin not allowed');
      }
    }

    const cookie = request.cookies[deps.cookieName];
    const auth = deps.auth.authenticate(cookie);
    if (auth) request.auth = auth;

    if (PUBLIC_ROUTES.has(`${request.method} ${path}`)) return;

    if (!auth) throw new AppError(401, 'unauthenticated', 'Authentication required');

    if (auth.kind === 'pending_2fa' && !ALLOWED_WHILE_PENDING.has(`${request.method} ${path}`)) {
      throw new AppError(401, 'two_factor_required', 'Two-factor code required');
    }

    if (!SAFE_METHODS.has(request.method)) {
      const header = request.headers['x-csrf-token'];
      const sent = Array.isArray(header) ? header[0] : header;

      if (typeof sent !== 'string' || !constantTimeEqual(sent, auth.csrfToken)) {
        deps.logger.warn({ path, method: request.method }, 'csrf token missing or wrong');
        throw AppError.forbidden('Invalid CSRF token');
      }
    }
  });
}

/** Reading request.auth in a route: the guard has already proven it exists. */
export function requireAuth(request: { auth?: AuthContext }): AuthContext {
  // 'unauthenticated' is reserved for "no valid session". A failed action that
  // also uses 401 (wrong password, bad TOTP code) must NOT carry this code, or
  // the client would log the user out for a typo.
  if (!request.auth) throw new AppError(401, 'unauthenticated', 'Authentication required');
  return request.auth;
}

export type UpgradeResult =
  | { ok: true; session: AuthContext }
  | { ok: false; reason: 'origin' | 'unauthenticated' };

export interface UpgradeDeps {
  config: AppConfig;
  auth: AuthService;
  logger: Logger;
}

/**
 * Shared authorisation for WebSocket upgrades.
 *
 * Every socket gets the same two questions, in this order:
 *   1. Which page opened this? (Origin allowlist — browsers send it, and the
 *      same-origin policy does not apply to WebSockets)
 *   2. Who is behind it? (session cookie — httpOnly, so a script cannot forge
 *      one, but the browser will attach a real one to any page on this origin)
 *
 * Callers close the socket themselves so the reason can be logged next to the
 * route that refused it.
 */
export function authenticateUpgrade(
  request: {
    headers: { origin?: string };
    cookies: Record<string, string | undefined>;
  },
  deps: UpgradeDeps,
): UpgradeResult {
  const origin = request.headers.origin;

  if (!isOriginAllowed(origin, deps.config.allowedOrigins)) {
    deps.logger.warn({ origin: origin ?? null }, 'rejected websocket: origin not allowed');
    return { ok: false, reason: 'origin' };
  }

  const session = deps.auth.authenticate(request.cookies[deps.config.session.cookieName]);

  if (!session || session.kind !== 'full') {
    deps.logger.warn({ origin: origin ?? null }, 'rejected websocket: unauthenticated');
    return { ok: false, reason: 'unauthenticated' };
  }

  return { ok: true, session };
}
