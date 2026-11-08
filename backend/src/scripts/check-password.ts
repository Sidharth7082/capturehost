import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { verifyPassword } from '../crypto/password.js';
import { promptHidden } from '../utils/prompt.js';

/**
 * Checks a password against the stored hash, offline.
 *
 * The hash is one-way: there is nothing to "look up". The only question that can
 * be answered is whether a candidate matches — which is what this does, without
 * touching the login endpoint. That matters because five wrong attempts at
 * /api/auth/login lock the IP out for 15 minutes and raise a notification.
 *
 * Usage:
 *   npm run check:password                      # ./data/capturehost.db
 *   npm run check:password -- --db /var/lib/capturehost/capturehost.db
 *   printf 'candidate\n' | npm run check:password
 *
 * The password is never echoed, never logged and never stored. Nothing leaves
 * this machine.
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbFlag = args.indexOf('--db');
  const dbPath = resolve(dbFlag >= 0 ? (args[dbFlag + 1] ?? '') : (process.env.DB_PATH ?? './data/capturehost.db'));

  // Read-only: this tool must not create, migrate or lock anything.
  let db: Database.Database;

  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    console.error(`No database at ${dbPath}`);
    process.exit(2);
  }

  try {
    const row = db.prepare('SELECT id, username, password_hash, totp_enabled FROM admin LIMIT 1').get() as
      | { id: number; username: string; password_hash: string; totp_enabled: number }
      | undefined;

    if (!row) {
      console.error(`${dbPath}: no admin account yet — run "npm run setup:admin"`);
      process.exit(2);
    }

    console.log(`Database : ${dbPath}`);
    console.log(`Username : ${row.username}`);
    console.log(`2FA      : ${row.totp_enabled === 1 ? 'enabled' : 'disabled'}`);
    console.log(`Hash     : ${(row.password_hash.match(/^\$argon2id\$/) ? 'argon2id' : 'unexpected format')}\n`);

    // An empty extra arg lets a caller pass the candidate as an argument.
    const positionals = args.filter((arg, index) => !arg.startsWith('--') && index !== dbFlag + 1);
    const candidate = positionals[0] ?? (process.env.CHECK_PASSWORD ?? (await promptHidden('Password (not echoed): ')));

    if (!candidate) {
      console.error('No password given.');
      process.exit(2);
    }

    const matches = await verifyPassword(row.password_hash, candidate);

    console.log(matches ? 'MATCH — this is the password for that account.' : 'NO MATCH — wrong password for that account.');
    process.exit(matches ? 0 : 1);
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
