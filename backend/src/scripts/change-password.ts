import { loadEnvFile } from '../utils/env.js';
import { loadConfig } from '../config.js';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../crypto/password.js';
import { writeAudit } from '../db/audit.repo.js';
import { deleteSessionsForAdmin, getAdmin, updateAdminPassword } from '../db/auth.repo.js';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { promptHidden } from '../utils/prompt.js';

/**
 * Rotates the admin password from a shell.
 *
 * Unlike `reset:admin`, this keeps the account: the TOTP secret, the recovery
 * codes and the audit history all survive, because only `password_hash` changes.
 * Every existing session is revoked — whoever was logged in with the old
 * password should not stay logged in.
 *
 * Usage:
 *   npm run change:password
 *   npm run change:password -- --db /var/lib/capturehost/capturehost.db
 *
 * Non-interactive (for tests and provisioning):
 *   CH_CHANGE_CURRENT=old CH_CHANGE_NEW=new npm run change:password
 */

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();

  const args = process.argv.slice(2);
  const dbFlag = args.indexOf('--db');
  if (dbFlag >= 0) config.dbPath = args[dbFlag + 1] ?? config.dbPath;

  const db = openDatabase(config.dbPath);
  migrate(db);

  try {
    const admin = getAdmin(db);

    if (!admin) {
      console.error('No admin account in this database. Run `npm run setup:admin` first.');
      process.exitCode = 2;
      return;
    }

    console.log(`Database : ${config.dbPath}`);
    console.log(`Account  : ${admin.username}`);
    console.log(`2FA      : ${admin.totp_enabled === 1 ? 'enabled (unchanged)' : 'disabled'}`);
    console.log('');

    const automated = process.env.CH_CHANGE_CURRENT && process.env.CH_CHANGE_NEW;

    const current = automated
      ? (process.env.CH_CHANGE_CURRENT as string)
      : await promptHidden('Current password (hidden): ');

    if (!(await verifyPassword(admin.password_hash, current))) {
      writeAudit(db, {
        action: 'auth.password_change_failed',
        actor: admin.username,
        detail: 'wrong current password via change:password CLI',
        success: false,
        now: Date.now(),
      });

      console.error('\nCurrent password is incorrect. Nothing was changed.');
      process.exitCode = 1;
      return;
    }

    const next = automated
      ? (process.env.CH_CHANGE_NEW as string)
      : await promptHidden('New password (min 12 chars, hidden): ');

    const confirmation = automated ? next : await promptHidden('Confirm new password: ');

    if (next !== confirmation) {
      console.error('\nPasswords do not match. Nothing was changed.');
      process.exitCode = 1;
      return;
    }

    const problem = checkPasswordStrength(next, admin.username);
    if (problem) {
      console.error(`\n${problem.message}. Nothing was changed.`);
      process.exitCode = 1;
      return;
    }

    if (next === current) {
      console.error('\nThe new password is the current one. Nothing was changed.');
      process.exitCode = 1;
      return;
    }

    const now = Date.now();
    const hash = await hashPassword(next, config.argon2);

    updateAdminPassword(db, admin.id, hash, now);
    const revoked = deleteSessionsForAdmin(db, admin.id);

    writeAudit(db, {
      action: 'auth.password_changed',
      actor: admin.username,
      target: admin.username,
      detail: `changed via change:password CLI; ${revoked} session(s) revoked`,
      now,
    });

    console.log(`\nPassword changed for "${admin.username}".`);
    console.log(`${revoked} session(s) signed out — sign in again with the new password.`);
    console.log('2FA and recovery codes are unchanged.');
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error('Change failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
