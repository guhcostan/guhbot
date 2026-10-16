import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { resolveInside } from '@guhbot/agent';
import { z } from 'zod';
import { assertCanvasId, CANVAS_ID_PATTERN, digestOf } from './digest.js';
import { CanvasError } from './errors.js';
import type { CanvasPaths } from './paths.js';
import { formatBytes } from './util.js';

/**
 * The canvas store: immutable, content-addressed documents plus an LRU cache.
 *
 * Two layers, and it matters which is which:
 *
 *  - **The objects on disk are the record.** A document is stored under its
 *    SHA-256 and is never rewritten, which is what makes a canvas id safe to
 *    hand to a reader: the bytes behind it cannot change later.
 *  - **The in-memory cache is an optimization, not a trust boundary.** It holds
 *    whole documents up to a byte and entry budget and evicts least-recently-used
 *    first. Every document served is re-hashed against the id it is served
 *    under, cache hit or not, so the invariant is "whatever this returns hashes
 *    to the id" rather than "whatever was cached once was fine".
 *
 * A document bigger than the entire cache budget is served, never cached; that
 * is cheaper than evicting everything else to hold one file, and it keeps the
 * budget an actual ceiling instead of an aspiration.
 */
const CanvasMetaSchema = z.object({
  id: z.string().regex(CANVAS_ID_PATTERN),
  title: z.string().min(1).max(200),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.string().min(1).max(64),
  csp: z.string().min(1).max(8192),
});

export type CanvasEntry = z.infer<typeof CanvasMetaSchema>;

export interface CanvasStoreOptions {
  readonly paths: CanvasPaths;
  /** Largest document that may be stored at all. */
  readonly maxDocumentBytes: number;
  /** Total bytes the in-memory cache may hold. */
  readonly cacheMaxBytes: number;
  /** Number of documents the in-memory cache may hold. */
  readonly cacheMaxEntries: number;
  /** Number of documents the store may hold before it refuses a new one. */
  readonly maxDocuments: number;
  readonly now: () => number;
}

export interface CanvasCacheStats {
  readonly entries: number;
  readonly bytes: number;
  /** Oldest first. Exposed so a caller can see eviction order without guessing. */
  readonly ids: readonly string[];
}

let tempCounter = 0;

export class CanvasStore {
  private readonly options: CanvasStoreOptions;
  /** Insertion-ordered, used as an LRU: a re-`get` re-inserts at the end. */
  private readonly cache = new Map<string, Buffer>();
  private cacheBytes = 0;
  private disposed = false;

  constructor(options: CanvasStoreOptions) {
    this.options = options;
  }

  /**
   * Store a document, or return the identical one already stored.
   *
   * Idempotent by construction: the same bytes are the same document, so a
   * second create must not rewrite anything. That is a property, not an
   * optimization — a document someone already has open must not change.
   */
  async put(input: { bytes: Buffer; title: string; csp: string; expectedId?: string }): Promise<CanvasEntry> {
    this.assertUsable();

    const { bytes } = input;
    if (bytes.length === 0) {
      throw new CanvasError('bad-request', 'a canvas document cannot be empty');
    }
    if (bytes.length > this.options.maxDocumentBytes) {
      throw new CanvasError(
        'too-large',
        `canvas document is ${formatBytes(bytes.length)}, over this host's ${formatBytes(this.options.maxDocumentBytes)} limit; nothing was stored and nothing was truncated`,
      );
    }

    const id = digestOf(bytes);
    if (input.expectedId !== undefined && input.expectedId !== id) {
      throw new CanvasError(
        'integrity',
        `this document's content hashes to ${id}, not to the id it was submitted under; it was not stored`,
      );
    }

    const existing = await this.loadMeta(id);
    if (existing.found) {
      if (existing.entry === null) {
        throw new CanvasError('integrity', `canvas ${id} exists but its stored metadata is unreadable; delete it and create it again`);
      }
      this.cacheSet(id, bytes);
      return existing.entry;
    }

    if ((await this.metaFiles()).length >= this.options.maxDocuments) {
      throw new CanvasError(
        'limit',
        `this host already holds ${this.options.maxDocuments} canvases; delete one with canvas_delete before creating another`,
      );
    }

    // Object first, metadata second. A crash between the two leaves an orphan
    // object, which is invisible and harmless; the reverse would leave a listed
    // canvas with nothing behind it.
    await mkdir(this.options.paths.objectsDir, { recursive: true, mode: 0o700 });
    await this.writeAtomically(await this.objectPath(id), bytes);
    const entry: CanvasEntry = {
      id,
      title: input.title,
      bytes: bytes.length,
      createdAt: new Date(this.options.now()).toISOString(),
      csp: input.csp,
    };
    await mkdir(this.options.paths.metaDir, { recursive: true, mode: 0o700 });
    await this.writeAtomically(await this.metaPath(id), `${JSON.stringify(entry)}\n`);
    this.cacheSet(id, bytes);
    return entry;
  }

