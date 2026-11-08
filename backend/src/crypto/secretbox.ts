import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * AES-256-GCM string encryption for secrets at rest (TOTP secrets today,
 * project env vars in Phase 4).
 *
 * Layout: v1.<iv>.<tag>.<ciphertext>, each part base64url.
 * - A fresh random IV per encryption (reusing an IV with GCM is catastrophic).
 * - The `context` string is authenticated as AAD, so a ciphertext lifted from
 *   one column cannot be replayed into another that uses a different context.
 */

const VERSION = 'v1';
const IV_BYTES = 12; // 96-bit, the GCM standard
const TAG_BYTES = 16;

export function encryptString(plain: string, key: Buffer, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export class SecretDecryptionError extends Error {
  constructor(message = 'Could not decrypt stored secret') {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

export function decryptString(payload: string, key: Buffer, context: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretDecryptionError('Unrecognised secret format');
  }

  const [, ivPart, tagPart, dataPart] = parts;
  if (!ivPart || !tagPart || !dataPart) throw new SecretDecryptionError();

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

    return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, tampered ciphertext or wrong context all land here. Do not
    // leak which one: the client must never learn anything about the key.
    throw new SecretDecryptionError();
  }
}

/** Fixed-length compare for decrypted secrets if ever needed. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
