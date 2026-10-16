import type { Capability } from '@guhbot/agent';
import { ArtifactStore } from './artifacts.js';
import { createCanvasMethods } from './methods.js';
import type { CanvasCapabilityOptions } from './options.js';
import { resolveCanvasOptions } from './options.js';
import { artifactRoot, canvasPaths } from './paths.js';
import { CanvasStore } from './store.js';
import { createCanvasTools } from './tools.js';

/**
 * The canvas and artifact capability.
 *
 * An agent that can only talk is not a coworker. This is how it produces
 * something the user can *look at*: a chart, a rendered document, a small
 * interactive page — and, separately, a file on disk.
 *
 * ## Two things that are not the same thing
 *
 *  - A **canvas** is HTML this host stores, addresses by content and serves
 *    into a sandbox. We chose every byte of how it is delivered, so we can
 *    promise things about it: no same-origin access, a per-document CSP, an
 *    immutable id.
 *  - An **artifact** is a file the agent produced, in a jail, meant to be opened
 *    in some other program. It gets no CSP, no sandbox and no guarantees; it
 *    gets a path and a refusal if the path leaves the jail.
 *
 * Conflating them is how sandbox guarantees stop being true, so they are
 * separate stores, separate tools and separate roots on disk.
 *
 * ## The security model, in one place
 *
 * The HTML is model-authored and therefore hostile: a model can be talked into
 * producing anything by a page it read. So:
 *
 *  1. the iframe sandbox is exactly {@link CANVAS_SANDBOX} — no
 *     `allow-same-origin`, so the document's origin stays opaque;
 *  2. every document carries its own CSP: `default-src 'none'`, inline script
 *     and style (which the opaque origin makes survivable), and only the hosts
 *     that document declared *and* the operator allow-listed;
 *  3. documents are content-addressed, so an id is a promise about bytes, and
 *     the served bytes are re-hashed every time;
 *  4. everything is bounded — document size, store count, cache bytes and
 *     entries — and exceeding a bound is an error, never a truncation;
 *  5. paths from tool arguments go through `resolveInside`, and nothing here
 *     reads a path it was handed;
 *  6. external links are gated on a live user gesture, which is what makes the
 *     one sandbox hole (`allow-popups-to-escape-sandbox`) defensible.
 *
 * This package opens no socket and registers no scheme. Only `@guhbot/server`
 * binds anything; a client that renders canvases uses `CANVAS_SANDBOX` for the
 * frame and `canvas.get` for the bytes.
 *
 * ```ts
 * const canvas = createCanvasCapability({ dataDir, allowedHosts: ['api.example.com'] });
 * await canvas.ready?.();
 * const tools = canvas.tools?.() ?? [];
 * ```
 */
export function createCanvasCapability(options: CanvasCapabilityOptions): Capability {
  const resolved = resolveCanvasOptions(options);

  const store = new CanvasStore({
    paths: canvasPaths(resolved.dataDir),
    maxDocumentBytes: resolved.maxDocumentBytes,
    cacheMaxBytes: resolved.cacheMaxBytes,
    cacheMaxEntries: resolved.cacheMaxEntries,
    maxDocuments: resolved.maxDocuments,
    now: resolved.now,
  });

  const artifacts = new ArtifactStore({
    root: artifactRoot(resolved.dataDir),
    maxBytes: resolved.maxArtifactBytes,
    maxEntries: resolved.maxArtifacts,
    now: resolved.now,
  });

  return {
    name: 'canvas',
    summary: 'Lets an agent produce something the user can look at: sandboxed HTML canvases and files in a jailed artifact directory.',
    flags: { canvas: true },
    tools: () => createCanvasTools(store, artifacts, resolved),
    methods: createCanvasMethods(store),
    // Nothing to kill: the objects are durable and the cache is memory. Idempotent,
    // because a host that disposes twice during shutdown must not fail.
    dispose: () => store.dispose(),
  };
}

export { CANVAS_SANDBOX, CANVAS_SANDBOX_TOKENS, SANDBOX_TOKENS_NEVER_ALLOWED, assertCanvasSandbox } from './sandbox.js';
export { CANVAS_CSP_MARKER, wrapCanvasDocument } from './document.js';
export { CanvasCspDeclarationsSchema, planCanvasCsp } from './csp.js';
export type { CanvasCspDeclarations, CanvasCspPlan } from './csp.js';
export { egressAllows, normalizeEgressList, parseEgressEntry } from './allow-list.js';
export type { EgressEntry } from './allow-list.js';
export { CANVAS_ID_PATTERN, assertCanvasId, digestOf, isCanvasId, matchesDigest } from './digest.js';
export { CanvasError } from './errors.js';
export type { CanvasErrorCode } from './errors.js';
export { CANVAS_SCHEME, CANVAS_THEMES, canvasUrl, parseCanvasUrl } from './url.js';
export type { CanvasTheme, CanvasUrlParts } from './url.js';
export { ADMITTED_LINK_PROTOCOLS, LINK_GATE_WINDOW_MS, admitExternalLink } from './links.js';
export type { LinkAdmissionRequest } from './links.js';
export { CANVAS_LIMITS, resolveCanvasOptions } from './options.js';
export type { CanvasCapabilityOptions, ResolvedCanvasOptions } from './options.js';
export { artifactRoot, canvasPaths } from './paths.js';
export type { CanvasPaths } from './paths.js';
export { CanvasStore } from './store.js';
export type { CanvasCacheStats, CanvasEntry, CanvasStoreOptions } from './store.js';
export { ArtifactStore } from './artifacts.js';
export type { ArtifactEntry, ArtifactStoreOptions } from './artifacts.js';
export { createCanvasMethods } from './methods.js';
export { createCanvasTools } from './tools.js';
