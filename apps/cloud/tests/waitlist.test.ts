import { describe, expect, it } from 'vitest';
import { createWaitlistHandler, MemoryWaitlistStore, type WaitlistStore } from '../src/waitlist.js';

/**
 * The waitlist is small, so the tests are about the things that would be
 * embarrassing: accepting nonsense, duplicating an address, leaking the address
 * back in a response, or reporting success when storage failed.
 */

function post(body: unknown, overrides: Record<string, unknown> = {}) {
  return { requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body), ...overrides };
}

describe('waitlist', () => {
  it('accepts a valid address', async () => {
    const store = new MemoryWaitlistStore();
    const handle = createWaitlistHandler({ store });
    const response = await handle(post({ email: 'someone@example.com' }));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'added' });
    expect(store.size).toBe(1);
  });

  it('reports a duplicate as 409, which the page treats as success', async () => {
    const handle = createWaitlistHandler({ store: new MemoryWaitlistStore() });
    await handle(post({ email: 'someone@example.com' }));
    const second = await handle(post({ email: 'SOMEONE@example.com' }));
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body)).toEqual({ status: 'already-on-list' });
  });

  it.each(['', '   ', 'not-an-email', 'a@b', 'a@b.c', '@example.com', 'a b@example.com'])(
    'rejects %j',
    async (email) => {
      const handle = createWaitlistHandler({ store: new MemoryWaitlistStore() });
      const response = await handle(post({ email }));
      expect(response.statusCode).toBe(400);
    },
  );

  it('rejects an address longer than the legal maximum', async () => {
    const handle = createWaitlistHandler({ store: new MemoryWaitlistStore() });
    const long = `${'a'.repeat(250)}@example.com`;
    expect((await handle(post({ email: long }))).statusCode).toBe(400);
  });

  it('never echoes the submitted address back', async () => {
    const handle = createWaitlistHandler({ store: new MemoryWaitlistStore() });
    // Both the accepted and the rejected path are checked: a response body is a
    // place an address leaks into logs, trackers and browser history.
    const accepted = await handle(post({ email: 'private@example.com' }));
    expect(accepted.body).not.toContain('private@example.com');
    const duplicate = await handle(post({ email: 'private@example.com' }));
    expect(duplicate.body).not.toContain('private@example.com');
  });

  it('rejects a non-POST method and handles the CORS preflight', async () => {
    const handle = createWaitlistHandler({ store: new MemoryWaitlistStore(), allowedOrigin: 'https://guhbot.dev' });
    const get = await handle({ requestContext: { http: { method: 'GET' } } });
    expect(get.statusCode).toBe(405);

    const preflight = await handle({ requestContext: { http: { method: 'OPTIONS' } } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://guhbot.dev');
  });

  it('rejects a body that is not JSON, and one that is too large', async () => {
    const handle = createWaitlistHandler({ store: new MemoryWaitlistStore(), maxBodyBytes: 64 });
    expect((await handle({ requestContext: { http: { method: 'POST' } }, body: 'not json' })).statusCode).toBe(400);
    const big = await handle(post({ email: 'a@example.com', padding: 'x'.repeat(200) }));
    expect(big.statusCode).toBe(413);
  });

  it('reports a storage failure as 503 rather than a fake success', async () => {
    const failing: WaitlistStore = {
      add: async () => {
        throw new Error('dynamo is having a day');
      },
    };
    const handle = createWaitlistHandler({ store: failing });
    const response = await handle(post({ email: 'someone@example.com' }));
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('dynamo is having a day');
  });

  it('records the source and a timestamp, and truncates a huge source', async () => {
    const seen: { email: string; source: string; at: string }[] = [];
    const store: WaitlistStore = {
      add: async (email, source, at) => {
        seen.push({ email, source, at });
        return 'added';
      },
    };
    const handle = createWaitlistHandler({ store, now: () => new Date('2026-01-02T03:04:05Z') });
    await handle(post({ email: 'a@example.com', source: 'x'.repeat(500) }));
    expect(seen[0]?.email).toBe('a@example.com');
    expect(seen[0]?.source.length).toBe(64);
    expect(seen[0]?.at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('decodes a base64 body, which is how API Gateway delivers some requests', async () => {
    const handle = createWaitlistHandler({ store: new MemoryWaitlistStore() });
    const response = await handle({
      requestContext: { http: { method: 'POST' } },
      body: Buffer.from(JSON.stringify({ email: 'b64@example.com' }), 'utf8').toString('base64'),
      isBase64Encoded: true,
    });
    expect(response.statusCode).toBe(200);
  });
});
