import { createHash } from 'node:crypto';
import type { ServerFrame } from '@guhbot/protocol';

/**
 * What the companion removes from harness responses, and why.
 *
 * There *is* something worth stripping, and three of the categories are
 * load-bearing rather than theoretical:
 *
 * 1. **Harness topology: `addresses` and `port`.** `host.status` tells a client
 *    where to connect. The harness truthfully answers `127.0.0.1:<port>`,
 *    because that is the only place it listens. Forwarded unchanged to a phone,
 *    those two fields are not merely a disclosure of internal topology, they are
 *    a correctness bug: the phone would dial its own loopback and wait. They are
 *    replaced with the companion's own endpoint, which is where the phone
 *    actually connected.
 *
 * 2. **The harness host id.** `hostId` is stable per data directory, so it names
 *    one install across every network it is ever seen from — a peer that sees
 *    this host on a LAN and again over a tailnet can correlate the two, and any
 *    client can fingerprint the install from it. It is replaced by a one-way
 *    pseudonym that keeps the field's shape and stability without naming the
 *    harness. The raw value never leaves the machine.
 *
 * 3. **Declared filesystem prefixes.** Wherever an absolute path would appear in
 *    a *response* — including error messages, which is where they actually show
 *    up ("no artifact at /Users/.../artifacts/x") — a prefix listed in
 *    `redactPaths` becomes `<host>`. The companion cannot discover these paths
 *    on its own, and must not go looking: that means reading the harness's state,
 *    which is the harness's job. So the deployment declares the data directory
 *    and the workspace, and the companion enforces them.
 *
 * Deliberately **not** scrubbed, rather than as an oversight:
 *
 * - **Event payloads (`evt`).** Transcripts, runs and tool output are the user's
 *   own data and the agent's own words. Rewriting them at the transport layer
 *   would corrupt what every client stores, and a path inside a transcript is
 *   the agent's output, not the companion's secret. A scrubber here would be the
 *   no-op this module is supposed to avoid, with a data-mangling failure mode.
 * - **Strings the client itself supplied.** `artifacts.get` echoes back the path
 *   the caller sent; that discloses nothing the caller did not already have.
 * - **`hostVersion`, `mode`, `capabilities`, `startedAt`.** A client needs these
 *   to talk to the host, and they name nobody.
 * - **`pairing.claim`'s returned token.** It is the client's own credential,
 *   issued to the connection that redeemed the code.
 *
 * The cost is one JSON parse per server frame, which is what makes the policy
 * enforceable at the edge at all. Event frames are small; the large ones are
 * responses, which are exactly the frames this module has to look at.
 */

export interface ScrubPolicy {
  /** Addresses advertised in place of the harness's own. */
  readonly addresses: readonly string[];
  /** Port advertised in place of the harness's own. */
  readonly port: number;
  /** Filesystem prefixes that must never cross the network. Empty disables the walk. */
  readonly redactPaths: readonly string[];
  /** Mixed into the host-id pseudonym so two deployments do not agree on one. */
  readonly identitySalt: string;
}

export interface ScrubResult {
  readonly frame: ServerFrame;
  /** False when the frame is byte-identical in meaning and can be forwarded as received. */
  readonly changed: boolean;
}

export const REDACTED_PATH = '<host>';

/**
 * Depth cap for the string walk. No protocol payload nests anywhere near this;
 * the cap exists so a hostile or buggy payload cannot turn the scrubber into a
 * stack overflow. Deeper values are passed through unredacted, which is a
 * deliberate trade: a bounded, documented gap beats an unbounded recursion.
 */
const MAX_WALK_DEPTH = 8;

export function scrubServerFrame(frame: ServerFrame, method: string | null, policy: ScrubPolicy): ScrubResult {
  // Events are user data; see the note above.
  if (frame.t !== 'res') return { frame, changed: false };

  let result = frame.result;
  let error = frame.error;
  let changed = false;

  if (method === 'host.status' && isRecord(result)) {
    const status: Record<string, unknown> = { ...result };
    const hostId = status['hostId'];
    if (typeof hostId === 'string') status['hostId'] = pseudonymizeHostId(hostId, policy.identitySalt);
    status['addresses'] = [...policy.addresses];
    status['port'] = policy.port;
    result = status;
    changed = true;
  }

  if (policy.redactPaths.length > 0) {
    const walked = redactStrings(result, policy.redactPaths, 0);
    if (walked.changed) {
      result = walked.value;
      changed = true;
    }
    if (error !== undefined) {
      const message = redactText(error.message, policy.redactPaths);
      if (message !== error.message) {
        error = { ...error, message };
        changed = true;
      }
    }
  }

  if (!changed) return { frame, changed: false };
  return {
    frame: {
      t: 'res',
      id: frame.id,
      ok: frame.ok,
      ...(frame.result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
    },
    changed: true,
  };
}

/**
 * A stable, one-way stand-in for the harness's host id.
 *
 * Deterministic so a client sees the same identity across reconnects, one-way so
 * the harness id cannot be recovered from it, and salted so two companions
 * fronting two harnesses do not agree on a value that would let a peer correlate
 * them.
 */
export function pseudonymizeHostId(hostId: string, salt: string): string {
  const digest = createHash('sha256').update(`${salt}\u0000${hostId}`).digest('hex');
  return `cmp_${digest.slice(0, 24)}`;
}

function redactText(text: string, prefixes: readonly string[]): string {
  let out = text;
  for (const prefix of prefixes) {
    if (prefix.length === 0 || !out.includes(prefix)) continue;
    out = out.split(prefix).join(REDACTED_PATH);
  }
  return out;
}

function redactStrings(value: unknown, prefixes: readonly string[], depth: number): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const next = redactText(value, prefixes);
    return { value: next, changed: next !== value };
  }
  if (depth >= MAX_WALK_DEPTH) return { value, changed: false };

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((entry) => {
      const walked = redactStrings(entry, prefixes, depth + 1);
      if (walked.changed) changed = true;
      return walked.value;
    });
    return changed ? { value: out, changed: true } : { value, changed: false };
  }

  if (isRecord(value)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const walked = redactStrings(entry, prefixes, depth + 1);
      if (walked.changed) changed = true;
      out[key] = walked.value;
    }
    return changed ? { value: out, changed: true } : { value, changed: false };
  }

  return { value, changed: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
