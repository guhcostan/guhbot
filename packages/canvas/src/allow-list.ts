import { CanvasError } from './errors.js';

/**
 * The host's egress allow list, matched the way the browser capability matches
 * its own.
 *
 * Mirroring the vocabulary is deliberate: an operator who has written
 * `.example.com` in one list must not have to learn a second dialect for the
 * other. A bare host matches exactly that host; a leading dot (or `*.`) also
 * matches subdomains, with the separating dot load-bearing so that
 * `evil-example.com` never matches `.example.com`.
 *
 * `*` is refused outright. The list exists because a human chose those hosts;
 * an entry that matches everything makes the choice meaningless.
 */
export interface EgressEntry {
  /** Lowercase, punycode-encoded hostname. */
  readonly host: string;
  /** Explicit port, or null for "any port". */
  readonly port: string | null;
  /** True for `.example.com` / `*.example.com`, which also match the bare host. */
  readonly includeSubdomains: boolean;
}

export function parseEgressEntry(raw: string): EgressEntry {
  const value = raw.trim();
  if (value === '') throw new CanvasError('bad-request', 'egress allow-list entry is empty');
  if (value === '*' || value === '*.') {
    throw new CanvasError(
      'bad-request',
      `egress allow-list entry ${JSON.stringify(raw)} matches every host; list the hosts a document may reach, or leave the list empty for no egress`,
    );
  }
  if (value.includes('[')) {
    // Supported by the browser policy, not needed here, and silently accepting a
    // form we do not match correctly would be worse than refusing it.
    throw new CanvasError('bad-request', `egress allow-list entry ${JSON.stringify(raw)}: IPv6 literals are not supported here`);
  }

  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value);
  let rest = scheme ? value.slice(scheme[0].length) : value;
  if (rest.includes('/')) {
    throw new CanvasError('bad-request', `egress allow-list entry ${JSON.stringify(raw)} must name a host, not a URL path`);
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
  const colon = rest.lastIndexOf(':');
  if (colon !== -1) {
    host = rest.slice(0, colon);
    port = rest.slice(colon + 1);
  }

  const normalized = normalizeHostname(host);
  if (normalized === '') throw new CanvasError('bad-request', `egress allow-list entry ${JSON.stringify(raw)} has no host`);
  if (port !== null && !/^\d{1,5}$/.test(port)) {
    throw new CanvasError('bad-request', `egress allow-list entry ${JSON.stringify(raw)} has an invalid port`);
  }

  return { host: normalized, port, includeSubdomains };
}

/** Lowercase, strip the DNS root dot, and encode an internationalised name. */
export function normalizeHostname(host: string): string {
  const trimmed = host.trim().toLowerCase().replace(/\.$/, '');
  if (!/[^\x00-\x7f]/.test(trimmed)) return trimmed;
  try {
    return new URL(`http://${trimmed}`).hostname;
  } catch {
    return trimmed;
  }
}

export function normalizeEgressList(entries: readonly string[]): EgressEntry[] {
  return entries.map(parseEgressEntry);
}

/**
 * True when `host` on `port` is reachable through one of the entries.
 *
 * `port` is the effective port, already defaulted by the caller: the caller
 * knows the scheme and therefore whether the default is 443 or something else.
 */
export function egressAllows(entries: readonly EgressEntry[], host: string, port: string): boolean {
  const normalized = normalizeHostname(host);
  for (const entry of entries) {
    const hostMatches = entry.includeSubdomains
      ? normalized === entry.host || normalized.endsWith(`.${entry.host}`)
      : normalized === entry.host;
    if (!hostMatches) continue;
    if (entry.port === null || entry.port === port) return true;
  }
  return false;
}
