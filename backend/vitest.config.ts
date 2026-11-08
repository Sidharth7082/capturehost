import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // better-sqlite3 keeps a file handle per instance; running files in
    // separate workers avoids cross-talk on shared temp dirs.
    pool: 'forks',
    testTimeout: 10_000,
  },
});
