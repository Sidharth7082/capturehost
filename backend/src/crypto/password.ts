import argon2 from 'argon2';

export interface Argon2Params {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/**
 * argon2id, not argon2i/d: it is the hybrid recommended by the argon2 RFC for
 * password storage. Parameters live in config so they can be tuned per machine
 * without touching this module.
 */
export async function hashPassword(plain: string, params: Argon2Params): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  });
}

/** Never throws on a malformed hash — a corrupt row must read as "wrong password". */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * A hash of a random throwaway value, used when the username does not exist.
 *
 * Without it, "no such user" would return in ~0 ms while "wrong password"
 * takes ~100 ms, which tells an attacker which usernames are real. We verify
 * against this dummy hash instead so both paths do the same work.
 */
let dummyHashPromise: Promise<string> | null = null;

function getDummyHash(params: Argon2Params): Promise<string> {
  dummyHashPromise ??= argon2.hash(`not-a-real-password-${Date.now()}`, {
    type: argon2.argon2id,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  });
  return dummyHashPromise;
}

export async function runDummyVerify(params: Argon2Params): Promise<void> {
  const hash = await getDummyHash(params);
  await argon2.verify(hash, 'definitely-not-the-password').catch(() => false);
}

/** Test-only hook so a suite can reset the cached dummy hash between cases. */
export function resetDummyHash(): void {
  dummyHashPromise = null;
}

const MIN_PASSWORD_LENGTH = 12;

/**
 * A short deny list beats nothing, and a real breach corpus is overkill for a
 * single-user dashboard. Anything matching is refused at setup and at
 * change-password.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'password1234',
  'passw0rd',
  'qwertyuiop',
  '123456789012',
  '1234567890123',
  'letmein123456',
  'administrator',
  'changeme1234',
  'iloveyou1234',
  'welcome12345',
  'capturehost',
  'capturehost1',
  'capturehost123',
  'abc123456789',
  'monkey123456',
  'dragon123456',
  'football1234',
  'baseball1234',
  'superman1234',
  'trustno1trustno1',
]);

export interface PasswordProblem {
  message: string;
}

/** Returns the first problem found, or null when the password is acceptable. */
export function checkPasswordStrength(plain: string, username?: string): PasswordProblem | null {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return { message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (plain.length > 1024) {
    return { message: 'Password is too long' };
  }
  if (COMMON_PASSWORDS.has(plain.toLowerCase())) {
    return { message: 'That password is too common — pick something else' };
  }
  if (username && plain.toLowerCase().includes(username.toLowerCase())) {
    return { message: 'Password must not contain the username' };
  }
  if (/^(.)\1+$/.test(plain)) {
    return { message: 'Password must not be a single repeated character' };
  }
  if (!/[a-zA-Z]/.test(plain) || !/[0-9]/.test(plain)) {
    return { message: 'Password must contain both letters and numbers' };
  }
  return null;
}
