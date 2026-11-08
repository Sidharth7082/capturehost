import { describe, expect, it } from 'vitest';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../src/crypto/password.js';
import { SecretDecryptionError, decryptString, encryptString } from '../src/crypto/secretbox.js';
import { currentTotpCode, generateRecoveryCodes, normaliseRecoveryCode } from '../src/crypto/totp.js';
import { getAdmin } from '../src/db/auth.repo.js';
import { AuthService } from '../src/services/auth.js';
import { AppError } from '../src/utils/errors.js';
import {
  createMemoryDb,
  seedAdmin,
  silentLogger,
  testConfig,
  TEST_PASSWORD,
  TEST_USERNAME,
} from './helpers.js';

const META = { ip: '127.0.0.1', userAgent: 'vitest' };

interface Harness {
  db: ReturnType<typeof createMemoryDb>;
  service: AuthService;
  config: ReturnType<typeof testConfig>;
  /** Moves the injectable clock forward. */
  advance: (ms: number) => void;
  nowMs: () => number;
}

async function setup(options: { seeded?: boolean } = {}): Promise<Harness> {
  const db = createMemoryDb();
  const config = testConfig();

  if (options.seeded !== false) await seedAdmin(db);

  let current = Date.now();
  const service = new AuthService({ db, config, logger: silentLogger, now: () => current });

  return {
    db,
    service,
    config,
    advance: (ms) => {
      current += ms;
    },
    nowMs: () => current,
  };
}

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword(TEST_PASSWORD, testConfig().argon2);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPassword(hash, TEST_PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong-password-123')).resolves.toBe(false);
  });

  it('treats a corrupt hash as a failed login instead of throwing', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('enforces the password policy', () => {
    expect(checkPasswordStrength('short')?.message).toMatch(/at least 12/);
    expect(checkPasswordStrength('password1234')?.message).toMatch(/too common/);
    expect(checkPasswordStrength('adminadmin123', 'admin')?.message).toMatch(/username/);
    expect(checkPasswordStrength('aaaaaaaaaaaaa')?.message).toMatch(/repeated/);
    expect(checkPasswordStrength('fixture-password-do-not-use-42')).toBeNull();
  });
});

describe('secretbox', () => {
  const key = Buffer.alloc(32, 3);

  it('round-trips a secret', () => {
    const payload = encryptString('JBSWY3DPEHPK3PXP', key, 'admin.totp_secret');
    expect(payload).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptString(payload, key, 'admin.totp_secret')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses a different key or a different context', () => {
    const payload = encryptString('secret-value', key, 'admin.totp_secret');
    expect(() => decryptString(payload, Buffer.alloc(32, 9), 'admin.totp_secret')).toThrow(SecretDecryptionError);
    expect(() => decryptString(payload, key, 'project.env_var')).toThrow(SecretDecryptionError);
  });

  it('uses a fresh IV each time', () => {
    const a = encryptString('same', key, 'ctx');
    const b = encryptString('same', key, 'ctx');
    expect(a).not.toBe(b);
  });
});

describe('login', () => {
  it('issues a working session for the right password', async () => {
    const { service } = await setup();
    const result = await service.login(TEST_USERNAME, TEST_PASSWORD, META);

    expect(result.requires2fa).toBe(false);
    expect(result.username).toBe(TEST_USERNAME);
    expect(result.csrfToken.length).toBeGreaterThan(20);

    const session = service.authenticate(result.token);
    expect(session).not.toBeNull();
    expect(session?.kind).toBe('full');
  });

  it('refuses a wrong password with the same message as an unknown user', async () => {
    const harness = await setup();

    const wrongPassword = await harness.service
      .login(TEST_USERNAME, 'wrong-password-123', META)
      .catch((error: unknown) => error);
    const unknownUser = await harness.service
      .login('nobody', TEST_PASSWORD, META)
      .catch((error: unknown) => error);

    expect(wrongPassword).toBeInstanceOf(AppError);
    expect(unknownUser).toBeInstanceOf(AppError);
    expect((wrongPassword as AppError).message).toBe('Invalid username or password');
    expect((unknownUser as AppError).message).toBe('Invalid username or password');
    expect((wrongPassword as AppError).statusCode).toBe(401);
    expect((unknownUser as AppError).statusCode).toBe(401);
  });

  it('accepts the username in any case', async () => {
    // `Sid` failing where `sid` works looks exactly like a wrong password, burns a
    // login attempt and, five of them, locks the IP out.
    for (const typed of ['Admin', 'ADMIN', 'aDmIn']) {
      const harness = await setup();
      const result = await harness.service.login(typed, TEST_PASSWORD, META);

      expect(result.requires2fa).toBe(false);
      // The stored name is what the session and the audit log carry, not the typing.
      expect(result.username).toBe(TEST_USERNAME);
      expect(harness.service.authenticate(result.token)?.kind).toBe('full');
    }
  });

  it('counts mixed-case failures in the single lowercase lockout bucket', async () => {
    const harness = await setup();
    await harness.service.login('AdMiN', 'wrong-password-123', META).catch(() => undefined);

    const rows = harness.db
      .prepare('SELECT kind, key, failures FROM login_attempts ORDER BY kind, key')
      .all();

    expect(rows).toEqual([
      { kind: 'ip', key: '127.0.0.1', failures: 1 },
      { kind: 'username', key: TEST_USERNAME, failures: 1 },
    ]);
  });

  it('does the same work for an unknown user (timing parity)', async () => {
    const harness = await setup();

    const time = async (fn: () => Promise<unknown>): Promise<number> => {
      const start = performance.now();
      await fn().catch(() => undefined);
      return performance.now() - start;
    };

    const known = await time(() => harness.service.login(TEST_USERNAME, 'wrong-password-123', META));
    const unknown = await time(() => harness.service.login('nobody', 'wrong-password-123', META));

    // Both paths must run a real argon2 verify. With these params that is tens
    // of milliseconds; an "unknown user" short-circuit would be ~0.
    expect(known).toBeGreaterThan(5);
    expect(unknown).toBeGreaterThan(5);
    // And they must be in the same ballpark (generous: 4x).
    expect(Math.max(known, unknown) / Math.max(1, Math.min(known, unknown))).toBeLessThan(4);
  });

  it('records an audit entry for a failed login without storing the password', async () => {
    const harness = await setup();
    await harness.service.login(TEST_USERNAME, 'wrong-password-123', META).catch(() => undefined);

    const rows = harness.db
      .prepare("SELECT action, actor, detail, success FROM audit_log WHERE action = 'auth.login_failed'")
      .all() as { action: string; actor: string; detail: string; success: number }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe(TEST_USERNAME);
    expect(rows[0]?.success).toBe(0);
    expect(JSON.stringify(rows[0])).not.toContain('wrong-password-123');
  });
});

