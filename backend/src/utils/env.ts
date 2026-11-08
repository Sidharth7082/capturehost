import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads `.env` into process.env using Node's built-in parser.
 *
 * Called first thing in index.ts and every CLI script. Node's built-in does not
 * overwrite variables that are already set, so `APP_ENCRYPTION_KEY=… npm run dev`
 * still wins over the file — which is what you want in CI and in tests.
 */
export function loadEnvFile(path = '.env'): void {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return;
  process.loadEnvFile(absolute);
}
