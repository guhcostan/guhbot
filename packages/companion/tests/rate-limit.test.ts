import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { SlidingWindow, createCompanion, type Companion, type DeviceIdentity } from '../src/index.js';
import { rawUpgrade, safeParse, startFakeHarness, waitFor } from './support.js';

/**
 * Rate limiting, with the clock injected.
 *
 * The point of a rate limit here is that a *stolen* phone cannot hammer the
 * harness and a token-guessing loop is slow, so both budgets are exercised: one
 * keyed by device, one by source address. Nothing in this file sleeps to advance
 * time.
 */

const WINDOW_MS = 60_000;

let now = 1_000_000;
const clock = (): number => now;
const advance = (ms: number): void => {
  now += ms;
};

let stop: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of stop.reverse()) await dispose();
  stop = [];
  now = 1_000_000;
});

const identity: DeviceIdentity = { id: 'dv_1', name: 'Phone', class: 'background' };

async function boot(options: {
  harnessPort: number;
  verifyToken: (token: string) => Promise<DeviceIdentity | null>;
  rateLimit: {
    windowMs?: number;
    maxConnectionsPerDevice?: number;
    maxRequestsPerDevice?: number;
    maxAttemptsPerAddress?: number;
  };
}): Promise<Companion> {
  const companion = createCompanion({
    harness: { port: options.harnessPort },
    verifyToken: options.verifyToken,
    host: '127.0.0.1',
    port: 0,
    rateLimit: { ...options.rateLimit, now: clock },
  });
  stop.push(() => companion.close());
  await companion.listen();
  return companion;
}

describe('sliding window', () => {
  it('allows up to the limit, refuses the next, and allows again once the window passes', () => {
    const window = new SlidingWindow({ windowMs: WINDOW_MS, now: clock });
    expect(window.take('device:dv_1', 2).allowed).toBe(true);
    expect(window.take('device:dv_1', 2).allowed).toBe(true);

    const refused = window.take('device:dv_1', 2);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(WINDOW_MS);

    // One key hitting its limit does not spend another key's budget.
    expect(window.take('device:dv_2', 2).allowed).toBe(true);

    advance(WINDOW_MS + 1);
    expect(window.take('device:dv_1', 2).allowed).toBe(true);
  });

  it('treats a limit of zero as "refuse everything"', () => {
    const window = new SlidingWindow({ windowMs: WINDOW_MS, now: clock });
    expect(window.take('anyone', 0).allowed).toBe(false);
  });
});

describe('through the companion', () => {
  it('bounds connection attempts per device, and lets a legitimate attempt through after the window', async () => {
    const harness = await startFakeHarness();
    stop.push(() => harness.close());
    const companion = await boot({
      harnessPort: harness.port,
      verifyToken: async (token) => (token === 'good' ? identity : null),
      rateLimit: { windowMs: WINDOW_MS, maxConnectionsPerDevice: 2, maxAttemptsPerAddress: 100 },
    });
    const host = `127.0.0.1:${companion.port}`;

    expect((await rawUpgrade(companion.port, { host, token: 'good' })).status).toBe(101);
    expect((await rawUpgrade(companion.port, { host, token: 'good' })).status).toBe(101);
    expect((await rawUpgrade(companion.port, { host, token: 'good' })).status).toBe(429);
    await waitFor(() => harness.upgrades === 2);
    expect(companion.stats.refusedRate).toBe(1);

    // A reconnect storm is what this stops; a phone that comes back a minute
    // later is not being punished for it.
    advance(WINDOW_MS + 1);
    expect((await rawUpgrade(companion.port, { host, token: 'good' })).status).toBe(101);
    await waitFor(() => harness.upgrades === 3);
  });

  it('bounds unauthenticated attempts per source address, so a guessing loop never reaches the harness', async () => {
    const harness = await startFakeHarness();
    stop.push(() => harness.close());
    const companion = await boot({
      harnessPort: harness.port,
      verifyToken: async (token) => (token === 'good' ? identity : null),
      rateLimit: { windowMs: WINDOW_MS, maxAttemptsPerAddress: 3, maxConnectionsPerDevice: 100 },
    });
    const host = `127.0.0.1:${companion.port}`;

    expect((await rawUpgrade(companion.port, { host, token: 'guess-1' })).status).toBe(401);
    expect((await rawUpgrade(companion.port, { host, token: 'guess-2' })).status).toBe(401);
    expect((await rawUpgrade(companion.port, { host, token: 'guess-3' })).status).toBe(401);
    // The budget is spent, so even a valid token waits: a loop that keeps
    // guessing cannot buy more verifier work by guessing well.
    expect((await rawUpgrade(companion.port, { host, token: 'good' })).status).toBe(429);
    expect(harness.upgrades).toBe(0);

    advance(WINDOW_MS + 1);
    expect((await rawUpgrade(companion.port, { host, token: 'good' })).status).toBe(101);
    await waitFor(() => harness.upgrades === 1);
  });

  it('bounds requests per device and answers the excess with a rate-limited response', async () => {
    const harness = await startFakeHarness({ answer: true });
    stop.push(() => harness.close());
    const companion = await boot({
      harnessPort: harness.port,
      verifyToken: async (token) => (token === 'good' ? identity : null),
      rateLimit: { windowMs: WINDOW_MS, maxRequestsPerDevice: 2, maxAttemptsPerAddress: 100 },
    });

    const socket = new WebSocket(`ws://127.0.0.1:${companion.port}/rpc?token=good`);
    stop.push(async () => {
      socket.terminate();
    });
    const responses = new Map<string, Record<string, unknown>>();
    socket.on('message', (data) => {
      const parsed = safeParse(data.toString());
      const id = parsed?.['id'];
      if (parsed !== null && typeof id === 'string') responses.set(id, parsed);
    });
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));

    const send = (id: string): void => {
      socket.send(JSON.stringify({ t: 'req', id, method: 'agents.list', params: {} }));
    };
    send('r1');
    send('r2');
    send('r3');
    await waitFor(() => responses.has('r3'));

    expect(responses.get('r1')?.['ok']).toBe(true);
    expect(responses.get('r2')?.['ok']).toBe(true);
    // Synthesized at the edge: the harness never sees the third request.
    const refused = responses.get('r3');
    expect(refused?.['ok']).toBe(false);
    expect((refused?.['error'] as { code?: string } | undefined)?.code).toBe('rate-limited');
    expect(harness.frames).toHaveLength(2);

    advance(WINDOW_MS + 1);
    send('r4');
    await waitFor(() => responses.has('r4'));
    expect(responses.get('r4')?.['ok']).toBe(true);
    expect(harness.frames).toHaveLength(3);
  });
});
