import type { AppConfig } from '../config.js';
import {
  clearAttempts,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  createSession,
  deleteRecoveryCodes,
  deleteSession,
  deleteSessionsForAdmin,
  disableTotp,
  enableTotp,
  getAdmin,
  getAdminByUsername,
  getAttempt,
  getSession,
  insertRecoveryCodes,
  listSessions,
  recordFailure,
  recordTotpStep,
  rotateSession,
  setTotpSecret,
  touchSession,
  updateAdminPassword,
  type AdminRow,
  type NewSession,
  type SessionRow,
} from '../db/auth.repo.js';
import { writeAudit } from '../db/audit.repo.js';
import type { Db } from '../db/connection.js';
import { checkPasswordStrength, hashPassword, runDummyVerify, verifyPassword } from '../crypto/password.js';
import { decryptString, encryptString } from '../crypto/secretbox.js';
import {
  buildOtpAuthUri,
  checkTotp,
  createTotpSecret,
  generateRecoveryCodes,
  normaliseRecoveryCode,
  totpQrDataUrl,
} from '../crypto/totp.js';
import { generateCsrfToken, generateSessionToken, hashToken, shortId } from '../crypto/token.js';
import type { Logger } from '../logger.js';
import { AppError } from '../utils/errors.js';

export interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthContext {
  adminId: number;
  sessionId: string;
  csrfToken: string;
  username: string;
  kind: 'full' | 'pending_2fa';
}

export interface LoginResult {
  token: string;
  csrfToken: string;
  requires2fa: boolean;
  username: string;
}

export interface SessionDto {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

export interface AuthServiceOptions {
  db: Db;
  config: AppConfig;
  logger: Logger;
  /** Injectable clock: session expiry tests need to move time, not sleep. */
  now?: () => number;
}

/** How stale `last_seen_at` may get before we bother writing a new one. */
const TOUCH_INTERVAL_MS = 60_000;

const TOTP_CONTEXT = 'admin.totp_secret';

export class AuthService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly clock: () => number;

  constructor(options: AuthServiceOptions) {
    this.db = options.db;
    this.config = options.config;
    this.logger = options.logger;
    this.clock = options.now ?? Date.now;
  }

  isSetupComplete(): boolean {
    return getAdmin(this.db) !== null;
  }

  // ------------------------------------------------------------------ login

  async login(username: string, password: string, meta: SessionMeta): Promise<LoginResult> {
    const now = this.clock();
    const usernameKey = username.trim().toLowerCase();
    const ipKey = meta.ip ?? 'unknown';

    this.assertNotLocked('ip', ipKey, now);
    this.assertNotLocked('username', usernameKey, now);

    const admin = getAdminByUsername(this.db, username);
    // Always do the same amount of work: unknown user and wrong password must
    // be indistinguishable by timing as well as by message.
    const passwordOk = admin
      ? await verifyPassword(admin.password_hash, password)
      : (await runDummyVerify(this.config.argon2), false);

    if (!admin || !passwordOk) {
      this.registerFailure('ip', ipKey, now);
      this.registerFailure('username', usernameKey, now);
      writeAudit(this.db, {
        action: 'auth.login_failed',
        actor: usernameKey || 'unknown',
        detail: admin ? 'wrong password' : 'unknown username',
        ip: meta.ip,
        success: false,
        now,
      });
      throw AppError.unauthorized('Invalid username or password');
    }

    clearAttempts(this.db, 'ip', ipKey);
    clearAttempts(this.db, 'username', usernameKey);

    if (admin.totp_enabled === 1 && admin.totp_secret !== null) {
      const pending = this.createSessionRow(admin.id, meta, now, 'pending_2fa');
      writeAudit(this.db, {
        action: 'auth.password_ok_awaiting_2fa',
        actor: admin.username,
        ip: meta.ip,
        now,
      });
      return { token: pending.token, csrfToken: pending.csrfToken, requires2fa: true, username: admin.username };
    }

    const session = this.createSessionRow(admin.id, meta, now, 'full');
    writeAudit(this.db, { action: 'auth.login', actor: admin.username, ip: meta.ip, now });
    return { token: session.token, csrfToken: session.csrfToken, requires2fa: false, username: admin.username };
  }

