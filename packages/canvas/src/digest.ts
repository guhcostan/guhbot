import { createHash } from 'node:crypto';
import { CanvasError } from './errors.js';

/**
 * Content addressing.
 *
 * A canvas document is named by the SHA-256 of the bytes a renderer will
 * receive. Two consequences follow, and both are the point of the design:
 *
 *  1. **A document cannot change under a reader.** The id is a promise about
 *     the bytes. Serving by digest means a later write can never silently alter
 *     what a client already holds a link to.
 *  2. **Caching is safe.** Keying the cache on the digest removes the usual
 *     cache-invalidation problem entirely, which is why the store can keep an
 *     LRU without ever holding a stale document.
 *
 * The CSP meta tag is part of the addressed bytes, not something added at serve
 * time. An attacker who could edit the file on disk to strip the policy would
 * change the served document while leaving the id intact; hashing the served
 * form means that edit is caught instead.
 */
export const CANVAS_ID_PATTERN = /^[0-9a-f]{64}$/;

export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isCanvasId(value: string): boolean {
  return CANVAS_ID_PATTERN.test(value);
}

/** True when these bytes are the content that `id` names. */
export function matchesDigest(id: string, bytes: Uint8Array): boolean {
  return isCanvasId(id) && digestOf(bytes) === id;
}

export function assertCanvasId(value: string): string {
  if (!isCanvasId(value)) {
    throw new CanvasError(
      'bad-request',
      `canvas id must be the 64-character lowercase sha256 of the document, got ${JSON.stringify(value.slice(0, 96))}`,
    );
  }
  return value;
}
