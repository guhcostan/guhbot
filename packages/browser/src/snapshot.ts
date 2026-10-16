import type { PageSnapshot } from './engine.js';
import type { RawLink } from './in-page.js';

/**
 * Rendering and budgeting: everything that turns an engine result into the text
 * a model reads.
 *
 * Kept free of Playwright and of the filesystem so the parts that decide *what
 * the model gets to see* are testable without a browser.
 */

export interface TruncatedText {
  readonly text: string;
  /** Bytes of the text that was kept. */
  readonly bytes: number;
  readonly truncated: boolean;
}

/**
 * Cut `text` to a UTF-8 byte budget without splitting a character.
 *
 * A naive `slice` on the 16-bit string is wrong twice over: it counts code units
 * rather than bytes, and it can land in the middle of a surrogate pair. The cut
 * is moved back until the bytes decoded so far are a valid UTF-8 string, which
 * costs at most three extra iterations.
 */
export function truncateToBytes(text: string, maxBytes: number): TruncatedText {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return { text, bytes: bytes.byteLength, truncated: false };

  const floor = Math.max(0, maxBytes - 4);
  for (let cut = maxBytes; cut > floor; cut -= 1) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, cut));
      return { text: decoded, bytes: cut, truncated: true };
    } catch {
      // The cut landed inside a multi-byte sequence; step back one byte.
    }
  }
  const fallback = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.max(0, floor)));
  return { text: fallback, bytes: Math.max(0, floor), truncated: true };
}

export function truncationMarker(kept: number, total: number, maxBytes: number): string {
  return `\n\n[truncated: showing ${kept} of ${total} bytes, budget ${maxBytes} bytes]`;
}

/** Truncate and say so, so a model never mistakes a cut page for a short one. */
export function boundedText(text: string, maxBytes: number): string {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return text;
  // Reserve the marker's bytes in its longest form (the biggest "showing N"
  // number), so the text plus the marker still fit the budget being advertised.
  const reserved = Buffer.byteLength(truncationMarker(maxBytes, total, maxBytes), 'utf8');
  const kept = truncateToBytes(text, Math.max(0, maxBytes - reserved));
  return `${kept.text}${truncationMarker(kept.bytes, total, maxBytes)}`;
}

export interface FormatOptions {
  readonly maxBytes: number;
  readonly maxElements: number;
}

/**
 * Render a snapshot, refs included.
 *
 * The ref scheme itself — when numbers are assigned, preserved and discarded —
 * is documented in `refs.ts`, next to the code that implements it.
 */
export function formatSnapshot(snapshot: PageSnapshot, options: FormatOptions): string {
  const lines: string[] = [];
  lines.push(`${snapshot.url}${snapshot.title === '' ? '' : ` — ${snapshot.title}`}`);

  if (snapshot.blockedHosts.length > 0) {
    lines.push(
      `egress policy blocked requests to: ${snapshot.blockedHosts.join(', ')} (add them to allowedHosts if the page needs them)`,
    );
  }

  lines.push('');
  lines.push('Interactive elements (refs are valid until the page changes):');
  if (snapshot.elements.length === 0) {
    lines.push('  (none found)');
  }
  for (const element of snapshot.elements.slice(0, options.maxElements)) {
    const href = element.href === null ? '' : ` -> ${element.href}`;
    const value = element.value === null || element.value === '' ? '' : ` = ${JSON.stringify(element.value)}`;
    lines.push(`  [${element.ref}] ${element.kind} ${JSON.stringify(element.label)}${href}${value}`);
  }
  if (snapshot.elementsTruncated) {
    lines.push(`  (more elements than the ${options.maxElements} this host reports; scope the read with a selector)`);
  }

  lines.push('');
  lines.push('Visible text:');
  lines.push(boundedText(snapshot.text, options.maxBytes));

  return lines.join('\n');
}

export function formatActionResult(url: string, navigated: boolean, note: string): string {
  return `${navigated ? 'Navigated to' : 'Stayed on'} ${url}\n${note}`;
}

export interface SearchFormatOptions {
  readonly query: string;
  readonly maxResults: number;
  readonly maxSnippetBytes: number;
}

export function formatSearchResults(links: readonly RawLink[], options: SearchFormatOptions): string {
  if (links.length === 0) {
    return `No results parsed for ${JSON.stringify(options.query)}. The endpoint answered, but no result links were found; it may need a different searchUrlTemplate.`;
  }
  const lines = [`Results for ${JSON.stringify(options.query)} (${links.length}):`];
  links.forEach((link, index) => {
    lines.push(`${index + 1}. ${link.title}`);
    lines.push(`   ${link.href}`);
    if (link.snippet !== '') lines.push(`   ${boundedText(link.snippet, options.maxSnippetBytes).replace(/\n+/g, ' ')}`);
  });
  if (links.length >= options.maxResults) {
    lines.push(`(capped at ${options.maxResults} results)`);
  }
  return lines.join('\n');
}

/**
 * Search endpoints differ in how they link, and most of them link to themselves,
 * to pagination and to their own preferences page. Dropping those is the
 * difference between a usable result list and a page of navigation chrome.
 */
export function rankSearchResults(
  links: readonly RawLink[],
  searchUrl: string,
  maxResults: number,
): RawLink[] {
  const searchHost = safeHost(searchUrl);
  const seen = new Set<string>();
  const results: RawLink[] = [];

  for (const link of links) {
    if (results.length >= maxResults) break;
    const host = safeHost(link.href);
    if (host === null) continue;
    if (host === searchHost) continue;
    const key = link.href.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(link);
  }
  return results;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function formatScreenshot(path: string, width: number, height: number, bytes: number): string {
  return `Saved ${width}x${height} PNG (${bytes} bytes) to ${path}\nThe image is on disk; it is never returned inline.`;
}
