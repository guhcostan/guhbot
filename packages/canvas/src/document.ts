import { escapeHtmlAttribute } from './util.js';

/**
 * The document a renderer actually receives.
 *
 * The enforced policy travels with the bytes as a meta tag rather than in a
 * response header, because the bytes are the deliverable: a client may render
 * them from the store, from a cache, or from a message, and the policy has to
 * apply in all three cases. The meta tag is injected immediately after the
 * doctype, before any author byte, so nothing in the document is ever parsed
 * under a policy the document itself chose. (CSP policies intersect, so a meta
 * tag the author adds later can only tighten this one — but it must never be
 * possible to render content before ours applies.)
 *
 * The served form is what gets hashed and stored, so the content address covers
 * the policy as well as the author's HTML: stripping the policy from the store
 * changes the digest and the document stops being served at all.
 */
export const CANVAS_CSP_MARKER = '<!--guhbot-canvas:csp-->';

const LEADING_DOCTYPE = /^\uFEFF?\s*<!doctype\s+html\s*>/i;

/** Our own injected block, recognised by the marker so it can be replaced. */
const INJECTED_BLOCK = /^\s*<!--guhbot-canvas:csp-->\s*<meta http-equiv="Content-Security-Policy" content="[^"]*">/i;

export function wrapCanvasDocument(html: string, policy: string): string {
  const withoutBom = html.startsWith('\uFEFF') ? html.slice(1) : html;

  // Re-wrap rather than stack. `canvas_read` hands the served bytes back to the
  // agent so it can revise them, and a second create must not end up with two
  // injected blocks or with a stale policy from the previous revision.
  const body = withoutBom.replace(LEADING_DOCTYPE, '').replace(INJECTED_BLOCK, '');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(policy)}">`;

  return `<!DOCTYPE html>${CANVAS_CSP_MARKER}${meta}${body}`;
}
