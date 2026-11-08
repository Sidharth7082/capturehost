import { loadEnvFile } from '../utils/env.js';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config.js';
import { writeAudit } from '../db/audit.repo.js';
import { getAdmin } from '../db/auth.repo.js';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';

/**
 * Destructive recovery path: wipes the admin account (and, by foreign-key
 * cascade, its sessions and recovery codes) so `npm run setup:admin` can run
 * again. Requires local shell access — there is no HTTP equivalent.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  migrate(db);

  const admin = getAdmin(db);
  if (!admin) {
    console.log('No admin account exists. Run `npm run setup:admin`.');
    db.close();
    return;
  }

  console.log(`This will delete admin "${admin.username}" and every session.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type RESET to continue: ');
  rl.close();

  if (answer.trim() !== 'RESET') {
    console.log('Aborted.');
    db.close();
    process.exit(1);
  }

  const now = Date.now();
  writeAudit(db, {
    action: 'auth.admin_reset',
    actor: 'cli',
    target: admin.username,
    detail: 'admin removed via reset:admin',
    now,
  });

  // ON DELETE CASCADE removes sessions and recovery codes with this row.
  db.prepare('DELETE FROM admin WHERE id = ?').run(admin.id);

  console.log('\nAdmin removed. Run `npm run setup:admin` to create a new one.');
  db.close();
}

main().catch((error: unknown) => {
  console.error('Reset failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
