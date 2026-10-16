import { access, mkdir, readFile, rm, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, artifactRoot } from '../src/index.js';

/**
 * The artifact jail.
 *
 * Every path here arrives from a tool argument, which means it arrives from the
 * model, which means it is hostile. `resolveInside` is the rule; these tests are
 * the proof that the rule is actually on the path.
 */

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'guhbot-canvas-artifacts-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function makeStore(overrides: { maxBytes?: number; maxEntries?: number } = {}): ArtifactStore {
  return new ArtifactStore({
    root: artifactRoot(dataDir),
    maxBytes: overrides.maxBytes ?? 4096,
    maxEntries: overrides.maxEntries ?? 10,
    now: () => 1_700_000_000_000,
  });
}

const root = (): string => artifactRoot(dataDir);

describe('writing artifacts', () => {
  it('writes a file inside the jail and reports where it went', async () => {
    const entry = await makeStore().write({ path: 'notes.txt', bytes: Buffer.from('hello') });
    expect(entry).toEqual({ path: 'notes.txt', bytes: 5, modifiedAt: new Date(1_700_000_000_000).toISOString() });
    expect(await readFile(join(root(), 'notes.txt'), 'utf8')).toBe('hello');
  });

  it('creates nested directories, but only inside the jail', async () => {
    const entry = await makeStore().write({ path: 'reports/q3/summary.md', bytes: Buffer.from('# q3') });
    expect(entry.path).toBe('reports/q3/summary.md');
    expect(await readFile(join(root(), 'reports', 'q3', 'summary.md'), 'utf8')).toBe('# q3');
  });

  it('refuses ../ traversal', async () => {
    const store = makeStore();
    await expect(store.write({ path: '../escape.txt', bytes: Buffer.from('x') })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(store.write({ path: '../../escape.txt', bytes: Buffer.from('x') })).rejects.toThrow(
      /outside the artifact directory/,
    );
    await expect(store.write({ path: 'nested/../../escape.txt', bytes: Buffer.from('x') })).rejects.toMatchObject({
      code: 'forbidden',
    });

    // Nothing landed beside the jail, at either level.
    await expect(access(join(dataDir, 'escape.txt'))).rejects.toThrow();
    await expect(access(join(dirname(dataDir), 'escape.txt'))).rejects.toThrow();
  });

  it('refuses an absolute path outside the jail', async () => {
    await expect(makeStore().write({ path: '/etc/guhbot-should-never-exist', bytes: Buffer.from('x') })).rejects.toMatchObject(
      { code: 'forbidden' },
    );
  });

  it('refuses to write through a symlink that leaves the jail', async () => {
    const outside = join(dirname(dataDir), `outside-${process.pid}.txt`);
    await writeFile(outside, 'original');
    await mkdir(root(), { recursive: true });
    await symlink(outside, join(root(), 'link.txt'));

    try {
      await expect(makeStore().write({ path: 'link.txt', bytes: Buffer.from('overwritten'), overwrite: true })).rejects.toMatchObject(
        { code: 'forbidden' },
      );
      expect(await readFile(outside, 'utf8')).toBe('original');
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('refuses to write through a symlink even when it points inside the jail', async () => {
    const store = makeStore();
    await store.write({ path: 'real.txt', bytes: Buffer.from('real') });
    await symlink(join(root(), 'real.txt'), join(root(), 'alias.txt'));

    await expect(store.write({ path: 'alias.txt', bytes: Buffer.from('via link'), overwrite: true })).rejects.toThrow(
      /refusing to write through the symlink/,
    );
    expect(await readFile(join(root(), 'real.txt'), 'utf8')).toBe('real');
  });

  it('refuses to replace an existing artifact without an explicit flag', async () => {
    const store = makeStore();
    await store.write({ path: 'notes.txt', bytes: Buffer.from('first') });

    await expect(store.write({ path: 'notes.txt', bytes: Buffer.from('second') })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(store.write({ path: 'notes.txt', bytes: Buffer.from('second') })).rejects.toThrow(/pass overwrite: true/);
    expect(await readFile(join(root(), 'notes.txt'), 'utf8')).toBe('first');

    const replaced = await store.write({ path: 'notes.txt', bytes: Buffer.from('second'), overwrite: true });
    expect(replaced.bytes).toBe(6);
    expect(await readFile(join(root(), 'notes.txt'), 'utf8')).toBe('second');
  });

  it('refuses an over-size artifact with a message naming both sizes', async () => {
    const store = makeStore({ maxBytes: 64 });
    await expect(store.write({ path: 'big.txt', bytes: Buffer.alloc(128, 0x61) })).rejects.toMatchObject({
      code: 'too-large',
    });
    await expect(store.write({ path: 'big.txt', bytes: Buffer.alloc(128, 0x61) })).rejects.toThrow(/128 B.*64 B/);
    await expect(access(join(root(), 'big.txt'))).rejects.toThrow();
  });

  it('refuses a new artifact once the directory is full', async () => {
    const store = makeStore({ maxEntries: 2 });
    await store.write({ path: 'a.txt', bytes: Buffer.from('a') });
    await store.write({ path: 'b.txt', bytes: Buffer.from('b') });

    await expect(store.write({ path: 'c.txt', bytes: Buffer.from('c') })).rejects.toMatchObject({ code: 'limit' });
    // Replacing an existing file is not growing the set, so it still works.
    await expect(store.write({ path: 'a.txt', bytes: Buffer.from('a2'), overwrite: true })).resolves.toMatchObject({
      path: 'a.txt',
    });
  });

  it('refuses a directory as a destination', async () => {
    const store = makeStore();
    await expect(store.write({ path: 'reports/', bytes: Buffer.from('x') })).rejects.toMatchObject({ code: 'bad-request' });
    await expect(store.write({ path: '.', bytes: Buffer.from('x') })).rejects.toMatchObject({ code: 'bad-request' });
    await expect(store.write({ path: '', bytes: Buffer.from('x') })).rejects.toMatchObject({ code: 'bad-request' });
    await store.write({ path: 'taken', bytes: Buffer.from('x') });
    await expect(store.write({ path: 'taken', bytes: Buffer.from('x') })).rejects.toThrow(/already exists/);
  });
});

describe('listing artifacts', () => {
  it('lists files sorted by path and never follows a symlink', async () => {
    const store = makeStore();
    await store.write({ path: 'b.txt', bytes: Buffer.from('bb') });
    await store.write({ path: 'a.txt', bytes: Buffer.from('a') });
    await store.write({ path: 'nested/c.txt', bytes: Buffer.from('ccc') });
    await symlink('/etc/passwd', join(root(), 'link.txt'));

    const listed = await store.list();
    expect(listed.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt', 'nested/c.txt']);
    expect(listed.find((entry) => entry.path === 'a.txt')?.bytes).toBe(1);
    expect(await store.count()).toBe(3);
    expect(await store.list(2)).toHaveLength(2);
  });

  it('reports an empty jail rather than failing when nothing was written', async () => {
    expect(await makeStore().list()).toEqual([]);
    expect(await makeStore().count()).toBe(0);
  });
});