describe('sessions', () => {
  it('expires on idle timeout', async () => {
    const harness = await setup();
    const { token } = await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);

    expect(harness.service.authenticate(token)).not.toBeNull();

    harness.advance(harness.config.session.idleMs + 1000);
    expect(harness.service.authenticate(token)).toBeNull();
  });

  it('expires at the absolute lifetime even while active', async () => {
    const harness = await setup();
    const { token } = await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);

    // Stay active: half an idle window at a time.
    const step = harness.config.session.idleMs / 2;
    const total = harness.config.session.absoluteMs / step;

    for (let index = 0; index < total + 1; index += 1) {
      harness.advance(step);
      const session = harness.service.authenticate(token);
      if (session === null) break;
    }

    expect(harness.service.authenticate(token)).toBeNull();
  });

  it('stores only a hash of the token', async () => {
    const harness = await setup();
    const { token } = await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);

    const rows = harness.db.prepare('SELECT id FROM sessions').all() as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(token);
    expect((rows[0]?.id ?? '').length).toBe(64); // sha256 hex
  });

  it('deletes the row on logout', async () => {
    const harness = await setup();
    const { token } = await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);
    const session = harness.service.authenticate(token);
    expect(session).not.toBeNull();

    harness.service.logout(session!.sessionId);

    expect(harness.db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 0 });
    expect(harness.service.authenticate(token)).toBeNull();
  });

  it('purges expired rows and reports their ids', async () => {
    const harness = await setup();
    await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);

    harness.advance(harness.config.session.absoluteMs + 1000);
    const purged = harness.service.purgeExpired();

    expect(purged).toHaveLength(1);
    expect(harness.db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 0 });
  });

  it('rotates the token on password change and keeps only the current session', async () => {
    const harness = await setup();
    const first = await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);
    const second = await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);

    const current = harness.service.authenticate(second.token);
    const revoked = await harness.service.changePassword(
      current!.adminId,
      current!.sessionId,
      TEST_PASSWORD,
      'another-long-password-77',
    );

    expect(revoked).toHaveLength(1);
    expect(harness.service.authenticate(first.token)).toBeNull();
    expect(harness.service.authenticate(second.token)).not.toBeNull();
  });

  it('rejects a password change with the wrong current password', async () => {
    const harness = await setup();
    const { token } = await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);
    const session = harness.service.authenticate(token);

    await expect(
      harness.service.changePassword(session!.adminId, session!.sessionId, 'nope', 'another-long-password-77'),
    ).rejects.toThrow(/Current password is incorrect/);
  });
});

