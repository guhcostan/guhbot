import { HostError } from '@guhbot/host-core';
import { credentialSecretName, normaliseOrigin, originsMatch, type NormalisedOrigin } from './origin.js';
import {
  APPROVAL_NAME_PREFIX,
  APPROVAL_RECORD_KIND,
  CREDENTIAL_SCOPE,
  approvalRecordName,
  credentialApprovalSummary,
  decodeApproval,
  encodeApproval,
  type OriginApproval,
} from './records.js';
import type { SecretVault } from './vault.js';

/**
 * The per-origin credential vault.
 *
 * ## The one rule
 *
 * A credential value is readable in exactly one place: the return of
 * `release()`, from inside a tool execution. There is no RPC method, no tool and
 * no accessor on this class that produces a value. `list`, `counts` and the
 * approval rows describe origins; they never describe material. That is the same
 * shape `host-core` already uses for `secrets.*`, where `secrets.list` returns
 * names and there is deliberately no `secrets.get`.
 *
 * ## Approval, and what a release actually checks
 *
 * `approve()` writes a durable row recording the origin, the state, when it was
 * approved and the sentence the person was shown. `release()` then:
 *
 *  1. canonicalises the requested origin (a `null` releases nothing),
 *  2. reads that origin's approval row and refuses anything but `approved`,
 *  3. opens the sealed value,
 *  4. suspends once, then re-reads the approval row and refuses if it changed.
 *
 * Step 4 is what makes revocation immediate for a release that is already in
 * flight. Node runs one turn at a time, so a revoke can only land between two
 * awaits; without a suspension inside `release` the whole check-then-open would
 * run inside one turn and "revoked while a release was in flight" would be
 * unobservable in principle rather than merely unlikely. Re-reading also
 * compares `approvedAt`, so a revoke-then-re-approve that happens underneath a
 * release refuses too: the release was started under a decision that no longer
 * exists.
 *
 * ## What is deliberately absent
 *
 * There is no `credential_use` tool, no `credentials.get`, no method that takes
 * a credential as an argument and no model-reachable import. A model can learn
 * *which origins* are approved, and nothing else. See `capability.ts` for the
 * reference implementation's mechanism and why we refuse to copy it.
 */

export interface ReleasedCredential {
  /** Canonical origin this release was scoped to. */
  readonly origin: string;
  /**
   * The credential material, byte for byte as the operator stored it. This
   * package never parses it, logs it, writes it to a transcript or returns it
   * over RPC. The consumer decides the format and owns it from here.
   */
  readonly value: string;
  /** When the decision that allowed this release was taken. */
  readonly approvedAt: string;
}

/**
 * The seam the browser capability consumes.
 *
 * Implemented by `OriginCredentials` and handed out as `capability.provider`.
 * `release` is called from inside a tool execution — the same place
 * `ToolExecutionContext.readSecret` is available — and never from an RPC
 * handler. A glob of the returned object would be a credential leak, so the
 * consumer must use it in the narrowest scope it can and must not keep it.
 */
export interface OriginCredentialProvider {
  /** Called from inside a tool execution, never over RPC. */
  release(origin: string): Promise<ReleasedCredential | null>;
}

/** The behaviour a client can read, so it does not have to assume. No secrets. */
export interface CredentialPolicy {
  readonly match: string;
  readonly schemes: readonly string[];
  readonly approval: string;
  readonly revocation: string;
  readonly release: string;
  readonly storage: string;
  readonly import: string;
}

export const CREDENTIAL_POLICY: CredentialPolicy = Object.freeze({
  match: 'exact scheme + host + port, compared as canonical origins',
  schemes: ['https'],
  approval: 'one durable row per origin, written only by a person-class request',
  revocation: 'immediate, including for a release already in flight',
  release: 'inside a tool execution only; no method returns a credential',
  storage: "host-core's secrets table, sealed with its AES-256-GCM secret box",
  import: 'operator secret write only; no import from a browser profile or any other application',
});

export interface OriginCredentialsOptions {
  readonly vault: SecretVault;
  /** Injectable clock, so a test can prove timestamps are durable and ordered. */
  readonly now?: () => number;
}

export interface RevocationResult {
  /** Canonical origin the revocation was about. */
  readonly origin: string;
  /** The row that was written, or `null` when this origin had no approval. */
  readonly approval: OriginApproval | null;
  /** Whether the sealed value was deleted as well. */
  readonly forgotten: boolean;
}

export class OriginCredentials implements OriginCredentialProvider {
  private readonly vault: SecretVault;
  private readonly clock: () => number;
  private disposed = false;

