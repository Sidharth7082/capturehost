import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 256 bits of entropy, base64url so it is safe in a cookie without escaping.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What we store in the database.
 *
 * The raw token only ever exists in the auth cookie; a stolen database file is
 * useless on its own because the stored value cannot be turned back into a
 * cookie. sha256 is the right tool here (not argon2): the input is already
 * high-entropy random, so there is nothing to brute force.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison for two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** 256-bit CSRF token, bound to a session row. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Short, unambiguous ids for display (session list, log lines). */
export function shortId(value: string, length = 10): string {
  return value.slice(0, length);
}