describe('login rate limiting', () => {
  it('locks the account after the configured number of failures', async () => {
    const harness = await setup();
    const { maxFailures } = harness.config.login;

    for (let attempt = 0; attempt < maxFailures; attempt += 1) {
      await harness.service.login(TEST_USERNAME, 'wrong-password-123', META).catch(() => undefined);
    }

    const error = await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(429);
    expect((error as AppError).headers['retry-after']).toBeDefined();
    // Even the correct password is refused while locked.
    expect((error as AppError).message).not.toMatch(/ip|username/i);
  });

  it('locks by username across different IPs', async () => {
    const harness = await setup();

    for (let attempt = 0; attempt < harness.config.login.maxFailures; attempt += 1) {
      await harness.service
        .login(TEST_USERNAME, 'wrong-password-123', { ip: `10.0.0.${attempt}`, userAgent: 'x' })
        .catch(() => undefined);
    }

    const error = await harness.service
      .login(TEST_USERNAME, TEST_PASSWORD, { ip: '10.0.0.99', userAgent: 'x' })
      .catch((caught: unknown) => caught);

    expect((error as AppError).statusCode).toBe(429);
  });

  it('clears the counter after a successful login', async () => {
    const harness = await setup();
    await harness.service.login(TEST_USERNAME, 'wrong-password-123', META).catch(() => undefined);
    await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);

    const rows = harness.db.prepare('SELECT COUNT(*) AS c FROM login_attempts').get();
    expect(rows).toEqual({ c: 0 });
  });
});

describe('two-factor authentication', () => {
  it('enables 2FA, returns 8 recovery codes and requires a code at login', async () => {
    const harness = await setup();

    const setupResult = await harness.service.beginTotpSetup();
    expect(setupResult.uri.startsWith('otpauth://totp/')).toBe(true);
    expect(setupResult.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);

    const enabled = harness.service.confirmTotp(currentTotpCode(setupResult.secret, harness.nowMs()));
    expect(enabled.recoveryCodes).toHaveLength(8);

    const admin = getAdmin(harness.db);
    expect(admin?.totp_enabled).toBe(1);
    // The secret must be encrypted at rest, never the raw base32 value.
    expect(admin?.totp_secret).not.toBe(setupResult.secret);
    expect(admin?.totp_secret).toContain('v1.');

    const login = await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);
    expect(login.requires2fa).toBe(true);

    const pending = harness.service.authenticate(login.token);
    expect(pending?.kind).toBe('pending_2fa');

    // Authenticator apps roll over every 30 s; the enrolment code is recorded
    // as used, so the next login must use the following window.
    harness.advance(30_000);
    const completed = await harness.service.completeSecondFactor(
      pending!,
      currentTotpCode(setupResult.secret, harness.nowMs()),
      META,
    );
    expect(completed.requires2fa).toBe(false);
    // The pre-2FA token must be dead after rotation.
    expect(harness.service.authenticate(login.token)).toBeNull();
    expect(harness.service.authenticate(completed.token)?.kind).toBe('full');
  });

  it('rejects a replayed TOTP code', async () => {
    const harness = await setup();
    const { secret } = await harness.service.beginTotpSetup();
    harness.service.confirmTotp(currentTotpCode(secret, harness.nowMs()));

    harness.advance(30_000);
    const loginCode = currentTotpCode(secret, harness.nowMs());

    const first = await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);
    await harness.service.completeSecondFactor(harness.service.authenticate(first.token)!, loginCode, META);

    const second = await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);
    const pending = harness.service.authenticate(second.token);

    // Same 30 s window, presented twice: refused.
    await expect(harness.service.completeSecondFactor(pending!, loginCode, META)).rejects.toThrow(/Invalid code/);
  });

  it('accepts a recovery code exactly once', async () => {
    const harness = await setup();
    const { secret } = await harness.service.beginTotpSetup();
    const { recoveryCodes } = harness.service.confirmTotp(currentTotpCode(secret));
    const recoveryCode = recoveryCodes[0] as string;

    const first = await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);
    await harness.service.completeSecondFactor(harness.service.authenticate(first.token)!, recoveryCode, META);

    const second = await harness.service.login(TEST_USERNAME, TEST_PASSWORD, META);
    const pending = harness.service.authenticate(second.token);

    await expect(harness.service.completeSecondFactor(pending!, recoveryCode, META)).rejects.toThrow(/Invalid code/);
    expect(harness.service.describeAdmin().recoveryCodesRemaining).toBe(7);
  });

  it('normalises recovery codes so dashes and case do not matter', () => {
    const codes = generateRecoveryCodes(2);
    const code = codes[0] as string;
    expect(normaliseRecoveryCode(code)).toBe(normaliseRecoveryCode(code.replace('-', '').toLowerCase()));
  });

  it('requires both password and code to disable 2FA', async () => {
    const harness = await setup();
    const { secret } = await harness.service.beginTotpSetup();
    harness.service.confirmTotp(currentTotpCode(secret, harness.nowMs()));

    await expect(
      harness.service.disableTotp('wrong-password-123', currentTotpCode(secret, harness.nowMs())),
    ).rejects.toThrow(/Password is incorrect/);
    await expect(harness.service.disableTotp(TEST_PASSWORD, '000000')).rejects.toThrow(/Invalid code/);

    harness.advance(30_000);
    await harness.service.disableTotp(TEST_PASSWORD, currentTotpCode(secret, harness.nowMs()));
    expect(getAdmin(harness.db)?.totp_enabled).toBe(0);
    expect(harness.service.describeAdmin().recoveryCodesRemaining).toBe(0);
  });
});