  constructor(options: OriginCredentialsOptions) {
    this.vault = options.vault;
    this.clock = options.now ?? Date.now;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Write a person's approval for exactly one origin.
   *
   * The caller's authorization class is the human decision: `credentials.request`
   * is `person`-class, so the host's dispatcher refuses it for any device
   * without human presence before this runs. The returned `summary` is the
   * sentence the person is shown, and it is derived from the canonical origin so
   * it cannot carry anything else.
   *
   * Approving an origin that has no stored value is allowed and normal: an
   * operator approves the origin first and stores the value afterwards. Listing
   * therefore cannot be used to discover which approved origins actually hold a
   * credential.
   */
  approve(input: string): OriginApproval {
    this.assertLive();
    const origin = this.requireOrigin(input, 'credentials.request');
    const record: OriginApproval = {
      v: 1,
      kind: APPROVAL_RECORD_KIND,
      origin: origin.origin,
      state: 'approved',
      summary: credentialApprovalSummary(origin.origin),
      approvedAt: this.timestamp(),
      revokedAt: null,
    };
    this.vault.put(approvalRecordName(origin.origin), encodeApproval(record), CREDENTIAL_SCOPE);
    return record;
  }

  /**
   * Revoke an origin. The row is rewritten to `revoked` rather than deleted, so
   * the audit trail keeps saying that this origin was once approved and when it
   * stopped being approved.
   *
   * `forget` additionally deletes the sealed value. It is opt-in because
   * destroying the material is a different decision from ending the permission,
   * and because a re-approval after a plain revoke should not force the operator
   * to re-enter a credential.
   */
  revoke(input: string, forget = false): RevocationResult {
    this.assertLive();
    const origin = this.requireOrigin(input, 'credentials.revoke');
    const existing = this.readApproval(origin.origin);
    if (existing === null) return { origin: origin.origin, approval: null, forgotten: false };
    const record: OriginApproval = { ...existing, state: 'revoked', revokedAt: this.timestamp() };
    this.vault.put(approvalRecordName(origin.origin), encodeApproval(record), CREDENTIAL_SCOPE);
    return { origin: origin.origin, approval: record, forgotten: forget ? this.removeValue(origin.origin) : false };
  }

  /** Every origin this host holds an approval row for, approved or revoked. */
  list(): OriginApproval[] {
    const found: OriginApproval[] = [];
    for (const row of this.vault.rows()) {
      if (!row.name.startsWith(APPROVAL_NAME_PREFIX)) continue;
      const key = row.name.slice(APPROVAL_NAME_PREFIX.length);
      // The canonical origin is re-derived from the name and then checked
      // against the record's own origin by `decodeApproval`. A row someone
      // hand-wrote under a name that is not a canonical origin is ignored
      // rather than trusted.
      if (normaliseOrigin(key)?.origin !== key) continue;
      const raw = this.vault.open(row.name);
      if (raw === null) continue;
      const record = decodeApproval(raw, key);
      if (record === null) continue;
      found.push(record);
    }
    return found.sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
  }

  /** Only the origins a release would currently be considered for. */
  approvedOrigins(): OriginApproval[] {
    return this.list().filter((record) => record.state === 'approved');
  }

  counts(): { approved: number; revoked: number } {
    let approved = 0;
    let revoked = 0;
    for (const record of this.list()) {
      if (record.state === 'approved') approved += 1;
      else revoked += 1;
    }
    return { approved, revoked };
  }

  /**
   * The only path that yields a credential value.
   *
   * Returns `null` for every refusal — no approval, a revoked approval, no
   * stored value, a value that will not decrypt, an input that is not an exact
   * https origin, a disposed vault. The caller cannot distinguish them, and
   * should not: a distinguishable refusal is a way to probe the vault.
   */
  async release(input: string): Promise<ReleasedCredential | null> {
    if (this.disposed) return null;

    const requested = normaliseOrigin(input);
    if (requested === null) return null;

    const before = this.readApproval(requested.origin);
    if (before === null || before.state !== 'approved') return null;

    const name = credentialSecretName(requested.origin);
    const value = name === null ? null : this.vault.open(name);
    if (value === null) return null;

    // Suspend before committing. This is the interleaving point that makes the
    // re-read below meaningful: see the class comment.
    await Promise.resolve();

    const after = this.readApproval(requested.origin);
    if (after === null || after.state !== 'approved') return null;
    if (after.approvedAt !== before.approvedAt) return null;
    // The matcher runs on the row that was actually read, not on the string the
    // caller passed, so the comparison that decides a release is the exported
    // one and nothing else.
    if (!originsMatch(requested.origin, after.origin)) return null;

    return { origin: after.origin, value, approvedAt: after.approvedAt };
  }

  /** Idempotent. A disposed vault releases nothing and accepts no new approval. */
  dispose(): void {
    this.disposed = true;
  }

  private readApproval(canonicalOrigin: string): OriginApproval | null {
    const raw = this.vault.open(approvalRecordName(canonicalOrigin));
    if (raw === null) return null;
    return decodeApproval(raw, canonicalOrigin);
  }

  private removeValue(canonicalOrigin: string): boolean {
    const name = credentialSecretName(canonicalOrigin);
    if (name === null) return false;
    let removed = false;
    for (const row of this.vault.rows()) {
      if (row.name !== name) continue;
      if (this.vault.remove(row.id)) removed = true;
    }
    return removed;
  }

  private requireOrigin(input: string, method: string): NormalisedOrigin {
    const origin = normaliseOrigin(input);
    if (origin === null) {
      // The refusal echoes the shape we need, never the input: a caller that
      // pasted a credential into the origin field must not see it come back.
      throw new HostError(
        'bad-request',
        `${method} needs a canonical https origin (for example https://example.com): no path, query, fragment, userinfo or plaintext scheme`,
      );
    }
    return origin;
  }

  private assertLive(): void {
    if (this.disposed) throw new HostError('cancelled', 'the credential vault has been disposed');
  }

  private timestamp(): string {
    return new Date(this.clock()).toISOString();
  }
}
