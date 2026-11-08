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
export interface ServerOptions {
  /**
   * Believe X-Forwarded-For, but only from these addresses. The dashboard sits
   * behind a loopback Caddy, so the immediate peer is 127.0.0.1; a request that
   * arrives from anywhere else keeps its own address as the rate-limit key even
   * if it sets the header.
   */
  trustProxy?: boolean;
  trustedAddresses?: readonly string[];
}

export function createServer(logger: Logger, options: ServerOptions = {}) {
  return Fastify({
    loggerInstance: logger,
    bodyLimit: 1024 * 1024,
    // We bind to loopback and are not behind a proxy we control yet, so do not
    // trust X-Forwarded-* headers (Phase 5 revisits this for Caddy).
    trustProxy: options.trustProxy
      ? (address: string) => (options.trustedAddresses ?? ['127.0.0.1']).includes(address)
      : false,
  });
}

export type AppInstance = ReturnType<typeof createServer>;
