import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    environment: 'node',
    // Socket-level integration tests (pairing, event fan-out, a fake model
    // server) legitimately need more than the 5s default.
    testTimeout: 20_000,
    // Host tests touch SQLite files and the filesystem; running them in parallel
    // processes is fine because each test gets its own temp data directory.
    pool: 'forks',
  },
});
