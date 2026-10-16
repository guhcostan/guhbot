import { isIP } from 'node:net';

/**
 * The origin matcher. This file is the package; everything else is bookkeeping
 * around it.
 *
 * A credential for `https://example.com` is released only to a request whose
 * canonical origin is *exactly* that string. Nothing else in this repository
 * decides what "exactly" means, so the rules are written out here in full.
 *
 * ## Canonicalise, then compare
 *
 * The comparison is byte equality of the canonical serialisation
 * `https://<host>[:<port>]`. Canonicalisation is done by the WHATWG URL parser
 * (`new URL`), which is the same parser a browser uses to decide which origin
 * it is talking to. That matters more than it looks: it is why
 * `https://exämple.com` and `https://xn--exmple-cua.com` are *the same origin*
 * (both are the same IDN host), why `https://example.com:443` is the same
 * origin as `https://example.com`, and why `https://010.1.1.1` is `8.1.1.1`.
 * An approval is recorded against the canonical spelling, the person is shown
 * that spelling, and the release path compares against it, so there is exactly
 * one spelling of every origin in the system and no gap between "what the
 * browser will do" and "what we matched".
 *
 * ## Why the match cannot be fooled by a lookalike
 *
 * There is no suffix, prefix or substring logic anywhere below. Exact equality
 * of `(scheme, host, port)` is what makes `https://example.com.evil.com`,
 * `https://evil.com` (as a suffix of a legitimate host), `https://app.example.com`
 * and `https://notexample.com` non-matches *by construction* rather than by a
 * test that happened to be written. A punycode lookalike such as
 * `https://xn--exmple-cua.com` is a different host from `https://example.com`
 * and so is a different origin, even though the two render almost identically.
 *
 * ## What is refused outright
 *
 * Anything that is not an `https` origin with no userinfo, no path, no query
 * and no fragment normalises to `null`, and a `null` never matches anything —
 * not even another `null`. That includes `http://`, deliberately: a plaintext
 * origin cannot be approved and cannot be matched, because releasing a session
 * credential to `http://` puts it on the wire in the clear for anyone on the
 * path. A downgrade is therefore not a match *and* not an approvable origin.
 */

/** Only `https`. Plaintext origins are refused — see the note above. */
export type OriginScheme = 'https';

export interface NormalisedOrigin {
  readonly scheme: OriginScheme;
  /** Lowercase, punycode for IDNs, no trailing dot, bracketed for IPv6. */
  readonly host: string;
  /** Effective port, `443` when the URL did not name one. */
  readonly port: number;
  /** The canonical serialisation, and the only string this package stores. */
  readonly origin: string;
}

/** Name prefix for the sealed value row, in `host-core`'s `secrets` table. */
export const CREDENTIAL_NAME_PREFIX = 'origin:';

export const DEFAULT_HTTPS_PORT = 443;

const MAX_ORIGIN_CHARS = 2048;
const MAX_HOST_CHARS = 253;
const MAX_LABEL_CHARS = 63;
/**
 * A DNS label: letters, digits and internal hyphens. Underscores and
 * percent-escapes are refused rather than carried through, because a host this
 * package cannot pin to a DNS name is a host whose canonical form we cannot
 * promise to agree with a browser about.
 */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function canonicalHost(rawHostname: string): string | null {
  if (rawHostname.length === 0) return null;

  // The URL parser already canonicalised an IPv6 literal and kept its brackets
  // (`[0:0:0:0:0:0:0:1]` arrives as `[::1]`), so the comparison is exact.
  if (rawHostname.startsWith('[')) {
    if (!rawHostname.endsWith(']') || rawHostname.length < 4) return null;
    return isIP(rawHostname.slice(1, -1)) === 6 ? rawHostname.toLowerCase() : null;
  }

  let host = rawHostname.toLowerCase();
  // A single trailing dot is the DNS root form of the same name. Exactly one:
  // `example.com..` is a malformed name and is refused below.
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > MAX_HOST_CHARS) return null;
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
  // IPv4 in any of its numeric spellings was already canonicalised to a dotted
  // quad by the URL parser.
  if (isIP(host) !== 0) return host;

  for (const label of host.split('.')) {
    if (label.length === 0 || label.length > MAX_LABEL_CHARS) return null;
    if (!DNS_LABEL.test(label)) return null;
  }
  return host;
}

/**
 * Canonicalise an origin, or return `null` when the input is not one.
 *
 * `null` means "this is not an origin I am willing to reason about". Callers
 * must treat it as a refusal: a release for a `null` origin releases nothing.
 */
export function normaliseOrigin(input: string): NormalisedOrigin | null {
  // Defensive: another package can call this from JavaScript with anything.
  if (typeof input !== 'string') return null;
  if (input.length === 0 || input.length > MAX_ORIGIN_CHARS) return null;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  // A bare trailing slash is the canonical form of a pathless origin; anything
  // else is a URL, not an origin, and the caller should have reduced it first.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;

  const host = canonicalHost(url.hostname);
  if (host === null) return null;

  const port = url.port === '' ? DEFAULT_HTTPS_PORT : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    scheme: 'https',
    host,
    port,
    origin: port === DEFAULT_HTTPS_PORT ? `https://${host}` : `https://${host}:${port}`,
  };
}

/**
 * The matcher: do these two strings denote the same origin?
 *
 * Pure, total, and fail-closed. Two inputs that are not both canonicalisable
 * https origins never match, including when they are the same invalid string.
 */
export function originsMatch(left: string, right: string): boolean {
  const a = normaliseOrigin(left);
  if (a === null) return false;
  const b = normaliseOrigin(right);
  if (b === null) return false;
  return a.origin === b.origin;
}

/**
 * The storage name for an origin's sealed value, in `host-core`'s `secrets`
 * table. `null` when the input is not an approvable origin.
 *
 * This is the documented contract for whoever stores a credential: the name
 * must come from here, because a name that was not canonicalised will not be
 * found by `release` and will not match any approval.
 */
export function credentialSecretName(input: string): string | null {
  const origin = normaliseOrigin(input);
  return origin === null ? null : `${CREDENTIAL_NAME_PREFIX}${origin.origin}`;
}
