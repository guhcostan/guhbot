import { access, mkdir, readFile, readdir, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CanvasError, CanvasStore, canvasPaths, digestOf, matchesDigest } from '../src/index.js';
import type { CanvasStoreOptions } from '../src/index.js';

/**
 * Content addressing and the cache, both without a renderer and without a
 * server: a store, a temporary directory, and bytes.
 */

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'guhbot-canvas-store-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function makeStore(overrides: Partial<Omit<CanvasStoreOptions, 'paths'>> = {}): CanvasStore {
  return new CanvasStore({
    paths: canvasPaths(dataDir),
    maxDocumentBytes: 4096,
    cacheMaxBytes: 64 * 1024,
    cacheMaxEntries: 8,
    maxDocuments: 10,
    now: () => 1_700_000_000_000,
    ...overrides,
  });
}

function doc(body: string): Buffer {
  return Buffer.from(`<!DOCTYPE html><p>${body}</p>`, 'utf8');
}

describe('content addressing', () => {
  it('gives identical bytes the same id and stores them once', async () => {
    const store = makeStore();
    const first = await store.put({ bytes: doc('a'), title: 'a', csp: 'p' });
    const second = await store.put({ bytes: doc('a'), title: 'a different label', csp: 'p' });

    expect(first.id).toBe(second.id);
    expect(second.id).toBe(digestOf(doc('a')));
    // Idempotent: a document someone already has open must not change, so the
    // first metadata wins and nothing is rewritten.
    expect(second.title).toBe('a');
    expect(await store.list()).toHaveLength(1);
  });

  it('changes the id when a single byte changes', () => {
    expect(digestOf(doc('a'))).not.toBe(digestOf(doc('b')));
    const bytes = doc('a');
    expect(matchesDigest(digestOf(bytes), bytes)).toBe(true);
    const tampered = Buffer.from(bytes);
    tampered[20] = (tampered[20] ?? 0) ^ 0x01;
    expect(matchesDigest(digestOf(bytes), tampered)).toBe(false);
  });

  it('refuses a document submitted under an id it does not hash to', async () => {
    const store = makeStore();
    await expect(
      store.put({ bytes: doc('a'), title: 'a', csp: 'p', expectedId: 'f'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'integrity' });
    expect(await store.list()).toHaveLength(0);
  });

  it('refuses an empty document', async () => {
    await expect(makeStore().put({ bytes: Buffer.alloc(0), title: 'x', csp: 'p' })).rejects.toMatchObject({
      code: 'bad-request',
    });
  });

  it('refuses a stored document whose bytes were changed under it', async () => {
    const store = makeStore();
    const entry = await store.put({ bytes: doc('a'), title: 'a', csp: 'p' });

    const objectPath = join(dataDir, 'canvas', 'objects', `${entry.id}.html`);
    await writeFile(objectPath, '<!DOCTYPE html><p>replaced</p>');

    // A store with no cache has to read the tampered file.
    const cold = makeStore();
    await expect(cold.get(entry.id)).rejects.toBeInstanceOf(CanvasError);
    await expect(cold.get(entry.id)).rejects.toMatchObject({ code: 'integrity' });
    await expect(cold.get(entry.id)).rejects.toThrow(/content check/);
  });

  it('serves only bytes that hash to the id they are served under', async () => {
    const store = makeStore();
    const entry = await store.put({ bytes: doc('a'), title: 'a', csp: 'p' });
    const tampered = Buffer.from(doc('a'));
    tampered[21] = (tampered[21] ?? 0) ^ 0xff;

    // Even if a cached entry were somehow corrupted, the digest check is what
    // decides whether it is served.
    const { bytes } = await store.get(entry.id);
    expect(digestOf(bytes)).toBe(entry.id);
    expect(bytes.equals(tampered)).toBe(false);
  });

  it('writes only inside its own objects directory', async () => {
    const store = makeStore();
    const entry = await store.put({ bytes: doc('a'), title: 'a', csp: 'p' });
    await expect(access(join(dataDir, 'canvas', 'objects', `${entry.id}.html`))).resolves.toBeUndefined();
    expect(await readdir(join(dataDir, 'canvas', 'objects'))).toEqual([`${entry.id}.html`]);
  });

  it('refuses an id that is a path instead of a digest', async () => {
    const store = makeStore();
    await expect(store.get('../../escape')).rejects.toMatchObject({ code: 'bad-request' });
    await expect(store.delete('../../etc/passwd')).rejects.toMatchObject({ code: 'bad-request' });
    await expect(store.get('A'.repeat(64))).rejects.toMatchObject({ code: 'bad-request' });
    // Nothing outside the store was touched by the attempts above.
    await expect(access(join(dataDir, 'escape'))).rejects.toThrow();
  });

  it('reports a missing document rather than inventing one', async () => {
    const store = makeStore();
    await expect(store.get('0'.repeat(64))).rejects.toMatchObject({ code: 'not-found' });
    expect(await store.delete('0'.repeat(64))).toBe(false);
  });

  it('deletes a document and its cache entry', async () => {
    const store = makeStore();
    const entry = await store.put({ bytes: doc('a'), title: 'a', csp: 'p' });
    expect(store.cacheStats().ids).toContain(entry.id);

    expect(await store.delete(entry.id)).toBe(true);
    expect(await store.delete(entry.id)).toBe(false);
    expect(store.cacheStats().ids).not.toContain(entry.id);
    await expect(store.get(entry.id)).rejects.toMatchObject({ code: 'not-found' });
    expect(await store.list()).toHaveLength(0);
  });
});

describe('size and count limits', () => {
  it('refuses an over-size document with a message naming both sizes, and truncates nothing', async () => {
    const store = makeStore({ maxDocumentBytes: 512 });
    const bytes = Buffer.alloc(2048, 0x61);

    await expect(store.put({ bytes, title: 'big', csp: 'p' })).rejects.toMatchObject({ code: 'too-large' });
    await expect(store.put({ bytes, title: 'big', csp: 'p' })).rejects.toThrow(/2.0 KiB.*512 B/);
    await expect(store.put({ bytes, title: 'big', csp: 'p' })).rejects.toThrow(/nothing was stored and nothing was truncated/);
    expect(await store.list()).toHaveLength(0);
  });

  it('refuses a new document once the store is full', async () => {
    const store = makeStore({ maxDocuments: 2 });
    await store.put({ bytes: doc('a'), title: 'a', csp: 'p' });
    await store.put({ bytes: doc('b'), title: 'b', csp: 'p' });

    await expect(store.put({ bytes: doc('c'), title: 'c', csp: 'p' })).rejects.toMatchObject({ code: 'limit' });
    await expect(store.put({ bytes: doc('c'), title: 'c', csp: 'p' })).rejects.toThrow(/delete one with canvas_delete/);
    // The identical document still resolves: a full store is not a broken one.
    await expect(store.put({ bytes: doc('a'), title: 'a', csp: 'p' })).resolves.toMatchObject({ title: 'a' });
  });
});

describe('the LRU cache', () => {
  it('never exceeds its byte budget', async () => {
    const store = makeStore({ cacheMaxBytes: 250, cacheMaxEntries: 100 });
    for (const body of ['a', 'b', 'c', 'd']) {
      await store.put({ bytes: Buffer.from('x'.repeat(200) + body, 'utf8'), title: body, csp: 'p' });
      expect(store.cacheStats().bytes).toBeLessThanOrEqual(250);
    }
    expect(store.cacheStats().entries).toBe(1);
  });

  it('never exceeds its entry budget', async () => {
    const store = makeStore({ cacheMaxBytes: 64 * 1024, cacheMaxEntries: 2 });
    const a = await store.put({ bytes: doc('a'), title: 'a', csp: 'p' });
    const b = await store.put({ bytes: doc('b'), title: 'b', csp: 'p' });
    const c = await store.put({ bytes: doc('c'), title: 'c', csp: 'p' });

    expect(store.cacheStats().entries).toBe(2);
    expect(store.cacheStats().ids).toEqual([b.id, c.id]);
    // Evicted, not lost: it is still the record on disk.
    expect((await store.get(a.id)).bytes.toString('utf8')).toContain('a');
  });

  it('evicts the least recently used entry, and a read counts as use', async () => {
    const store = makeStore({ cacheMaxBytes: 64 * 1024, cacheMaxEntries: 2 });
    const a = await store.put({ bytes: doc('a'), title: 'a', csp: 'p' });
    const b = await store.put({ bytes: doc('b'), title: 'b', csp: 'p' });
    expect(store.cacheStats().ids).toEqual([a.id, b.id]);

    await store.get(a.id);
    const c = await store.put({ bytes: doc('c'), title: 'c', csp: 'p' });

    expect(store.cacheStats().ids).toEqual([a.id, c.id]);
    await expect(store.get(a.id)).resolves.toMatchObject({ entry: { id: a.id } });
  });

  it('serves a document larger than the whole cache without caching it', async () => {
    const store = makeStore({ maxDocumentBytes: 4096, cacheMaxBytes: 100, cacheMaxEntries: 8 });
    const big = Buffer.alloc(500, 0x62);
    const entry = await store.put({ bytes: big, title: 'big', csp: 'p' });

    expect(store.cacheStats().bytes).toBe(0);
    const { bytes } = await store.get(entry.id);
    expect(bytes.length).toBe(500);
    expect(store.cacheStats().bytes).toBe(0);
  });

  it('re-reads from disk after a release, and refuses to serve once released', async () => {
    const store = makeStore();
    const entry = await store.put({ bytes: doc('a'), title: 'a', csp: 'p' });
    await store.dispose();
    await store.dispose();

    expect(store.cacheStats()).toEqual({ entries: 0, bytes: 0, ids: [] });
    await expect(store.get(entry.id)).rejects.toMatchObject({ code: 'closed' });
    await expect(store.list()).rejects.toMatchObject({ code: 'closed' });

    // The objects are durable: a fresh store over the same directory serves it.
    const reopened = makeStore();
    const { bytes } = await reopened.get(entry.id);
    expect(bytes.toString('utf8')).toBe(doc('a').toString('utf8'));
  });
});

describe('listing and metadata', () => {
  it('lists newest first', async () => {
    let clock = 1_700_000_000_000;
    const store = makeStore({ now: () => (clock += 1000) });
    const a = await store.put({ bytes: doc('a'), title: 'a', csp: 'p' });
    const b = await store.put({ bytes: doc('b'), title: 'b', csp: 'p' });

    expect((await store.list()).map((entry) => entry.id)).toEqual([b.id, a.id]);
    // Newest first, and the title and size survive a round trip through disk.
    const meta = await readFile(join(dataDir, 'canvas', 'meta', `${b.id}.json`), 'utf8');
    expect(JSON.parse(meta)).toMatchObject({ id: b.id, title: 'b', bytes: doc('b').length, csp: 'p' });
    expect(await store.list(1)).toHaveLength(1);
    expect(await store.list(0)).toHaveLength(0);
  });

  it('skips an unreadable metadata file instead of failing the listing', async () => {
    const store = makeStore();
    const entry = await store.put({ bytes: doc('a'), title: 'a', csp: 'p' });
    await mkdir(join(dataDir, 'canvas', 'meta'), { recursive: true });
    await writeFile(join(dataDir, 'canvas', 'meta', `${'1'.repeat(64)}.json`), 'not json');

    expect((await store.list()).map((e) => e.id)).toEqual([entry.id]);
    // …but asking for it directly is an integrity failure, not a "not found".
    await expect(store.get('1'.repeat(64))).rejects.toMatchObject({ code: 'integrity' });
  });

  it('creates nothing until something is stored', async () => {
    const store = makeStore();
    expect(await store.list()).toEqual([]);
    // Probing reads must have no side effect either.
    await expect(store.get('0'.repeat(64))).rejects.toMatchObject({ code: 'not-found' });
    expect(await store.delete('0'.repeat(64))).toBe(false);
    await expect(access(join(dataDir, 'canvas'))).rejects.toThrow();
  });
});