  /**
   * Second factor. On success the pending token is rotated: the pre-2FA cookie
   * never becomes a full session, so a leaked password-step token is useless.
   */
  async completeSecondFactor(
    session: AuthContext,
    code: string,
    meta: SessionMeta,
  ): Promise<LoginResult> {
    if (session.kind !== 'pending_2fa') {
      throw AppError.badRequest('No pending two-factor challenge');
    }

    const now = this.clock();
    const admin = getAdmin(this.db);
    if (!admin) throw AppError.unauthorized();

    const secret = this.decryptTotpSecret(admin);
    if (secret === null) throw AppError.badRequest('Two-factor is not configured');

    const totp = checkTotp(code, secret, admin.totp_last_step, now);
    if (totp.valid) {
      if (totp.timeStep !== null) recordTotpStep(this.db, admin.id, totp.timeStep);
      const rotated = this.rotateToFullSession(session.sessionId, admin.id, meta, now);
      writeAudit(this.db, { action: 'auth.login', actor: admin.username, detail: 'totp', ip: meta.ip, now });
      return { ...rotated, requires2fa: false, username: admin.username };
    }

    // Not a TOTP code: try it as a recovery code. Single use is enforced by the
    // UPDATE ... WHERE used_at IS NULL in the repo.
    const consumed = consumeRecoveryCode(this.db, admin.id, hashToken(normaliseRecoveryCode(code)), now);
    if (consumed) {
      const rotated = this.rotateToFullSession(session.sessionId, admin.id, meta, now);
      writeAudit(this.db, { action: 'auth.recovery_used', actor: admin.username, ip: meta.ip, now });
      return { ...rotated, requires2fa: false, username: admin.username };
    }

    this.registerFailure('ip', meta.ip ?? 'unknown', now);
    writeAudit(this.db, {
      action: 'auth.totp_failed',
      actor: admin.username,
      ip: meta.ip,
      success: false,
      now,
    });
    throw AppError.unauthorized('Invalid code');
  }

  // -------------------------------------------------------------- sessions

  /** Resolves a cookie token to a live session, sliding the idle deadline. */
  authenticate(token: string | undefined): AuthContext | null {
    if (!token) return null;

    const session = getSession(this.db, hashToken(token));
    if (!session) return null;

    const now = this.clock();
    const absoluteDeadline = session.absolute_expires_at ?? session.expires_at;

    if (now >= session.expires_at || now >= absoluteDeadline) {
      deleteSession(this.db, session.id);
      return null;
    }

    if (now - session.last_seen_at > TOUCH_INTERVAL_MS) {
      touchSession(this.db, session.id, now, now + this.idleMsFor(session.kind));
    }

    const admin = getAdmin(this.db);
    if (!admin) return null;

    return {
      adminId: session.admin_id,
      sessionId: session.id,
      csrfToken: session.csrf_token,
      username: admin.username,
      kind: session.kind === 'pending_2fa' ? 'pending_2fa' : 'full',
    };
  }

  logout(sessionId: string): void {
    const session = getSession(this.db, sessionId);
    deleteSession(this.db, sessionId);
    writeAudit(this.db, {
      action: 'auth.logout',
      actor: getAdmin(this.db)?.username ?? 'admin',
      detail: shortId(sessionId),
      ip: session?.ip ?? null,
      now: this.clock(),
    });
  }

  /** Purges idle/absolute expired rows. Returns the ids so sockets can close. */
  purgeExpired(): string[] {
    const now = this.clock();
    const rows = listSessions(this.db, getAdmin(this.db)?.id ?? 1).filter(
      (session) => now >= session.expires_at || now >= (session.absolute_expires_at ?? session.expires_at),
    );

    for (const session of rows) deleteSession(this.db, session.id);
    return rows.map((session) => session.id);
  }

  listSessionDtos(currentSessionId: string): SessionDto[] {
    const admin = getAdmin(this.db);
    if (!admin) return [];

    return listSessions(this.db, admin.id)
      .filter((session) => session.kind !== 'pending_2fa')
      .map((session) => ({
        id: shortId(session.id, 16),
        current: session.id === currentSessionId,
        createdAt: session.created_at,
        lastSeenAt: session.last_seen_at,
        expiresAt: session.expires_at,
        ip: session.ip,
        userAgent: session.user_agent,
      }));
  }

  /** Accepts the short id shown in the UI and resolves it to a full session id. */
  revokeSession(currentSessionId: string, shortSessionId: string): string | null {
    const admin = getAdmin(this.db);
    if (!admin) return null;

    const target = listSessions(this.db, admin.id).find(
      (session) => shortId(session.id, 16) === shortSessionId && session.kind !== 'pending_2fa',
    );
    if (!target) throw AppError.notFound('Session not found');
    if (target.id === currentSessionId) throw AppError.badRequest('Use logout to end the current session');

    deleteSession(this.db, target.id);
    writeAudit(this.db, {
      action: 'auth.session_revoked',
      actor: admin.username,
      detail: shortSessionId,
      now: this.clock(),
    });
    return target.id;
  }

