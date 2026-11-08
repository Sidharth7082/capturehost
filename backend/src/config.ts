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

  // ---- docker ----
  // Always the socket proxy, never a raw socket path. See docker-compose.dev.yml.
  DOCKER_HOST_URL: z.string().url().default('http://127.0.0.1:2375'),
  // Must exceed the stop grace period below, or `docker stop` looks like a
  // hung connection to dockerode while Docker is still waiting for SIGTERM.
  DOCKER_TIMEOUT_MS: z.coerce.number().int().min(2000).max(120_000).default(30_000),
  DOCKER_STATS_INTERVAL_MS: z.coerce.number().int().min(1000).max(10_000).default(2500),
  // Extra container names/ids that must never be stopped from the UI. The
  // socket proxy is protected by its label; this is for anything else.
  DOCKER_PROTECTED_CONTAINERS: z.string().default('capturehost-socket-proxy'),
  DOCKER_ACTIONS_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(30),

  // ---- deployments (Phase 4) ----
  DEPLOY_DATA_DIR: z.string().default('./data/deployments'),
  DEPLOY_BUILD_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(900_000),
  DEPLOY_KEEP_IMAGES: z.coerce.number().int().min(1).max(10).default(3),
  DEPLOY_MAX_LOG_BYTES: z.coerce.number().int().min(4096).max(8_388_608).default(524_288),
  DEPLOY_MAX_CLONE_BYTES: z.coerce.number().int().min(1_048_576).default(209_715_200),
  DEPLOY_ACTIONS_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(10),
  GIT_TIMEOUT_MS: z.coerce.number().int().min(5000).max(600_000).default(120_000),

  // Hard ceilings the safety policy applies to anything we run.
  CONTAINER_MEMORY_MB_DEFAULT: z.coerce.number().int().min(64).max(16384).default(512),
  CONTAINER_MEMORY_MB_MAX: z.coerce.number().int().min(64).max(32768).default(4096),
  CONTAINER_CPU_DEFAULT: z.coerce.number().min(0.1).max(16).default(0.5),
  CONTAINER_CPU_MAX: z.coerce.number().min(0.1).max(32).default(4),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().min(16).max(4096).default(256),
  CONTAINER_PORT_RANGE_START: z.coerce.number().int().min(1024).max(65_000).default(8100),
  CONTAINER_PORT_RANGE_END: z.coerce.number().int().min(1024).max(65_500).default(8999),
  CONTAINER_NETWORK: z.string().min(1).max(64).default('capturehost-apps'),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(2000).max(120_000).default(30_000),
  WEBHOOK_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(10_485_760).default(1_048_576),

  // ---- caddy / domains (Phase 5) ----
  /**
   * local  — hostnames under *.localhost, plain HTTP on a loopback listener.
   * tunnel — same listener; a Cloudflare Tunnel in front terminates HTTPS.
   * public — direct 80/443 with Caddy's automatic HTTPS (UNTESTED, off by default).
   */
  CADDY_MODE: z.enum(['local', 'tunnel', 'public']).default('local'),
  // Admin API is unauthenticated by design: loopback only, never exposed.
  CADDY_ADMIN_URL: z.string().url().default('http://127.0.0.1:2019'),
  // The ONLY listener deployed apps may be reached on.
  CADDY_APPS_LISTEN: z
    .string()
    .regex(/^127\.0\.0\.1:\d+$/, 'must be 127.0.0.1:<port>')
    .default('127.0.0.1:8080'),
  // Private dashboard listener, always separate from the apps listener.
  CADDY_DASHBOARD_HOST: z.string().min(1).max(253).default('capturehost.localhost'),
  CADDY_DASHBOARD_LISTEN: z
    .string()
    .regex(/^127\.0\.0\.1:\d+$/, 'must be 127.0.0.1:<port>')
    .default('127.0.0.1:8090'),
  CADDY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  // Desired state lives in SQLite; this is how often drift is repaired.
  CADDY_SYNC_INTERVAL_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),
  // Only hostnames ending in one of these may be attached. UI cannot change it.
  ALLOWED_BASE_DOMAINS: z.string().default('localhost'),
  // Optional public webhook gateway host (off unless set).
  WEBHOOK_PUBLIC_HOST: z.string().max(253).optional(),
  // Addresses allowed to set X-Forwarded-For (the loopback proxy only).
  TRUST_PROXY_ADDRESSES: z.string().default('127.0.0.1,::1'),

  // ---- backups (Phase 6) ----
  BACKUP_DIR: z.string().default('./data/backups'),
  // Separate key from APP_ENCRYPTION_KEY, so a leaked app key cannot decrypt
  // backups and a leaked backup key cannot decrypt env vars. Optional here so
  // the server starts without it; creating a backup then fails loudly instead.
  BACKUP_ENCRYPTION_KEY: z.string().optional(),
  BACKUP_SCHEDULE_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  BACKUP_KEEP_DAILY: z.coerce.number().int().min(1).max(90).default(7),
  BACKUP_KEEP_WEEKLY: z.coerce.number().int().min(0).max(52).default(4),
  BACKUP_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(720).default(36),

  // ---- notifications (Phase 6) ----
  NOTIFY_WEBHOOK_URL: z.string().url().optional(),
  NOTIFY_COOLDOWN_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  NOTIFY_DISK_THRESHOLD_PCT: z.coerce.number().min(50).max(99).default(90),
  NOTIFY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(15000).default(5000),

  // ---- retention (Phase 6) ----
  RETENTION_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  RETENTION_AUDIT_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  RETENTION_DEPLOY_LOG_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  RETENTION_DELIVERIES_DAYS: z.coerce.number().int().min(1).max(3650).default(14),
  RETENTION_ATTEMPTS_DAYS: z.coerce.number().int().min(1).max(3650).default(7),
  RETENTION_NOTIFICATIONS_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
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
  /** Client addresses whose X-Forwarded-For header is believed. */
  trustProxyAddresses: string[];

  docker: {
    hostUrl: string;
    timeoutMs: number;
    statsIntervalMs: number;
    protectedContainers: string[];
    actionsPerMinute: number;
  };

  deploy: {
    dataDir: string;
    buildTimeoutMs: number;
    keepImages: number;
    maxLogBytes: number;
    maxCloneBytes: number;
    actionsPerMinute: number;
    gitTimeoutMs: number;
    /** Hard limits the container safety policy enforces. */
    memoryDefaultMb: number;
    memoryMaxMb: number;
    cpuDefault: number;
    cpuMax: number;
    pidsLimit: number;
    portRangeStart: number;
    portRangeEnd: number;
    network: string;
    healthCheckTimeoutMs: number;
  };

  webhook: { maxBodyBytes: number };

  backups: {
    dir: string;
    /** 32-byte key, or null when BACKUP_ENCRYPTION_KEY is not set. */
    key: Buffer | null;
    scheduleHours: number;
    keepDaily: number;
    keepWeekly: number;
    maxAgeHours: number;
  };

  notify: {
    webhookUrl: string | null;
    cooldownMs: number;
    diskThresholdPct: number;
    timeoutMs: number;
  };

  retention: {
    intervalMs: number;
    auditDays: number;
    deployLogDays: number;
    deliveriesDays: number;
    attemptsDays: number;
    notificationsDays: number;
  };

  caddy: {
    mode: 'local' | 'tunnel' | 'public';
    adminUrl: string;
    appsListen: { host: string; port: number };
    dashboardHost: string;
    dashboardListen: { host: string; port: number };
    timeoutMs: number;
    syncIntervalMs: number;
    allowedBaseDomains: string[];
    webhookPublicHost: string | null;
  };
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

  if (/^(unix:|npipe:|\/)/i.test(value.DOCKER_HOST_URL)) {
    // The whole point of Phase 3 is that the app never holds the Docker socket.
    // Refusing to start would be hostile to an operator who knows better, so
    // this is a loud warning instead — but it must not pass silently.
    console.warn(
      '[config] DOCKER_HOST_URL points at a socket, not the socket proxy. ' +
        'Anyone who compromises the dashboard then has root on this machine. ' +
        'Use the tecnativa/docker-socket-proxy from docker-compose.dev.yml (http://127.0.0.1:2375).',
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
    trustProxyAddresses: value.TRUST_PROXY_ADDRESSES.split(',').map((entry) => entry.trim()).filter(Boolean),

    docker: {
      hostUrl: value.DOCKER_HOST_URL,
      timeoutMs: value.DOCKER_TIMEOUT_MS,
      statsIntervalMs: value.DOCKER_STATS_INTERVAL_MS,
      protectedContainers: value.DOCKER_PROTECTED_CONTAINERS.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      actionsPerMinute: value.DOCKER_ACTIONS_PER_MINUTE,
    },

    deploy: {
      dataDir: value.DEPLOY_DATA_DIR,
      buildTimeoutMs: value.DEPLOY_BUILD_TIMEOUT_MS,
      keepImages: value.DEPLOY_KEEP_IMAGES,
      maxLogBytes: value.DEPLOY_MAX_LOG_BYTES,
      maxCloneBytes: value.DEPLOY_MAX_CLONE_BYTES,
      actionsPerMinute: value.DEPLOY_ACTIONS_PER_MINUTE,
      gitTimeoutMs: value.GIT_TIMEOUT_MS,
      memoryDefaultMb: value.CONTAINER_MEMORY_MB_DEFAULT,
      memoryMaxMb: value.CONTAINER_MEMORY_MB_MAX,
      cpuDefault: value.CONTAINER_CPU_DEFAULT,
      cpuMax: value.CONTAINER_CPU_MAX,
      pidsLimit: value.CONTAINER_PIDS_LIMIT,
      portRangeStart: value.CONTAINER_PORT_RANGE_START,
      portRangeEnd: value.CONTAINER_PORT_RANGE_END,
      network: value.CONTAINER_NETWORK,
      healthCheckTimeoutMs: value.HEALTH_CHECK_TIMEOUT_MS,
    },

    webhook: { maxBodyBytes: value.WEBHOOK_MAX_BODY_BYTES },

    backups: {
      dir: value.BACKUP_DIR,
      key: value.BACKUP_ENCRYPTION_KEY ? parseEncryptionKey(value.BACKUP_ENCRYPTION_KEY) : null,
      scheduleHours: value.BACKUP_SCHEDULE_HOURS,
      keepDaily: value.BACKUP_KEEP_DAILY,
      keepWeekly: value.BACKUP_KEEP_WEEKLY,
      maxAgeHours: value.BACKUP_MAX_AGE_HOURS,
    },

    notify: {
      webhookUrl: value.NOTIFY_WEBHOOK_URL ?? null,
      cooldownMs: value.NOTIFY_COOLDOWN_MINUTES * 60_000,
      diskThresholdPct: value.NOTIFY_DISK_THRESHOLD_PCT,
      timeoutMs: value.NOTIFY_TIMEOUT_MS,
    },

    retention: {
      intervalMs: value.RETENTION_INTERVAL_MINUTES * 60_000,
      auditDays: value.RETENTION_AUDIT_DAYS,
      deployLogDays: value.RETENTION_DEPLOY_LOG_DAYS,
      deliveriesDays: value.RETENTION_DELIVERIES_DAYS,
      attemptsDays: value.RETENTION_ATTEMPTS_DAYS,
      notificationsDays: value.RETENTION_NOTIFICATIONS_DAYS,
    },

    caddy: {
      mode: value.CADDY_MODE,
      adminUrl: value.CADDY_ADMIN_URL.replace(/\/+$/, ''),
      appsListen: splitHostPort(value.CADDY_APPS_LISTEN),
      dashboardHost: value.CADDY_DASHBOARD_HOST.toLowerCase(),
      dashboardListen: splitHostPort(value.CADDY_DASHBOARD_LISTEN),
      timeoutMs: value.CADDY_REQUEST_TIMEOUT_MS,
      syncIntervalMs: value.CADDY_SYNC_INTERVAL_MS,
      allowedBaseDomains: value.ALLOWED_BASE_DOMAINS.split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
      webhookPublicHost: value.WEBHOOK_PUBLIC_HOST ? value.WEBHOOK_PUBLIC_HOST.toLowerCase() : null,
    },
  };
}

/** Splits the loopback "127.0.0.1:8080" listeners the config accepts. */
function splitHostPort(value: string): { host: string; port: number } {
  const [host, port] = value.split(':');
  return { host: host ?? '127.0.0.1', port: Number(port) };
}
