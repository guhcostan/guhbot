import { normaliseOrigin, originsMatch } from './origin.js';

/**
 * The durable approval record.
 *
 * ## Where it lives
 *
 * `host-core` owns every durable write and a capability may not add a table, so
 * this package keeps its state in the table that already exists for exactly
 * this purpose — `secrets` — under two documented name prefixes:
 *
 *   `origin:<canonical-origin>`             the sealed credential value
 *   `origin-approval:<canonical-origin>`    the sealed record in this file
 *
 * That is a deliberate use of the existing table rather than a second store. It
 * buys three things that matter more than tidiness: values are sealed by
 * `host-core`'s own AES-256-GCM secret box (no second scheme, no file of our
 * own), there is exactly one place in the repository that writes to disk, and
 * `deleteSecret`/backup/restore already work on this data. The cost is that a
 * human reading `secrets.list` sees names that start with these prefixes, which
 * is why the prefixes are constants here and documented in one place.
 *
 * The *name* is not treated as a secret: `secrets.list` already exposes row
 * names to every client, and `credentials.list` exposes approved origins on
 * purpose. The *value* is sealed and is never returned by anything but the
 * release path.
 *
 * ## Why the summary is derived and not free text
 *
 * `summary` is what a person is shown before they approve, and it is checked on
 * the way back out of storage, not only on the way in. If it were free text a
 * caller could put a credential, a prefix or a length into a field that is
 * rendered by every client; by deriving it from the origin and rejecting any row
 * whose summary does not match the derivation, "the approval names the origin
 * and nothing else" is an invariant of the storage format rather than a habit of
 * the caller.
 *
 * ## What this format is not
 *
 * It is not a privilege boundary, and it is not trying to be. Whoever can write
 * a row here can call `secrets.put`, which is `person`-class, which is the same
 * class as `credentials.request` — so forging a valid record grants exactly the
 * privilege the forger already had. The boundary that matters is the
 * dispatcher's authorization class, and the job of this file is the weaker but
 * still load-bearing one of making sure that nothing *else* can be smuggled into
 * a record a client will render.
 */

export const APPROVAL_RECORD_KIND = 'origin-credential-approval';
export const APPROVAL_NAME_PREFIX = 'origin-approval:';
/**
 * Recorded in the `scope` column so an operator can find these rows in a backup
 * without parsing names. Advisory only: reads never trust it, because a value
 * row written through `secrets.put` carries whatever scope that caller passed.
 */
export const CREDENTIAL_SCOPE = 'credentials';

export type ApprovalState = 'approved' | 'revoked';

export interface OriginApproval {
  readonly v: 1;
  readonly kind: typeof APPROVAL_RECORD_KIND;
  /** Canonical origin. The record is refused unless it survives normalisation. */
  readonly origin: string;
  readonly state: ApprovalState;
  /** Derived from `origin` only. Never carries anything else. */
  readonly summary: string;
  readonly approvedAt: string;
  readonly revokedAt: string | null;
}

/** What the person is shown. A function of the canonical origin and nothing else. */
export function credentialApprovalSummary(canonicalOrigin: string): string {
  return `Allow credential use for ${canonicalOrigin}`;
}

export function approvalRecordName(canonicalOrigin: string): string {
  return `${APPROVAL_NAME_PREFIX}${canonicalOrigin}`;
}

export function encodeApproval(record: OriginApproval): string {
  return JSON.stringify(record);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/**
 * Decode a sealed approval row, or refuse it.
 *
 * Everything about a row is re-derived here: the origin must survive
 * canonicalisation unchanged, must match the origin the caller asked about, and
 * the summary must equal the derived one. A hand-edited, truncated, older or
 * tampered row therefore reads as *no approval*, which is the failing-safe
 * direction — the alternative is a row that grants something nobody approved.
 */
export function decodeApproval(raw: string, expectedOrigin: string): OriginApproval | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (record['v'] !== 1) return null;
  if (record['kind'] !== APPROVAL_RECORD_KIND) return null;

  const origin = record['origin'];
  if (typeof origin !== 'string') return null;
  const canonical = normaliseOrigin(origin);
  if (canonical === null || canonical.origin !== origin) return null;
  if (!originsMatch(origin, expectedOrigin)) return null;

  const state = record['state'];
  if (state !== 'approved' && state !== 'revoked') return null;

  if (record['summary'] !== credentialApprovalSummary(origin)) return null;

  const approvedAt = record['approvedAt'];
  if (!isIsoTimestamp(approvedAt)) return null;

  const revokedAt = record['revokedAt'];
  if (revokedAt !== null && !isIsoTimestamp(revokedAt)) return null;
  // The two states are exclusive: a revoked row has a revocation time and an
  // approved row does not. A row claiming both is not one this package wrote.
  if (state === 'revoked' && revokedAt === null) return null;
  if (state === 'approved' && revokedAt !== null) return null;

  return {
    v: 1,
    kind: APPROVAL_RECORD_KIND,
    origin,
    state,
    summary: credentialApprovalSummary(origin),
    approvedAt,
    revokedAt,
  };
}