  async get(id: string): Promise<{ entry: CanvasEntry; bytes: Buffer }> {
    this.assertUsable();
    assertCanvasId(id);

    const meta = await this.loadMeta(id);
    if (!meta.found) throw new CanvasError('not-found', `no canvas ${id}`);
    if (meta.entry === null) {
      throw new CanvasError('integrity', `canvas ${id} has unreadable metadata and was not served`);
    }

    const cached = this.cache.get(id);
    let bytes: Buffer;
    if (cached !== undefined) {
      bytes = cached;
    } else {
      try {
        bytes = await readFile(await this.objectPath(id));
      } catch {
        throw new CanvasError('not-found', `canvas ${id} is listed but its document is missing`);
      }
    }

    // Verified on every serve, including a cache hit: the cache is in-process
    // memory, but the object on disk is writable by anything running as this
    // user, and the digest is the only thing that makes the id a promise.
    if (digestOf(bytes) !== id) {
      this.cacheDelete(id);
      throw new CanvasError(
        'integrity',
        `canvas ${id} failed its content check: the stored bytes do not hash to that id, so it was not served`,
      );
    }

    this.cacheSet(id, bytes);
    return { entry: meta.entry, bytes };
  }

  /** Newest first. Ids are unique, so `createdAt` ties are broken on the id. */
  async list(limit = this.options.maxDocuments): Promise<CanvasEntry[]> {
    this.assertUsable();
    const entries: CanvasEntry[] = [];
    for (const name of await this.metaFiles()) {
      const id = basename(name, '.json');
      if (!CANVAS_ID_PATTERN.test(id)) continue;
      const meta = await this.loadMeta(id);
      if (meta.entry !== null) entries.push(meta.entry);
    }
    entries.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    return entries.slice(0, Math.max(0, limit));
  }

  async delete(id: string): Promise<boolean> {
    this.assertUsable();
    assertCanvasId(id);

    const objectPath = await this.objectPath(id);
    const metaPath = await this.metaPath(id);
    const existed = (await exists(metaPath)) || (await exists(objectPath));
    await rm(objectPath, { force: true });
    await rm(metaPath, { force: true });
    this.cacheDelete(id);
    return existed;
  }

  cacheStats(): CanvasCacheStats {
    return { entries: this.cache.size, bytes: this.cacheBytes, ids: [...this.cache.keys()] };
  }

  /** Idempotent: releasing a released store is not an error. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cache.clear();
    this.cacheBytes = 0;
  }

  private assertUsable(): void {
    if (this.disposed) throw new CanvasError('closed', 'the canvas store has been released; this capability has been disposed');
  }

  private async metaFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.options.paths.metaDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
    } catch {
      // No directory yet means no canvases. Creating it here would make a read
      // do I/O on a path the user has not asked us to own.
      return [];
    }
  }

  private async loadMeta(id: string): Promise<{ found: boolean; entry: CanvasEntry | null }> {
    let text: string;
    try {
      text = await readFile(await this.metaPath(id), 'utf8');
    } catch {
      return { found: false, entry: null };
    }
    const parsed = CanvasMetaSchema.safeParse(safeJson(text));
    return { found: true, entry: parsed.success ? parsed.data : null };
  }

  /**
   * Paths are built, never created, here.
   *
   * A read must not have a side effect: probing for a canvas that does not exist
   * should not bring a directory into being. The id is format-checked by every
   * caller and is still resolved through the jail, because an id is
   * model-supplied text and no path in this repository reaches the filesystem
   * without passing through `resolveInside`.
   */
  private async objectPath(id: string): Promise<string> {
    return resolveInside(this.options.paths.objectsDir, `${id}.html`);
  }

  private async metaPath(id: string): Promise<string> {
    return resolveInside(this.options.paths.metaDir, `${id}.json`);
  }

  private async writeAtomically(target: string, data: Buffer | string): Promise<void> {
    tempCounter += 1;
    const temp = join(`${target}.${process.pid}.${tempCounter}.tmp`);
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, target);
  }

  private cacheSet(id: string, bytes: Buffer): void {
    this.cacheDelete(id);
    if (bytes.length > this.options.cacheMaxBytes) return;
    this.cache.set(id, bytes);
    this.cacheBytes += bytes.length;
    while (this.cacheBytes > this.options.cacheMaxBytes || this.cache.size > this.options.cacheMaxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cacheDelete(oldest.value);
    }
  }

  private cacheDelete(id: string): void {
    const held = this.cache.get(id);
    if (held === undefined) return;
    this.cache.delete(id);
    this.cacheBytes -= held.length;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
