import Fastify from 'fastify';
import type { Logger } from './logger.js';

/**
 * Creates the Fastify instance with our logger type baked in.
 *
 * Why a separate factory instead of calling Fastify() inside app.ts: the
 * instance type depends on the logger we pass. Declaring it once here gives
 * every module the same `AppInstance` type, so passing the app into route
 * registrars does not fight Fastify's generic logger parameter.
 */
export function createServer(logger: Logger) {
  return Fastify({
    loggerInstance: logger,
    bodyLimit: 1024 * 1024,
    // We bind to loopback and are not behind a proxy we control yet, so do not
    // trust X-Forwarded-* headers (Phase 5 revisits this for Caddy).
    trustProxy: false,
  });
}

export type AppInstance = ReturnType<typeof createServer>;
