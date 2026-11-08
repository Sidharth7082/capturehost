import { loadEnvFile } from '../utils/env.js';
import { loadConfig } from '../config.js';
import { openDatabase } from './connection.js';
import { migrate } from './migrate.js';

/**
 * `npm run migrate` — applies pending migrations without starting the server.
 */
loadEnvFile();
const config = loadConfig();
const db = openDatabase(config.dbPath);
const result = migrate(db);

if (result.applied.length === 0) {
  console.log(`No pending migrations (${result.alreadyApplied} already applied).`);
} else {
  console.log(`Applied ${result.applied.length} migration(s):`);
  for (const name of result.applied) console.log(`  + ${name}`);
}

db.close();
