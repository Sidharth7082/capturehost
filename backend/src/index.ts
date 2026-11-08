import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createLogger } from './logger.js';

/**
 * Entry point: config -> log -> database -> migrations -> listen.
 * Nothing else lives here on purpose; all logic is in app.ts and below.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    logger.warn(
      { host: config.host },
      'listening on a non-loopback address — expose CaptureHost through Tailscale or a Cloudflare Tunnel instead',
    );
  }

  const db = openDatabase(config.dbPath);
  const migration = migrate(db);
  logger.info(
    { applied: migration.applied, alreadyApplied: migration.alreadyApplied },
    migration.applied.length > 0 ? 'migrations applied' : 'database up to date',
  );

  const app = await buildApp({ config, db, logger });

  // SIGINT/SIGTERM -> close the server, close the db, exit cleanly.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      db.close();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  logger.info(
    { url: `http://${config.host}:${config.port}`, health: `http://${config.host}:${config.port}/api/health` },
    'CaptureHost backend ready',
  );
}

main().catch((error: unknown) => {
  // Config or startup failure: no logger guaranteed yet, so write plainly.
  console.error('Failed to start CaptureHost:', error instanceof Error ? error.message : error);
  process.exit(1);
});
