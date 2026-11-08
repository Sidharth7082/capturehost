import { loadEnvFile } from '../utils/env.js';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config.js';
import { checkPasswordStrength, hashPassword } from '../crypto/password.js';
import { createAdmin, getAdmin } from '../db/auth.repo.js';
import { writeAudit } from '../db/audit.repo.js';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';

/**
 * One-time admin creation. This is deliberately a CLI and not an endpoint:
 * there is no public signup, and creating the first account requires shell
 * access to the machine. If an admin already exists it refuses.
 */

/** Reads a line without echoing it. Terminal raw mode, so no deps needed. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);

    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const onData = (input: string): void => {
      const chars = String(input);

      if (chars === '\n' || chars === '\r' || chars === '\u0004') {
        stdin.setRawMode?.(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(value);
        return;
      }

      if (chars === '\u0003') {
        // Ctrl-C: leave the terminal usable.
        stdin.setRawMode?.(wasRaw ?? false);
        stdout.write('\n');
        process.exit(130);
      }

      if (chars === '\u007f' || chars === '\b') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write('\b \b');
        }
        return;
      }

      value += chars;
      stdout.write('*');
    };

    stdin.on('data', onData);
    // Piped input (CI, `yes |`, a heredoc) ends the stream instead of sending
    // a newline: treat EOF as "done typing".
    stdin.once('end', () => {
      stdin.removeListener('data', onData);
      stdout.write('\n');
      resolve(value);
    });
  });
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  migrate(db);

  if (getAdmin(db) !== null) {
    console.error('\nAn admin account already exists.');
    console.error('Use `npm run reset:admin` if you need to replace it (requires shell access).\n');
    db.close();
    process.exit(1);
  }

  // Non-interactive path for automation (CI, provisioning scripts, tests).
  // Default is the interactive prompt; this only kicks in when both env vars
  // are set, and it still runs every validation below.
  const envUsername = process.env.CH_SETUP_USERNAME?.trim();
  const envPassword = process.env.CH_SETUP_PASSWORD;
  const automated = Boolean(envUsername && envPassword);

  let username: string;
  let password: string;
  let confirmation: string;

  if (automated) {
    username = envUsername as string;
    password = envPassword as string;
    confirmation = password;
    console.log(`(non-interactive) creating admin "${username}"`);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    username = (await rl.question('Admin username: ')).trim();
    rl.close();

    password = await promptHidden('Password (min 12 chars, hidden): ');
    confirmation = await promptHidden('Confirm password: ');
  }

  if (username.length < 3 || username.length > 64) {
    console.error('Username must be 3-64 characters.');
    db.close();
    process.exit(1);
  }

  const problem = checkPasswordStrength(password, username);
  if (problem) {
    console.error(`\n${problem.message}`);
    db.close();
    process.exit(1);
  }

  if (password !== confirmation) {
    console.error('\nPasswords do not match.');
    db.close();
    process.exit(1);
  }

  const passwordHash = await hashPassword(password, config.argon2);
  const now = Date.now();
  createAdmin(db, { username, passwordHash, now });

  writeAudit(db, {
    action: 'auth.admin_created',
    actor: 'cli',
    target: username,
    detail: 'initial admin created from setup:admin',
    now,
  });

  console.log(`\nAdmin "${username}" created.`);
  console.log('Start the backend and sign in at the dashboard.\n');
  db.close();
}

main().catch((error: unknown) => {
  console.error('Setup failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
