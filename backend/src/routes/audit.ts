import { z } from 'zod';
import { listAudit } from '../db/audit.repo.js';
import type { Db } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import type { AppInstance } from '../server.js';

const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export interface AuditRoutesDeps {
  db: Db;
}

/** GET /api/audit — paginated, newest first. Auth is enforced by the guard. */
export function registerAuditRoutes(app: AppInstance, deps: AuditRoutesDeps): void {
  app.get('/api/audit', async (request) => {
    requireAuth(request);
    const { limit, offset } = AuditQuerySchema.parse(request.query);
    return listAudit(deps.db, limit, offset);
  });
}
