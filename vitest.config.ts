import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `*.live.test.ts` talks to a real model provider and is therefore not
    // deterministic: a provider can be slow, rate-limited, or simply choose not
    // to call a tool on the first attempt. It is excluded from the default run
    // so that `pnpm test` is trustworthy, and run explicitly with `pnpm test:live`.
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
    environment: 'node',
    // Socket-level integration tests (pairing, event fan-out, a fake model
    // server) legitimately need more than the 5s default.
    testTimeout: 20_000,
    // Host tests touch SQLite files and the filesystem; running them in parallel
    // processes is fine because each test gets its own temp data directory.
    pool: 'forks',
  },
});
