import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import Docker from 'dockerode';
import type { AppConfig } from './config.js';
import type { Db } from './db/connection.js';
import { insertSample, pruneOlderThan } from './db/metrics.repo.js';
import type { Logger } from './logger.js';
import { registerAuthGuard } from './middleware/auth.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDockerRoutes } from './routes/docker.js';
import { registerHealthRoutes } from './routes/health.js';
import { createMetricsHub, registerMetricsRoutes } from './routes/metrics.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerWebhookRoutes } from './routes/webhook.js';
import { createServer, type AppInstance } from './server.js';
import { AuthService } from './services/auth.js';
import { DeploymentService } from './services/deployments.js';
import { DockerService } from './services/docker.js';
import { DockerStatsPoller } from './services/dockerStats.js';
import { createGpuProbe, type GpuProbe } from './services/gpu.js';
import { LogHub } from './services/logHub.js';
import { MetricsSampler } from './services/metrics.js';
import { SocketRegistry } from './services/socketRegistry.js';
import { SessionRateLimiter } from './utils/rateLimit.js';

export const APP_VERSION = '0.1.0';

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  logger: Logger;
  /** Injected in tests to simulate a machine without a GPU. */
  gpuProbe?: GpuProbe;
  /** Tests that only care about routes can disable the live sampler. */
  startSampler?: boolean;
  /** Injected in tests: a stub with the DockerService surface. */
  dockerService?: DockerService;
  /** Injected in tests: a stub pipeline that records enqueues instead of building. */
  deploymentService?: DeploymentService;
}

/**
 * Builds the Fastify instance but never calls listen().
 *
 * This split is what makes the routes testable with `app.inject()`: no port is
 * bound, so tests cannot collide and nothing leaks between suites.
 */
export async function buildApp(options: BuildAppOptions): Promise<AppInstance> {
  const { config, db, logger } = options;
  const startedAt = Date.now();

  const app = createServer(logger);

  /**
   * The webhook needs the RAW body to verify its HMAC. Fastify parses JSON
   * before any handler runs, so that one path keeps the buffer and everything
   * else gets the normal parsed object. Fastify's bodyLimit still applies
   * before this parser is called.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: config.webhook.maxBodyBytes },
    (request, body, done) => {
      if ((request.url ?? '').startsWith('/api/webhooks/github/')) {
        done(null, body);
        return;
      }
      try {
        done(null, JSON.parse((body as Buffer).toString('utf8')));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  // Must be registered (and awaited) before any route with `websocket: true`.
  await app.register(websocket);
  await app.register(cookie);

  // Security headers. The dashboard's HTML is served by Vite/Caddy in later
  // phases; these headers cover API responses and, once Caddy proxies through,
  // the app shell as well.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React sets inline style attributes (CSS custom properties on charts),
        // which cannot be hashed; this is the one concession.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  // CORS is only for the split dev setup (5173 -> 8787). Credentials are
  // allowed solely for the configured origins, never `*`.
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) return callback(null, false);
      const allowed = config.allowedOrigins.some((entry) => entry === origin.toLowerCase().replace(/\/+$/, ''));
      return callback(null, allowed);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token'],
    maxAge: 600,
  });

  const hub = createMetricsHub();
  const retentionMs = config.metricsRetentionHours * 60 * 60_000;

  const registry = new SocketRegistry();
  const auth = new AuthService({ db, config, logger });
  const docker = options.dockerService ?? new DockerService({ config, logger });
  const statsPoller = new DockerStatsPoller({
    docker,
    intervalMs: config.docker.statsIntervalMs,
    logger,
  });
  // Actions (start/stop/restart/remove) are budgeted per session.
  const dockerActions = new SessionRateLimiter(config.docker.actionsPerMinute);

  // Deploys are slower and heavier than container actions, so they get their
  // own, smaller budget.
  const deployActions = new SessionRateLimiter(config.deploy.actionsPerMinute);
  const webhookLimiter = new SessionRateLimiter(30);

  const logHub = new LogHub();
  const deployments =
    options.deploymentService ??
    new DeploymentService({
      db,
      config,
      logger,
      client: docker.rawClient?.() ?? new Docker({ host: config.docker.hostUrl.replace(/^tcp:\/\//, '') }),
      onLog: (deploymentId, line) => logHub.publish(deploymentId, line),
    });

  const sampler = new MetricsSampler({
    intervalMs: config.metricsIntervalMs,
    retentionHours: config.metricsRetentionHours,
    gpuProbe: options.gpuProbe ?? createGpuProbe(),
    logger,
    onSample: (snapshot) => {
      try {
        insertSample(db, snapshot);
      } catch (error) {
        // A failed write must not break the live stream.
        logger.error({ err: error }, 'failed to persist metrics sample');
      }
      hub.broadcast(snapshot);
    },
  });

  sampler.setPruneHandler(() => {
    try {
      const removed = pruneOlderThan(db, Date.now() - retentionMs);
      if (removed > 0) logger.debug({ removed }, 'pruned old metrics');
    } catch (error) {
      logger.error({ err: error }, 'failed to prune metrics');
    }
  });

  // The guard is registered before any route so every /api route is covered
  // by default. New endpoints are protected unless explicitly listed as public.
  registerAuthGuard(app, {
    auth,
    allowedOrigins: config.allowedOrigins,
    cookieName: config.session.cookieName,
    logger,
  });

  registerHealthRoutes(app, { db, version: APP_VERSION, startedAt });
  registerAuthRoutes(app, { auth, registry, cookieName: config.session.cookieName });
  registerAuditRoutes(app, { db });
  registerMetricsRoutes(app, { db, sampler, config, logger, auth, registry }, hub);
  registerDockerRoutes(app, {
    docker,
    statsPoller,
    statsIntervalMs: config.docker.statsIntervalMs,
    registry,
    db,
    actions: dockerActions,
    config,
    auth,
    logger,
  });
  registerProjectRoutes(app, {
    db,
    config,
    auth,
    logger,
    deployments,
    docker,
    registry,
    logHub,
    actions: deployActions,
  });
  registerWebhookRoutes(app, { db, config, logger, deployments, ipLimiter: webhookLimiter });
  registerErrorHandler(app, logger);

  let sessionPurgeTimer: NodeJS.Timeout | null = null;

  app.addHook('onReady', async () => {
    if (options.startSampler === false) return;

    // Clean up whatever survived the last run before the first new sample.
    try {
      const removed = pruneOlderThan(db, Date.now() - retentionMs);
      if (removed > 0) logger.info({ removed }, 'pruned metrics older than retention window');
    } catch (error) {
      logger.error({ err: error }, 'failed to prune metrics at startup');
    }

    sampler.start();

    // Expired sessions are removed on a timer, not only when someone happens
    // to present the token, so a stolen cookie cannot sit idle in the table.
    sessionPurgeTimer = setInterval(() => {
      try {
        const expired = auth.purgeExpired();
        if (expired.length > 0) {
          registry.closeSessions(expired, 'session expired');
          logger.debug({ count: expired.length }, 'purged expired sessions');
        }
      } catch (error) {
        logger.error({ err: error }, 'session purge failed');
      }
    }, 60_000);
    sessionPurgeTimer.unref?.();

    logger.info(
      { intervalMs: config.metricsIntervalMs, retentionHours: config.metricsRetentionHours },
      'metrics sampler started',
    );
  });

  app.addHook('onClose', async () => {
    sampler.stop();
    statsPoller.stop();
    if (sessionPurgeTimer) clearInterval(sessionPurgeTimer);
    hub.clear();
  });

  return app;
}
