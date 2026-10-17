/**
 * `guhbot://pair?host=..&port=..&id=..&code=..`
 *
 * The host console renders this as a QR code; a phone that scans it must land
 * on the pairing screen with every field filled in. Parsing is hand-rolled for
 * the reasons in `endpoint.ts`, and it never throws: a bad link produces a
 * sentence the user can act on.
 */
import { normalizeHost, parsePort, type HostEndpoint } from './endpoint';

export const PAIRING_SCHEME = 'guhbot';
export const PAIRING_ACTION = 'pair';

export interface PairingLink extends HostEndpoint {
  readonly pairingId: string;
  readonly code: string;
}

export type PairingLinkResult = { readonly ok: true; readonly link: PairingLink } | { readonly ok: false; readonly error: string };

function fail(error: string): PairingLinkResult {
  return { ok: false, error };
}

function decodeComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parsePairingUri(raw: string): PairingLinkResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fail('There is no pairing link here yet.');

  const schemeEnd = trimmed.indexOf(':');
  if (schemeEnd <= 0) return fail(`That is not a ${PAIRING_SCHEME} pairing link.`);
  const scheme = trimmed.slice(0, schemeEnd).toLowerCase();
  if (scheme !== PAIRING_SCHEME) return fail(`Expected a ${PAIRING_SCHEME}:// link, got ${scheme}://.`);

  let rest = trimmed.slice(schemeEnd + 1);
  if (rest.startsWith('//')) rest = rest.slice(2);
  // A fragment is never part of a pairing link, and it would corrupt the last
  // query value if we parsed past it.
  const hashAt = rest.indexOf('#');
  if (hashAt >= 0) rest = rest.slice(0, hashAt);

  const queryAt = rest.indexOf('?');
  const action = (queryAt >= 0 ? rest.slice(0, queryAt) : rest).replace(/\/+$/, '');
  if (action !== PAIRING_ACTION) {
    return fail(`Expected the "${PAIRING_ACTION}" action, got "${action.length > 0 ? action : '(none)'}".`);
  }

  const params = new Map<string, string>();
  for (const pair of (queryAt >= 0 ? rest.slice(queryAt + 1) : '').split('&')) {
    if (pair.length === 0) continue;
    const equalsAt = pair.indexOf('=');
    const key = decodeComponent(equalsAt < 0 ? pair : pair.slice(0, equalsAt));
    const value = equalsAt < 0 ? '' : decodeComponent(pair.slice(equalsAt + 1));
    if (key === null || value === null) return fail('The pairing link contains invalid percent-encoding.');
    // First occurrence wins, so a duplicated parameter cannot silently replace
    // the host the user scanned.
    if (!params.has(key)) params.set(key, value);
  }

  const hostRaw = params.get('host') ?? '';
  const portRaw = params.get('port') ?? '';
  const idRaw = params.get('id') ?? '';
  const codeRaw = params.get('code') ?? '';
  const missing = [
    hostRaw.trim().length === 0 ? 'host' : null,
    portRaw.trim().length === 0 ? 'port' : null,
    idRaw.trim().length === 0 ? 'id' : null,
    codeRaw.trim().length === 0 ? 'code' : null,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) return fail(`The pairing link is missing ${missing.join(', ')}.`);

  const host = normalizeHost(hostRaw);
  if (host === null) return fail(`"${hostRaw.trim()}" is not a host address this phone can dial.`);

  const port = parsePort(portRaw);
  if (port === null) return fail(`"${portRaw.trim()}" is not a valid port.`);

  const pairingId = idRaw.trim();
  if (pairingId.length === 0 || pairingId.length > 128) return fail('The pairing id in the link is not usable.');

  const code = codeRaw.trim();
  if (!/^\d{8}$/.test(code)) return fail('The pairing code must be the 8 digits guhbot printed on the host.');

  const secure = params.get('secure') === '1';
  const path = params.get('path');
  if (path && !/^\/(?:rpc|t\/t_[a-f0-9]{24}\/rpc)$/.test(path)) return fail('The pairing link contains an invalid host path.');
  return { ok: true, link: { host, port, pairingId, code, ...(secure ? { secure: true } : {}), ...(path ? { path } : {}) } };
}
