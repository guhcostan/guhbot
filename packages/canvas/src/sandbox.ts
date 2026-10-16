import { CanvasError } from './errors.js';

/**
 * The iframe sandbox for every canvas document.
 *
 * This is the single most dangerous line in the package, so it is one constant
 * and nothing derives it dynamically.
 *
 * Three tokens, and the reasons they are the only three:
 *
 *  - `allow-scripts` — the document is HTML a model wrote; without script it is
 *    a screenshot.
 *  - `allow-popups` — a chart that links to its source needs to be able to open
 *    that link. The client gates the actual navigation on a live user gesture
 *    (see `admitExternalLink`).
 *  - `allow-popups-to-escape-sandbox` — an opened link is a normal browser tab
 *    the user asked for, not a sandboxed page. This is the one deliberate hole,
 *    and it is only defensible because of that gesture gate.
 *
 * What must never appear:
 *
 *  - `allow-same-origin`. With scripts already allowed, same-origin lets the
 *    document reach the host application's origin: its storage, its cookies, and
 *    whatever a request from that origin can do. The sandbox is only a boundary
 *    while the origin stays opaque.
 *  - `allow-forms`, `allow-modals`, `allow-top-navigation*`, `allow-downloads`,
 *    `allow-pointer-lock`, `allow-presentation`: navigation, dialogs and file
 *    writes are all things a document the user is *reading* has no business
 *    doing.
 */
export const CANVAS_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

/** The tokens of {@link CANVAS_SANDBOX}, in order. */
export const CANVAS_SANDBOX_TOKENS: readonly string[] = Object.freeze(CANVAS_SANDBOX.split(' '));

/** Tokens a canvas sandbox must never carry. Exported so a client can assert it. */
export const SANDBOX_TOKENS_NEVER_ALLOWED: readonly string[] = Object.freeze([
  'allow-same-origin',
  'allow-forms',
  'allow-modals',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-downloads',
  'allow-pointer-lock',
  'allow-presentation',
  'allow-storage-access-by-user-activation',
]);

/**
 * Fail closed when a sandbox value is not exactly the hardened set.
 *
 * A client that reads its sandbox string from configuration, a plugin or a
 * future theme should call this before creating the frame. Equality, not a
 * subset check: a superset is a widened boundary, and that is the failure mode
 * worth catching.
 */
export function assertCanvasSandbox(value: string): void {
  if (value !== CANVAS_SANDBOX) {
    throw new CanvasError(
      'forbidden',
      `a canvas iframe sandbox must be exactly ${JSON.stringify(CANVAS_SANDBOX)}, got ${JSON.stringify(value)}`,
    );
  }
}
