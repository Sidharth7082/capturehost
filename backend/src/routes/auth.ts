import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import type { AppInstance } from '../server.js';
import type { AuthService, SessionMeta } from '../services/auth.js';
import type { SocketRegistry } from '../services/socketRegistry.js';
import { resolveClientIp } from '../utils/clientIp.js';
import { AppError } from '../utils/errors.js';

const LoginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024),
});

const SecondFactorSchema = z.object({
  code: z.string().trim().min(6).max(16),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
});

const TotpCodeSchema = z.object({ code: z.string().trim().min(6).max(16) });

const DisableTotpSchema = z.object({
  password: z.string().min(1).max(1024),
  code: z.string().trim().min(6).max(16),
});

const SessionParamSchema = z.object({ id: z.string().min(4).max(64) });

export interface AuthRoutesDeps {
  auth: AuthService;
  registry: SocketRegistry;
  cookieName: string;
  /**
   * Peers whose `CF-Connecting-IP` we believe (the local cloudflared, i.e.
   * loopback). Anything else keeps its own address as the lockout key.
   */
  trustedAddresses?: readonly string[];
}

function sessionMeta(request: FastifyRequest, deps: AuthRoutesDeps): SessionMeta {
  const agent = request.headers['user-agent'];
  return {
    ip: resolveClientIp({
      peer: request.socket.remoteAddress,
      cfConnectingIp: request.headers['cf-connecting-ip'],
      trustedAddresses: deps.trustedAddresses ?? ['127.0.0.1', '::1'],
    }),
    userAgent: typeof agent === 'string' ? agent.slice(0, 300) : null,
  };
}

function setSessionCookie(deps: AuthRoutesDeps, reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.setCookie(deps.cookieName, token, deps.auth.cookieOptions(maxAgeSeconds));
}

export function registerAuthRoutes(app: AppInstance, deps: AuthRoutesDeps): void {
  // ---- setup status (public) ---------------------------------------------
  // Lets the login page say "run npm run setup:admin" instead of pretending the
  // credentials were wrong on a fresh install.
  app.get('/api/auth/setup-status', async () => ({ setupComplete: deps.auth.isSetupComplete() }));

  // ---- login -------------------------------------------------------------
  app.post('/api/auth/login', async (request, reply) => {
    const body = LoginSchema.parse(request.body);

    const result = await deps.auth.login(body.username, body.password, sessionMeta(request, deps));

    const kind = result.requires2fa ? 'pending_2fa' : 'full';
    setSessionCookie(deps, reply, result.token, Math.floor(deps.auth.idleMsFor(kind) / 1000));

    return {
      requires2fa: result.requires2fa,
      username: result.username,
      csrfToken: result.csrfToken,
    };
  });

  // ---- second factor -----------------------------------------------------
  app.post('/api/auth/login/2fa', async (request, reply) => {
    const body = SecondFactorSchema.parse(request.body);
    const session = request.auth;

    if (!session) throw AppError.unauthorized('No pending login');

    const result = await deps.auth.completeSecondFactor(session, body.code, sessionMeta(request, deps));
    setSessionCookie(deps, reply, result.token, Math.floor(deps.auth.idleMsFor('full') / 1000));

    return { requires2fa: false, username: result.username, csrfToken: result.csrfToken };
  });

  // ---- logout ------------------------------------------------------------
  app.post('/api/auth/logout', async (request, reply) => {
    const session = requireAuth(request);

    deps.auth.logout(session.sessionId);
    // Any open metrics socket for this session must die with it.
    deps.registry.closeSession(session.sessionId, 'logged out');
    reply.clearCookie(deps.cookieName, { path: '/' });

    return { ok: true };
  });

  // ---- who am i ----------------------------------------------------------
  app.get('/api/auth/me', async (request) => {
    const session = requireAuth(request);
    const admin = deps.auth.describeAdmin();

    return {
      username: admin.username,
      totpEnabled: admin.totpEnabled,
      recoveryCodesRemaining: admin.recoveryCodesRemaining,
      passwordChangedAt: admin.passwordChangedAt,
      // The client keeps this in memory only and echoes it on every write.
      csrfToken: session.csrfToken,
    };
  });

  // ---- password ----------------------------------------------------------
  app.post('/api/auth/change-password', async (request) => {
    const session = requireAuth(request);
    const body = ChangePasswordSchema.parse(request.body);

    const revoked = await deps.auth.changePassword(
      session.adminId,
      session.sessionId,
      body.currentPassword,
      body.newPassword,
    );

    // Other devices are now logged out server-side; close their sockets too.
    deps.registry.closeSessions(revoked, 'password changed');
    return { ok: true, revokedSessions: revoked.length };
  });

  // ---- sessions ----------------------------------------------------------
  app.get('/api/auth/sessions', async (request) => {
    const session = requireAuth(request);
    return { sessions: deps.auth.listSessionDtos(session.sessionId) };
  });

  app.delete('/api/auth/sessions/:id', async (request) => {
    const session = requireAuth(request);
    const { id } = SessionParamSchema.parse(request.params);

    const removed = deps.auth.revokeSession(session.sessionId, id);
    if (removed) deps.registry.closeSession(removed, 'session revoked');
    return { ok: true };
  });

  app.post('/api/auth/sessions/revoke-others', async (request) => {
    const session = requireAuth(request);
    const removed = deps.auth.revokeOtherSessions(session.sessionId);
    deps.registry.closeSessions(removed, 'session revoked');
    return { ok: true, revokedSessions: removed.length };
  });

  // ---- two-factor --------------------------------------------------------
  app.post('/api/auth/2fa/setup', async (request) => {
    requireAuth(request);
    const setup = await deps.auth.beginTotpSetup();
    return setup;
  });

  app.post('/api/auth/2fa/confirm', async (request) => {
    requireAuth(request);
    const body = TotpCodeSchema.parse(request.body);
    return deps.auth.confirmTotp(body.code);
  });

  app.post('/api/auth/2fa/disable', async (request) => {
    requireAuth(request);
    const body = DisableTotpSchema.parse(request.body);
    await deps.auth.disableTotp(body.password, body.code);
    return { ok: true };
  });
}