  revokeOtherSessions(currentSessionId: string): string[] {
    const admin = getAdmin(this.db);
    if (!admin) return [];

    const others = listSessions(this.db, admin.id).filter((session) => session.id !== currentSessionId);
    deleteSessionsForAdmin(this.db, admin.id, currentSessionId);

    writeAudit(this.db, {
      action: 'auth.sessions_revoked_all',
      actor: admin.username,
      detail: `${others.length} session(s)`,
      now: this.clock(),
    });
    return others.map((session) => session.id);
  }

  // --------------------------------------------------------------- password

  async changePassword(
    adminId: number,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<string[]> {
    const admin = getAdmin(this.db);
    if (!admin || admin.id !== adminId) throw AppError.unauthorized();

    if (!(await verifyPassword(admin.password_hash, currentPassword))) {
      writeAudit(this.db, {
        action: 'auth.password_change_failed',
        actor: admin.username,
        success: false,
        now: this.clock(),
      });
      throw AppError.unauthorized('Current password is incorrect');
    }

    const problem = checkPasswordStrength(newPassword, admin.username);
    if (problem) throw AppError.badRequest(problem.message);

    const hash = await hashPassword(newPassword, this.config.argon2);
    updateAdminPassword(this.db, admin.id, hash, this.clock());

    // Any other tab or device is now untrusted: the password it logged in with
    // no longer exists. Collect the ids first so their sockets can be closed.
    const others = listSessions(this.db, admin.id).filter((session) => session.id !== currentSessionId);
    deleteSessionsForAdmin(this.db, admin.id, currentSessionId);

    writeAudit(this.db, {
      action: 'auth.password_changed',
      actor: admin.username,
      detail: `${others.length} other session(s) ended`,
      now: this.clock(),
    });

    return others.map((session) => session.id);
  }

  // ------------------------------------------------------------------- totp

  async beginTotpSetup(): Promise<{ secret: string; uri: string; qrDataUrl: string }> {
    const admin = getAdmin(this.db);
    if (!admin) throw AppError.unauthorized();
    if (admin.totp_enabled === 1) throw AppError.conflict('Two-factor is already enabled');

    const secret = createTotpSecret();
    const encrypted = encryptString(secret, this.config.encryptionKey, TOTP_CONTEXT);
    setTotpSecret(this.db, admin.id, encrypted, this.clock());

    const uri = buildOtpAuthUri(secret, admin.username);
    const qrDataUrl = await totpQrDataUrl(uri);

    writeAudit(this.db, { action: 'auth.totp_setup_started', actor: admin.username, now: this.clock() });
    return { secret, uri, qrDataUrl };
  }

  confirmTotp(code: string): { recoveryCodes: string[] } {
    const admin = getAdmin(this.db);
    if (!admin) throw AppError.unauthorized();
    if (admin.totp_enabled === 1) throw AppError.conflict('Two-factor is already enabled');

    const secret = this.decryptTotpSecret(admin);
    if (secret === null) throw AppError.badRequest('Start two-factor setup first');

    const now = this.clock();
    const totp = checkTotp(code, secret, admin.totp_last_step, now);
    if (!totp.valid) {
      writeAudit(this.db, {
        action: 'auth.totp_confirm_failed',
        actor: admin.username,
        success: false,
        now: this.clock(),
      });
      throw AppError.unauthorized('Invalid code');
    }

    enableTotp(this.db, admin.id, now);
    if (totp.timeStep !== null) recordTotpStep(this.db, admin.id, totp.timeStep);

    // Fresh set of recovery codes on every enable; the plaintext is returned
    // exactly once and never stored.
    const codes = generateRecoveryCodes(8);
    deleteRecoveryCodes(this.db, admin.id);
    insertRecoveryCodes(this.db, admin.id, codes.map((code) => hashToken(normaliseRecoveryCode(code))), now);

    writeAudit(this.db, { action: 'auth.totp_enabled', actor: admin.username, detail: '8 recovery codes issued', now });
    return { recoveryCodes: codes };
  }

  async disableTotp(password: string, code: string): Promise<void> {
    const admin = getAdmin(this.db);
    if (!admin) throw AppError.unauthorized();
    if (admin.totp_enabled !== 1) throw AppError.badRequest('Two-factor is not enabled');

    if (!(await verifyPassword(admin.password_hash, password))) {
      writeAudit(this.db, {
        action: 'auth.totp_disable_failed',
        actor: admin.username,
        detail: 'wrong password',
        success: false,
        now: this.clock(),
      });
      throw AppError.unauthorized('Password is incorrect');
    }

    const secret = this.decryptTotpSecret(admin);
    const now = this.clock();
    if (secret === null || !checkTotp(code, secret, admin.totp_last_step, now).valid) {
      writeAudit(this.db, {
        action: 'auth.totp_disable_failed',
        actor: admin.username,
        detail: 'invalid code',
        success: false,
        now: this.clock(),
      });
      throw AppError.unauthorized('Invalid code');
    }

    disableTotp(this.db, admin.id, now);
    deleteRecoveryCodes(this.db, admin.id);
    writeAudit(this.db, { action: 'auth.totp_disabled', actor: admin.username, now });
  }

  // ------------------------------------------------------------------ misc

  /** Everything the shell needs to render the account area. */
  describeAdmin(): {
    username: string;
    totpEnabled: boolean;
    recoveryCodesRemaining: number;
    passwordChangedAt: number | null;
  } {
    const admin = getAdmin(this.db);
    if (!admin) throw AppError.unauthorized();

    return {
      username: admin.username,
      totpEnabled: admin.totp_enabled === 1,
      recoveryCodesRemaining: countUnusedRecoveryCodes(this.db, admin.id),
      passwordChangedAt: admin.last_password_change,
    };
  }

  cookieOptions(maxAgeSeconds: number): {
    httpOnly: true;
    sameSite: 'strict';
    secure: boolean;
    path: string;
    maxAge: number;
  } {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.session.secure,
      // __Host- requires Path=/ and no Domain attribute.
      path: '/',
      maxAge: maxAgeSeconds,
    };
  }

