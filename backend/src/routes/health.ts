import type { AppInstance } from '../server.js';
import type { Db } from '../db/connection.js';

export interface HealthDeps {
  db: Db;
  version: string;
  startedAt: number;
}

/**
 * GET /api/health — the only unauthenticated route in the finished system.
 * Deliberately cheap: no systeminformation calls, just a trivial DB probe.
 */
export function registerHealthRoutes(app: AppInstance, deps: HealthDeps): void {
  app.get('/api/health', async () => {
    let dbStatus: 'ok' | 'error' = 'ok';
    try {
      deps.db.prepare('SELECT 1 AS ok').get();
    } catch {
      dbStatus = 'error';
    }

    return {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      version: deps.version,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      db: dbStatus,
      timestamp: new Date().toISOString(),
    };
  });
}
