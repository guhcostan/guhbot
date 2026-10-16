/**
 * The egress policy: what this capability is willing to point a browser at.
 *
 * Default deny. `allowedHosts` is the only way in, and an empty list means the
 * browser cannot navigate anywhere at all. Two properties matter more than
 * convenience here:
 *
 *  1. **Every hop is checked, not just the first.** A page is free to answer
 *     with `Location: https://evil.example/`. The requested URL passing the
 *     policy says nothing about the resolved one, so both the request
 *     interceptor (which sees each redirect hop as its own request) and the
 *     post-navigation final-URL check call into this module.
 *  2. **Host matching is strict.** `a.example.com` does NOT match `example.com`.
 *     A page on a shared host (`foo.github.io`) must not become reachable just
 *     because someone allow-listed a sibling. An operator who wants a domain and
 *     its children writes a leading dot: `.example.com`.
 *
 * Danger is judged on the *parsed* URL, never on the raw string: `new URL()`
 * normalises case, strips userinfo and resolves the real host, so
 * `https://example.com@evil.example/` is judged as `evil.example`.
 */

/** Schemes that reach outside the browser sandbox and are refused outright. */
const DANGEROUS_SCHEMES: ReadonlySet<string> = new Set([
  'file:',
  'data:',
  'javascript:',
  'blob:',
  'chrome:',
  'about:',
]);

/** The only schemes a navigation target may use. */
const NAVIGABLE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/** The blank document a fresh context starts on. Never a navigation target. */
export const BLANK_PAGE_URL = 'about:blank';

export interface AllowEntry {
  /** Lowercase, punycode-encoded hostname, IPv6 literals kept in brackets. */
  readonly host: string;
  /** Explicit port, or null for "any port". */
  readonly port: string | null;
  /** True for `.example.com` / `*.example.com`, which also match the bare host. */
  readonly includeSubdomains: boolean;
}

/**
 * Parse one allow-list entry.
 *
 * Throws on anything malformed rather than silently ignoring it: a typo in a
 * security list must fail the host start loudly, not degrade into "this host is
 * unreachable and nobody knows why".
 */
export function parseAllowEntry(raw: string): AllowEntry {
  const value = raw.trim();
  if (value === '') throw new Error('allow-list entry is empty');

  if (value === '*' || value === '*.') {
    throw new Error(
      `allow-list entry ${JSON.stringify(raw)} matches every host; list the hosts the browser needs, or leave allowedHosts empty for no egress`,
    );
  }

  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value);
  let rest = scheme ? value.slice(scheme[0].length) : value;
  if (rest.includes('/')) {
    throw new Error(`allow-list entry ${JSON.stringify(raw)} must name a host, not a URL path`);
  }

  let includeSubdomains = false;
  if (rest.startsWith('*.')) {
    includeSubdomains = true;
    rest = rest.slice(2);
  } else if (rest.startsWith('.')) {
    includeSubdomains = true;
    rest = rest.slice(1);
  }

  let host = rest;
  let port: string | null = null;
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end === -1) throw new Error(`allow-list entry ${JSON.stringify(raw)} has an unterminated IPv6 literal`);
    host = rest.slice(0, end + 1);
    const tail = rest.slice(end + 1);
    if (tail.startsWith(':')) port = tail.slice(1);
    else if (tail !== '') throw new Error(`allow-list entry ${JSON.stringify(raw)} has trailing junk after the IPv6 literal`);
  } else {
    const colon = rest.indexOf(':');
    if (colon !== -1) {
      host = rest.slice(0, colon);
      port = rest.slice(colon + 1);
    }
  }

  const normalized = normalizeHostname(host);
  if (normalized === '') throw new Error(`allow-list entry ${JSON.stringify(raw)} has no host`);
  if (includeSubdomains && normalized.startsWith('[')) {
    throw new Error(`allow-list entry ${JSON.stringify(raw)} cannot combine a subdomain wildcard with an IP literal`);
  }
  if (port !== null && !/^\d{1,5}$/.test(port)) {
    throw new Error(`allow-list entry ${JSON.stringify(raw)} has an invalid port`);
  }

  return { host: normalized, port, includeSubdomains };
}