  idleMsFor(kind: string): number {
    return kind === 'pending_2fa' ? this.config.session.pendingMs : this.config.session.idleMs;
  }

  // --------------------------------------------------------------- private

  private createSessionRow(
    adminId: number,
    meta: SessionMeta,
    now: number,
    kind: 'full' | 'pending_2fa',
  ): { token: string; csrfToken: string; sessionId: string } {
    const token = generateSessionToken();
    const csrfToken = generateCsrfToken();
    const idleMs = this.idleMsFor(kind);

    const row: NewSession = {
      id: hashToken(token),
      adminId,
      csrfToken,
      ip: meta.ip,
      userAgent: meta.userAgent,
      createdAt: now,
      idleExpiresAt: now + idleMs,
      absoluteExpiresAt: kind === 'pending_2fa' ? now + this.config.session.pendingMs : now + this.config.session.absoluteMs,
      kind,
    };

    createSession(this.db, row);
    return { token, csrfToken, sessionId: row.id };
  }

  private rotateToFullSession(
    oldSessionId: string,
    adminId: number,
    meta: SessionMeta,
    now: number,
  ): { token: string; csrfToken: string } {
    const token = generateSessionToken();
    const csrfToken = generateCsrfToken();

    rotateSession(this.db, oldSessionId, {
      id: hashToken(token),
      adminId,
      csrfToken,
      ip: meta.ip,
      userAgent: meta.userAgent,
      createdAt: now,
      idleExpiresAt: now + this.config.session.idleMs,
      absoluteExpiresAt: now + this.config.session.absoluteMs,
      kind: 'full',
    });

    return { token, csrfToken };
  }

  private decryptTotpSecret(admin: AdminRow): string | null {
    if (admin.totp_secret === null) return null;
    try {
      return decryptString(admin.totp_secret, this.config.encryptionKey, TOTP_CONTEXT);
    } catch (error) {
      // Wrong APP_ENCRYPTION_KEY or a tampered row. Loud server log, silent
      // client: 2FA simply cannot be completed until the operator fixes it.
      this.logger.error({ err: error }, 'failed to decrypt TOTP secret');
      return null;
    }
  }

  private assertNotLocked(kind: 'ip' | 'username', key: string, now: number): void {
    const attempt = getAttempt(this.db, kind, key);
    if (attempt?.locked_until == null) return;
    if (now >= attempt.locked_until) return;

    writeAudit(this.db, {
      action: 'auth.lockout',
      actor: key,
      detail: `${kind} locked`,
      success: false,
      now,
    });
    throw AppError.loginLocked((attempt.locked_until - now) / 1000);
  }

  private registerFailure(kind: 'ip' | 'username', key: string, now: number): void {
    recordFailure(this.db, {
      kind,
      key,
      now,
      windowMs: this.config.login.windowMs,
      maxFailures: this.config.login.maxFailures,
      lockoutMs: this.config.login.lockoutMs,
    });
  }
}
