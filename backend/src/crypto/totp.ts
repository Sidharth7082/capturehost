import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import { generateSecret, generateSync, generateURI, verifySync } from 'otplib';

export const TOTP_ISSUER = 'CaptureHost';
/** 30-second windows, as every authenticator app assumes. */
export const TOTP_PERIOD_SECONDS = 30;

export function createTotpSecret(): string {
  // otplib generates a 160-bit base32 secret by default.
  return generateSecret();
}

export function buildOtpAuthUri(secret: string, accountLabel: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label: accountLabel, secret });
}

/** Data URL so the dashboard can render the QR without any external service. */
export async function totpQrDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, {
    margin: 1,
    width: 200,
    errorCorrectionLevel: 'M',
    color: { dark: '#0b0d14ff', light: '#ffffffff' },
  });
}

export interface TotpCheck {
  valid: boolean;
  /** The 30 s counter the code belonged to — stored to block replay. */
  timeStep: number | null;
}

/**
 * Verifies a 6-digit code.
 *
 * `afterTimeStep` is otplib's replay guard: any code from a window at or
 * before the previously accepted one is refused, so a shoulder-surfed code
 * cannot be replayed inside its 30 second validity.
 * `atMs` pins the evaluation time — tests use it instead of sleeping 30 s.
 */
export function checkTotp(
  token: string,
  secret: string,
  afterTimeStep: number | null = null,
  atMs?: number,
): TotpCheck {
  const trimmed = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(trimmed)) return { valid: false, timeStep: null };

  const result = verifySync({
    token: trimmed,
    secret,
    // One window of slack in each direction: phones drift, and a user typing a
    // code that was generated 20 seconds ago should not be punished. Replay is
    // still impossible because afterTimeStep refuses anything already used.
    epochTolerance: TOTP_PERIOD_SECONDS,
    ...(atMs === undefined ? {} : { epoch: Math.floor(atMs / 1000) }),
    ...(afterTimeStep === null ? {} : { afterTimeStep }),
  });

  if (!result.valid) return { valid: false, timeStep: null };

  // The union also covers HOTP results, which carry a counter instead of a
  // time step, so narrow before reading it.
  const timeStep = 'timeStep' in result && typeof result.timeStep === 'number' ? result.timeStep : null;
  return { valid: true, timeStep };
}

/** Only used by tests and the CLI to prove a secret works. */
export function currentTotpCode(secret: string, atMs?: number): string {
  return generateSync({ secret, ...(atMs === undefined ? {} : { epoch: Math.floor(atMs / 1000) }) });
}

// Unambiguous alphabet: no 0/O/1/I/L, so a code read off paper cannot be
// mistyped into a different valid code.
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const RECOVERY_LENGTH = 8;
const RECOVERY_GROUPS = 2;

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];

  for (let index = 0; index < count; index += 1) {
    let raw = '';
    for (let char = 0; char < RECOVERY_LENGTH; char += 1) {
      raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    const groups: string[] = [];
    for (let group = 0; group < RECOVERY_GROUPS; group += 1) {
      groups.push(raw.slice(group * 4, group * 4 + 4));
    }
    codes.push(groups.join('-'));
  }

  return codes;
}

/** "k7qm 3xpa" -> "K7QM3XPA" so dashes, spaces and case never matter. */
export function normaliseRecoveryCode(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
