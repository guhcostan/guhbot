import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    environment: 'node',
    // Host tests touch SQLite files and the filesystem; running them in parallel
    // processes is fine because each test gets its own temp data directory.
    pool: 'forks',
  },
});
