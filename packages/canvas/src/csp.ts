import { z } from 'zod';
import { egressAllows, type EgressEntry } from './allow-list.js';
import { CanvasError } from './errors.js';

/**
 * The per-document content security policy.
 *
 * A canvas document is HTML a model wrote, possibly after reading a page
 * somebody else controls. The policy is built per document from what that
 * document declared it needs, so a chart that only draws inline shapes gets a
 * policy that would refuse a network request even if a later revision of the
 * document tried one.
 *
 * What is fixed, and never declarable:
 *
 *  - **no remote script.** Inline script is allowed because agent-authored HTML
 *    is worthless without it; a remote script origin is a supply chain the user
 *    never agreed to, and `'unsafe-eval'` / `'wasm-unsafe-eval'` turn any string
 *    the document happens to hold into code.
 *  - **no remote frames.** A framed page is another origin's code running with
 *    the user's network position; nothing a canvas legitimately needs.
 *  - **no forms, no workers, no plugins, no `<base>`.** Each is a way out of
 *    the document or a way to send data somewhere the policy did not name.
 *  - **`connect-src 'none'`.** Fetch, XHR and WebSocket all land here, so a
 *    document that did not explicitly ask for a host cannot exfiltrate anything
 *    even if it is talked into trying.
 *
 * Declared hosts are ANDed with the host's own egress allow list: a document
 * cannot name a host the operator never allowed, so the allow list stays the
 * single place a human decides what this host can reach.
 */

export const CanvasCspDeclarationsSchema = z
  .object({
    connectHosts: z.array(z.string().min(1).max(255)).max(16).optional(),
    imageHosts: z.array(z.string().min(1).max(255)).max(16).optional(),
    styleHosts: z.array(z.string().min(1).max(255)).max(16).optional(),
    fontHosts: z.array(z.string().min(1).max(255)).max(16).optional(),
    mediaHosts: z.array(z.string().min(1).max(255)).max(16).optional(),
  })
  .strict();

export type CanvasCspDeclarations = z.infer<typeof CanvasCspDeclarationsSchema>;

/**
 * Keys that are refused with a reason.
 *
 * The strict schema already rejects anything unknown, but "Unrecognized key(s)
 * in object" for `scriptHosts` reads like a typo rather than a policy. These get
 * a sentence that says the thing is never available.
 */
const NEVER_DECLARABLE: ReadonlySet<string> = new Set([
  'scriptHosts',
  'scripts',
  'evalHosts',
  'wasmHosts',
  'frameHosts',
  'frames',
  'childHosts',
  'workerHosts',
  'objectHosts',
  'allowedHosts',
]);

/**
 * An origin, and nothing else: no wildcard, no path, no query, no userinfo.
 *
 * Plain `http:` is refused even for images. A canvas document is rendered next
 * to the user's own session; letting it pull a stylesheet or an image over
 * plaintext hands anyone on the network path a way to observe and rewrite what
 * the user is looking at.
 */
const ORIGIN_PATTERN = /^(https|wss):\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/i;

export interface CanvasCspPlan {
  /** The policy string, ready for the document's meta tag. */
  readonly policy: string;
  /** Origins actually granted, for diagnostics and for the tool result. */
  readonly declared: {
    readonly connectHosts: readonly string[];
    readonly imageHosts: readonly string[];
    readonly styleHosts: readonly string[];
    readonly fontHosts: readonly string[];
    readonly mediaHosts: readonly string[];
  };
}

export function planCanvasCsp(declared: unknown, egress: readonly EgressEntry[]): CanvasCspPlan {
  refuseNeverDeclarable(declared);

  const parsed = CanvasCspDeclarationsSchema.safeParse(declared ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'csp'}: ${issue.message}`)
      .join('; ');
    throw new CanvasError('bad-request', `canvas CSP declarations were refused: ${detail}`);
  }

  const connectHosts = resolveHosts(parsed.data.connectHosts ?? [], 'connect-src', egress, true);
  const imageHosts = resolveHosts(parsed.data.imageHosts ?? [], 'img-src', egress, false);
  const styleHosts = resolveHosts(parsed.data.styleHosts ?? [], 'style-src', egress, false);
  const fontHosts = resolveHosts(parsed.data.fontHosts ?? [], 'font-src', egress, false);
  const mediaHosts = resolveHosts(parsed.data.mediaHosts ?? [], 'media-src', egress, false);

  const directives = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    sources('style-src', ["'unsafe-inline'"], styleHosts),
    sources('img-src', ['data:'], imageHosts),
    sources('font-src', [], fontHosts),
    sources('media-src', ['data:'], mediaHosts),
    sources('connect-src', [], connectHosts),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
  ];

  // `frame-ancestors` is deliberately absent: it is ignored in a policy
  // delivered by a meta tag, and this package never serves headers. Whether a
  // canvas may be framed is the client's decision, made where the frame is
  // created.
  return {
    policy: directives.join('; '),
    declared: { connectHosts, imageHosts, styleHosts, fontHosts, mediaHosts },
  };
}

function refuseNeverDeclarable(declared: unknown): void {
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) return;
  for (const key of Object.keys(declared)) {
    if (!NEVER_DECLARABLE.has(key)) continue;
    throw new CanvasError(
      'forbidden',
      `a canvas document may not declare ${JSON.stringify(key)}: remote script, remote frames, workers and plugins are never allowed in a canvas`,
    );
  }
}

function resolveHosts(
  declared: readonly string[],
  directive: string,
  egress: readonly EgressEntry[],
  allowWss: boolean,
): string[] {
  const resolved: string[] = [];
  for (const raw of declared) {
    const origin = parseOrigin(raw, directive, egress, allowWss);
    if (!resolved.includes(origin)) resolved.push(origin);
  }
  return resolved;
}

function parseOrigin(raw: string, directive: string, egress: readonly EgressEntry[], allowWss: boolean): string {
  const value = raw.trim();
  const match = ORIGIN_PATTERN.exec(value);
  const scheme = (match?.[1] ?? '').toLowerCase();
  const host = match?.[2] ?? '';
  const port = match?.[3] ?? null;

  if (match === null || host === '') {
    throw new CanvasError(
      'bad-request',
      `${directive} host ${JSON.stringify(raw)} must be an https:// origin with no path, wildcard or userinfo`,
    );
  }
  if (scheme === 'wss' && !allowWss) {
    throw new CanvasError('bad-request', `${directive} does not accept a wss:// origin; use https:// for this directive`);
  }
  if (port !== null && (Number(port) < 1 || Number(port) > 65535)) {
    throw new CanvasError('bad-request', `${directive} host ${JSON.stringify(raw)} has a port outside 1-65535`);
  }

  // Every declared origin has to be inside the operator's egress allow list.
  // This is the line that keeps a model-chosen hostname from widening what the
  // host is willing to reach.
  if (!egressAllows(egress, host, port ?? '443')) {
    throw new CanvasError(
      'forbidden',
      `${directive} host ${scheme}://${host}${port === null ? '' : `:${port}`} is not in this host's egress allow list`,
    );
  }

  return `${scheme}://${host}${port === null ? '' : `:${port}`}`;
}

function sources(directive: string, base: readonly string[], hosts: readonly string[]): string {
  const values = [...base, ...hosts];
  return `${directive} ${values.length > 0 ? values.join(' ') : "'none'"}`;
}