/**
 * Lowercase, strip the DNS root dot, and encode an internationalised name.
 *
 * The punycode step matters: the browser reports `xn--exmple-cua.com`, so an
 * operator who wrote `exämple.com` would otherwise never match.
 */
export function normalizeHostname(host: string): string {
  const trimmed = host.trim().toLowerCase().replace(/\.$/, '');
  if (!/[^\x00-\x7f]/.test(trimmed)) return trimmed;
  try {
    return new URL(`http://${trimmed}`).hostname;
  } catch {
    return trimmed;
  }
}

/** Parse and validate a whole list, failing on the first bad entry. */
export function normalizeAllowList(entries: readonly string[]): AllowEntry[] {
  return entries.map(parseAllowEntry);
}

/**
 * about:blank is the one `about:` URL that is not dangerous: it is the empty
 * document a context starts on. It is still not a *navigable* target, because
 * there is nothing there to read.
 */
export function isDangerousScheme(protocol: string, href: string): boolean {
  if (protocol === 'about:' && href === BLANK_PAGE_URL) return false;
  return DANGEROUS_SCHEMES.has(protocol);
}

function tryParse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function defaultPort(protocol: string): string {
  if (protocol === 'http:') return '80';
  if (protocol === 'https:') return '443';
  return '';
}

/** True when `url` is reachable through `entry`. */
export function hostMatches(entry: AllowEntry, url: URL): boolean {
  const host = normalizeHostname(url.hostname);
  if (entry.includeSubdomains) {
    // The dot is load-bearing: it stops `evil-example.com` matching `.example.com`.
    if (host !== entry.host && !host.endsWith(`.${entry.host}`)) return false;
  } else if (host !== entry.host) {
    return false;
  }

  if (entry.port === null) return true;
  const port = url.port !== '' ? url.port : defaultPort(url.protocol);
  return port === entry.port;
}

/**
 * Why a URL is not allowed, or null when it is.
 *
 * Returning the reason (rather than a boolean) is what lets a refusal reach the
 * model as an actionable sentence instead of a bare "denied".
 */
export function navigationRefusal(rawUrl: string, allowedHosts: readonly string[]): string | null {
  const url = tryParse(rawUrl);
  if (!url) return `${JSON.stringify(rawUrl)} is not a valid absolute URL`;

  if (isDangerousScheme(url.protocol, url.href)) {
    return `the ${url.protocol} scheme is refused (file, data, javascript, blob, chrome and about URLs never reach the page)`;
  }
  if (!NAVIGABLE_SCHEMES.has(url.protocol)) {
    return `only http and https may be navigated, not ${url.protocol}`;
  }

  const entries = normalizeAllowList(allowedHosts);
  if (entries.length === 0) {
    return 'this host has no browser egress: allowedHosts is empty';
  }
  if (!entries.some((entry) => hostMatches(entry, url))) {
    const list = allowedHosts.map((entry) => entry.trim()).join(', ');
    return `host ${url.hostname} is not in the browser allow list (${list})`;
  }
  return null;
}

/** True when this URL is a legal navigation target. */
export function isNavigationAllowed(rawUrl: string, allowedHosts: readonly string[]): boolean {
  return navigationRefusal(rawUrl, allowedHosts) === null;
}

export interface RequestDecision {
  readonly allowed: boolean;
  readonly host: string;
  /** null when allowed. */
  readonly reason: string | null;
}

/**
 * The decision the request interceptor makes for every single request the
 * browser issues, including each hop of a redirect chain and every subresource.
 *
 * The allow list applies to all of them. A page that pulls assets from a host
 * the operator did not list renders incompletely, which is the intended
 * tradeoff: a browser that can be told to load `https://attacker.example/?d=…`
 * is an exfiltration channel, and the model can be talked into it by the page it
 * just read.
 */
export function decideRequest(rawUrl: string, allowedHosts: readonly string[]): RequestDecision {
  const url = tryParse(rawUrl);
  const reason = navigationRefusal(rawUrl, allowedHosts);
  return { allowed: reason === null, host: url?.hostname ?? '', reason };
}
