import { defineConfig } from 'vitest/config';

/**
 * Configuration for the live-model suite only.
 *
 * Kept separate from `vitest.config.ts` on purpose. These tests talk to a real
 * provider, so they are slow, they cost money, and they can fail for reasons that
 * have nothing to do with this code. The default `pnpm test` must stay
 * deterministic; this is the config you opt into with `pnpm test:live`.
 *
 * The timeout is generous because a real model takes seconds per turn and a
 * timeout here would be a flaky failure rather than a bug.
 */
export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.live.test.ts', 'apps/*/tests/**/*.live.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 240_000,
    hookTimeout: 60_000,
    // Live runs share one upstream gateway, and the gateway keeps concurrent
    // sessions apart by session id. Running files in parallel makes providers
    // rate-limit us, which is not a signal about the code.
    fileParallelism: false,
    pool: 'forks',
  },
});
