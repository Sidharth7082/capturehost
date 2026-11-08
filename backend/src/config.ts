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
  };
}
