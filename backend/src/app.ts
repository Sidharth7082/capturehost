import websocket from '@fastify/websocket';
import type { AppConfig } from './config.js';
import type { Db } from './db/connection.js';
import { insertSample, pruneOlderThan } from './db/metrics.repo.js';
import type { Logger } from './logger.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { registerHealthRoutes } from './routes/health.js';
import { createMetricsHub, registerMetricsRoutes } from './routes/metrics.js';
import { createServer, type AppInstance } from './server.js';
import { createGpuProbe, type GpuProbe } from './services/gpu.js';
import { MetricsSampler } from './services/metrics.js';

export const APP_VERSION = '0.1.0';

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  logger: Logger;
  /** Injected in tests to simulate a machine without a GPU. */
  gpuProbe?: GpuProbe;
  /** Tests that only care about routes can disable the live sampler. */
  startSampler?: boolean;
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

  // Must be registered (and awaited) before any route with `websocket: true`.
  await app.register(websocket);

  const hub = createMetricsHub();
  const retentionMs = config.metricsRetentionHours * 60 * 60_000;

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

  registerHealthRoutes(app, { db, version: APP_VERSION, startedAt });
  registerMetricsRoutes(app, { db, sampler, config, logger }, hub);
  registerErrorHandler(app, logger);

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
    logger.info(
      { intervalMs: config.metricsIntervalMs, retentionHours: config.metricsRetentionHours },
      'metrics sampler started',
    );
  });

  app.addHook('onClose', async () => {
    sampler.stop();
    hub.clear();
  });

  return app;
}
