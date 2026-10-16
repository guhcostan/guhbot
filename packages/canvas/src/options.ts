import { normalizeEgressList, type EgressEntry } from './allow-list.js';
import { CanvasError } from './errors.js';

/**
 * Defaults, and why these numbers.
 *
 * `cacheMaxBytes` is 32 MiB, mirroring the reference implementation's canvas
 * cache budget. A canvas document is 4 MiB: big enough for a real chart library
 * and its data inlined, small enough that a document is not a payload. Nothing
 * here is silently truncated — a document over the limit is refused, and a
 * refusal the model can read beats a document that quietly lost its second half.
 */
export const CANVAS_LIMITS = {
  maxDocumentBytes: 4 * 1024 * 1024,
  cacheMaxBytes: 32 * 1024 * 1024,
  cacheMaxEntries: 64,
  maxDocuments: 200,
  maxArtifactBytes: 8 * 1024 * 1024,
  maxArtifacts: 1000,
} as const;

export interface CanvasCapabilityOptions {
  /**
   * Host data directory. Canvases live under `<dataDir>/canvas`, artifacts in
   * `<dataDir>/artifacts` — the directory `artifacts.get` already serves from.
   */
  dataDir: string;
  /**
   * The host's egress allow list. Empty (the default) means no canvas document
   * can reach any host at all, and a document that declares a host outside this
   * list is refused rather than narrowed.
   */
  allowedHosts?: readonly string[];
  maxDocumentBytes?: number;
  cacheMaxBytes?: number;
  cacheMaxEntries?: number;
  maxDocuments?: number;
  maxArtifactBytes?: number;
  maxArtifacts?: number;
  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => number;
}

export interface ResolvedCanvasOptions {
  readonly dataDir: string;
  readonly egress: readonly EgressEntry[];
  readonly maxDocumentBytes: number;
  readonly cacheMaxBytes: number;
  readonly cacheMaxEntries: number;
  readonly maxDocuments: number;
  readonly maxArtifactBytes: number;
  readonly maxArtifacts: number;
  readonly now: () => number;
}

/**
 * Validate options once, at construction.
 *
 * A bad allow list has to fail the host start loudly. An entry that was meant to
 * be a host and is actually a typo must not degrade into "that document is
 * mysteriously refused", and it certainly must not degrade into "everything is
 * allowed".
 */
export function resolveCanvasOptions(options: CanvasCapabilityOptions): ResolvedCanvasOptions {
  if (typeof options.dataDir !== 'string' || options.dataDir.trim() === '') {
    throw new CanvasError('bad-request', 'canvas capability needs a dataDir to store canvases and artifacts under');
  }

  return {
    dataDir: options.dataDir,
    egress: normalizeEgressList(options.allowedHosts ?? []),
    maxDocumentBytes: positiveInt(options.maxDocumentBytes, CANVAS_LIMITS.maxDocumentBytes, 'maxDocumentBytes'),
    cacheMaxBytes: positiveInt(options.cacheMaxBytes, CANVAS_LIMITS.cacheMaxBytes, 'cacheMaxBytes'),
    cacheMaxEntries: positiveInt(options.cacheMaxEntries, CANVAS_LIMITS.cacheMaxEntries, 'cacheMaxEntries'),
    maxDocuments: positiveInt(options.maxDocuments, CANVAS_LIMITS.maxDocuments, 'maxDocuments'),
    maxArtifactBytes: positiveInt(options.maxArtifactBytes, CANVAS_LIMITS.maxArtifactBytes, 'maxArtifactBytes'),
    maxArtifacts: positiveInt(options.maxArtifacts, CANVAS_LIMITS.maxArtifacts, 'maxArtifacts'),
    now: options.now ?? Date.now,
  };
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CanvasError('bad-request', `${name} must be a positive whole number, got ${JSON.stringify(value)}`);
  }
  return value;
}
