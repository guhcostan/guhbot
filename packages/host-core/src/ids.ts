import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Identifiers are opaque, prefixed, and lexicographically sortable where it
 * matters. The prefix makes a log line self-describing (`ag_01J...` is an agent)
 * and lets the protocol validators reject a thread id passed where an agent id
 * was expected before it reaches the database.
 */
export type IdPrefix = 'ag' | 'gr' | 'en' | 'rn' | 'dv' | 'pr' | 'ap' | 'sec' | 'mcp' | 'rt' | 'au' | 'tk' | 'host';

export function newId(prefix: IdPrefix): string {
  // randomUUID is v4: 122 bits of entropy, plenty, and collision-free in practice.
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Constant-time-ish comparison for short codes; avoids leaking length via early return on `===`. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * A pairing code is short enough to read aloud and type on a phone. 8 digits
 * from a CSPRNG gives ~26.6 bits, which is only acceptable because a code is
 * single-use, expires in minutes, and the host rate-limits redemptions.
 */
export function newPairingCode(): string {
  return Array.from(randomBytes(8), (b) => String(b % 10)).join('');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
