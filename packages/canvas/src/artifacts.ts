import { lstat, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { resolveInside } from '@guhbot/agent';
import { CanvasError } from './errors.js';
import { formatBytes } from './util.js';

/**
 * The artifact store: ordinary files, in one directory, and nothing else.
 *
 * An artifact is not a canvas. A canvas is bytes this host owns, hashes and
 * guarantees things about; an artifact is a file the agent produced — a CSV, a
 * markdown report, an SVG — whose value is that the user can open it in whatever
 * program they like. Every path from a tool argument is resolved through
 * `resolveInside` against this one root, so `..`, an absolute path and a symlink
 * pointing out are all refused before anything is written.
 *
 * Symlinks are also skipped when listing and refused when writing, even though
 * `resolveInside` already catches the escape: two independent refusals on the
 * one operation that can write outside its jail is the right amount of
 * paranoia, and skipping a link while walking means a listing can never be a
 * way to read through one.
 */
export interface ArtifactEntry {
  /** Relative to the artifact root, always with `/` separators. */
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAt: string;
}

export interface ArtifactStoreOptions {
  readonly root: string;
  /** Largest single artifact that may be written. */
  readonly maxBytes: number;
  /** Number of artifacts the directory may hold before a new one is refused. */
  readonly maxEntries: number;
  readonly now: () => number;
}

export class ArtifactStore {
  private readonly options: ArtifactStoreOptions;

  constructor(options: ArtifactStoreOptions) {
    this.options = options;
  }

  async write(input: { path: string; bytes: Buffer; overwrite?: boolean }): Promise<ArtifactEntry> {
    const requested = cleanArtifactPath(input.path);
    if (input.bytes.length > this.options.maxBytes) {
      throw new CanvasError(
        'too-large',
        `artifact is ${formatBytes(input.bytes.length)}, over this host's ${formatBytes(this.options.maxBytes)} limit; nothing was written and nothing was truncated`,
      );
    }

    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const target = await this.jail(requested);
    const existing = await lstatOrNull(target);

    if (existing?.isSymbolicLink() === true) {
      throw new CanvasError('forbidden', `refusing to write through the symlink ${requested}`);
    }
    if (existing?.isDirectory() === true) {
      throw new CanvasError('bad-request', `${requested} is a directory, not a file`);
    }
    if (existing !== null && input.overwrite !== true) {
      throw new CanvasError(
        'forbidden',
        `artifact ${requested} already exists; pass overwrite: true to replace it`,
      );
    }
    if (existing === null && (await this.count()) >= this.options.maxEntries) {
      throw new CanvasError(
        'limit',
        `this host already holds ${this.options.maxEntries} artifacts; remove one before writing another`,
      );
    }

    // Resolving first means mkdir cannot escape either: `target` is already
    // known to be inside the jail.
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, input.bytes, { mode: 0o600 });

    return {
      path: toPosix(relative(this.options.root, target)),
      bytes: input.bytes.length,
      modifiedAt: new Date(this.options.now()).toISOString(),
    };
  }

  /** Sorted by path, so a listing is stable across calls. */
  async list(limit = this.options.maxEntries): Promise<ArtifactEntry[]> {
    const found: ArtifactEntry[] = [];
    const cap = Math.max(1, Math.min(limit, this.options.maxEntries + 1));
    await this.walk(this.options.root, 0, found, cap);
    found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return found.slice(0, Math.max(0, limit));
  }

  async count(): Promise<number> {
    return (await this.list(this.options.maxEntries + 1)).length;
  }

  private async walk(dir: string, depth: number, found: ArtifactEntry[], cap: number): Promise<void> {
    if (depth > 8 || found.length >= cap) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= cap) return;
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(full, depth + 1, found, cap);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(full).catch(() => null);
      if (info === null) continue;
      found.push({ path: toPosix(relative(this.options.root, full)), bytes: info.size, modifiedAt: info.mtime.toISOString() });
    }
  }

  private async jail(requested: string): Promise<string> {
    try {
      return await resolveInside(this.options.root, requested);
    } catch {
      throw new CanvasError('forbidden', `artifact path ${JSON.stringify(requested)} is outside the artifact directory`);
    }
  }
}

function cleanArtifactPath(raw: string): string {
  const value = raw.trim();
  if (value === '') throw new CanvasError('bad-request', 'artifact path is empty');
  if (value.length > 4096) throw new CanvasError('bad-request', 'artifact path is longer than 4096 characters');
  if (value.includes('\0')) throw new CanvasError('bad-request', 'artifact path contains a NUL byte');
  if (value.endsWith('/') || value.endsWith(sep)) {
    throw new CanvasError('bad-request', `artifact path ${JSON.stringify(raw)} is a directory, not a file`);
  }
  const base = basename(value);
  if (base === '.' || base === '..') {
    throw new CanvasError('bad-request', `artifact path ${JSON.stringify(raw)} is a directory, not a file`);
  }
  return value;
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}
