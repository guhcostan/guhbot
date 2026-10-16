/**
 * Addressing a host on the local network.
 *
 * Deliberately free of `react-native` imports and of the `URL` global: React
 * Native's `URL` is not spec-complete for custom schemes, and these parsers run
 * on the pairing screen before any host is reachable, where a throw is a dead
 * end for the user.
 */

export interface HostEndpoint {
  readonly host: string;
  readonly port: number;
}

const BRACKETED_IPV6 = /^\[([0-9A-Fa-f:.]+)\]$/;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Returns the canonical host, or null when the value cannot be a host name. */
export function normalizeHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return null;
  const bracketed = BRACKETED_IPV6.exec(trimmed);
  if (bracketed !== null) return bracketed[1] ?? null;
  // `host:port` in one field is ambiguous with a bare IPv6 literal; the user
  // gets two fields instead.
  if (trimmed.includes(':')) return null;
  return HOSTNAME.test(trimmed) ? trimmed : null;
}

export function parsePort(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= 65535 ? value : null;
}

export type EndpointParse = { readonly ok: true; readonly endpoint: HostEndpoint } | { readonly ok: false; readonly error: string };

export function parseEndpoint(host: string, port: string): EndpointParse {
  const normalized = normalizeHost(host);
  if (normalized === null) {
    return { ok: false, error: 'That is not a host address. Use the one guhbot printed, for example 192.168.1.20.' };
  }
  const parsedPort = parsePort(port);
  if (parsedPort === null) {
    return { ok: false, error: `"${port.trim()}" is not a port. Use the number guhbot printed when it started.` };
  }
  return { ok: true, endpoint: { host: normalized, port: parsedPort } };
}

/** The host serves RPC on `/rpc` and on nothing else. */
export function rpcUrl(endpoint: HostEndpoint): string {
  // An IPv6 literal needs its brackets back inside a URL authority.
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host;
  return `ws://${host}:${endpoint.port}/rpc`;
}

export function describeEndpoint(endpoint: HostEndpoint): string {
  return `${endpoint.host}:${endpoint.port}`;
}
