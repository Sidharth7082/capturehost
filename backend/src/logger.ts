import pino from 'pino';
import type { AppConfig } from './config.js';

export type Logger = pino.Logger;

/**
 * pino in production (JSON, one line per event, easy to ship),
 * pino-pretty in development (human eyes).
 */
export function createLogger(config: Pick<AppConfig, 'logLevel' | 'isProduction'>): Logger {
  if (config.isProduction) {
    return pino({ level: config.logLevel });
  }

  return pino({
    level: config.logLevel,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  });
}
