import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Every value is validated once, at boot. If something is wrong the process
 * exits with a readable message instead of failing later at 3am inside a
 * request handler.
 */

const LogLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: LogLevelSchema.default('info'),

  // Loopback only. Remote access is Tailscale or a Cloudflare Tunnel.
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),

  DB_PATH: z.string().min(1).default('./data/capturehost.db'),

  // Comma separated allowlist of origins permitted to open /ws/metrics.
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),

  METRICS_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2000),
  METRICS_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),

  // ---- auth ----
  // 32-byte key for AES-256-GCM. Base64 (44 chars) or hex (64 chars).
  APP_ENCRYPTION_KEY: z.string().min(1, 'APP_ENCRYPTION_KEY is required (openssl rand -base64 32)'),

  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  // Only true when the dashboard is served over HTTPS (Caddy, Phase 5).
  SESSION_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).max(1_048_576).default(65_536),
  ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(8).default(1),

  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(50).default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).max(120).default(10),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(120).default(15),

  // Off by default. Turn on only when a trusted proxy (Caddy, a Cloudflare
  // Tunnel) terminates TLS in front of this process, otherwise a client can
  // forge X-Forwarded-For and dodge the IP rate limit.
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: z.infer<typeof LogLevelSchema>;
  host: string;
  port: number;
  dbPath: string;
  allowedOrigins: string[];
  metricsIntervalMs: number;
  metricsRetentionHours: number;
  isProduction: boolean;

  encryptionKey: Buffer;
  session: {
    idleMs: number;
    absoluteMs: number;
    cookieName: string;
    secure: boolean;
    /** Pending-2FA sessions are short lived: they are not a login yet. */
    pendingMs: number;
  };
  argon2: {
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };
  login: {
    maxFailures: number;
    windowMs: number;
    lockoutMs: number;
  };
  trustProxy: boolean;
}

/**
 * Accepts base64 or hex and enforces exactly 32 bytes, which is what
 * AES-256-GCM requires. A silently truncated key would still "work" but with
 * less entropy, so this is a hard failure.
 */
export function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const hex = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : null;
  const key = hex ?? Buffer.from(trimmed, 'base64');

  if (key.length !== 32) {
    throw new Error(
      `APP_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** Origins are compared after normalisation so a trailing slash or caps never matters. */
export function normaliseOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const value = parsed.data;
  const allowedOrigins = value.ALLOWED_ORIGINS.split(',')
    .map(normaliseOrigin)
    .filter((origin) => origin.length > 0);

  if (allowedOrigins.length === 0) {
    throw new Error('ALLOWED_ORIGINS must contain at least one origin');
  }

  const secure = value.SESSION_COOKIE_SECURE;
  // The __Host- prefix is only valid with Secure + Path=/ + no Domain, and it
  // stops a subdomain from setting a cookie that shadows ours.
  const cookieName = secure ? '__Host-capturehost_sid' : 'capturehost_sid';
  if (value.NODE_ENV === 'production' && value.HOST !== '127.0.0.1') {
    // Loud warning, not a hard failure: the operator may be behind a tunnel
    // that terminates locally and still needs a non-loopback bind.
    console.warn(
      '[config] HOST is not 127.0.0.1 in production. CaptureHost expects loopback only; ' +
        'expose it with Tailscale or a Cloudflare Tunnel instead.',
    );
  }

  return {
    nodeEnv: value.NODE_ENV,
    logLevel: value.LOG_LEVEL,
    host: value.HOST,
    port: value.PORT,
    dbPath: value.DB_PATH,
    allowedOrigins,
    metricsIntervalMs: value.METRICS_INTERVAL_MS,
    metricsRetentionHours: value.METRICS_RETENTION_HOURS,
    isProduction: value.NODE_ENV === 'production',

    encryptionKey: parseEncryptionKey(value.APP_ENCRYPTION_KEY),
    session: {
      idleMs: value.SESSION_IDLE_MINUTES * 60_000,
      absoluteMs: value.SESSION_ABSOLUTE_HOURS * 60 * 60_000,
      pendingMs: 5 * 60_000,
      cookieName,
      secure,
    },
    argon2: {
      memoryCost: value.ARGON2_MEMORY_KIB,
      timeCost: value.ARGON2_TIME_COST,
      parallelism: value.ARGON2_PARALLELISM,
    },
    login: {
      maxFailures: value.LOGIN_MAX_FAILURES,
      windowMs: value.LOGIN_WINDOW_MINUTES * 60_000,
      lockoutMs: value.LOGIN_LOCKOUT_MINUTES * 60_000,
    },
    trustProxy: value.TRUST_PROXY,
  };
}
