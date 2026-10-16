import type { ContributedMethod } from '@guhbot/host-core';
import { z } from 'zod';
import { CREDENTIAL_POLICY, type OriginCredentials } from './credentials.js';
import type { OriginApproval } from './records.js';

/**
 * The client-facing half of the capability.
 *
 * Four methods and no fifth. Two of them observe (`list`, `status`) and are
 * `background`: a paired phone reading which origins a person approved learns
 * nothing it could not already read from `secrets.list`, and an unattended
 * client needs to be able to show that state.
 *
 * The other two decide (`request`, `revoke`) and are `person`: approving an
 * origin is exactly the human decision this package exists to record, and
 * revoking one has to be reachable when the person is worried, which is not a
 * moment to be told that a device is not trusted enough. Both go through the
 * dispatcher's person-class check before they run.
 *
 * What is absent is the point. There is no method that returns a credential
 * value, no method that accepts one as an argument, and no `credentials.get`.
 * Values are written by the host's existing `secrets.put` under the name from
 * `credentialSecretName()`, and read only by the release path inside a tool.
 */

const OriginInput = z.object({
  /** A canonical origin: `https://host[:port]`. Not a URL with a path. */
  origin: z.string().min(1).max(2048),
});

const ApprovalView = z.object({
  origin: z.string().min(1).max(320),
  state: z.enum(['approved', 'revoked']),
  /** The sentence the person was shown. Derived from the origin only. */
  summary: z.string().min(1).max(512),
  approvedAt: z.string().min(1).max(40),
  revokedAt: z.string().min(1).max(40).nullable(),
});

const ListOutput = z.object({ origins: z.array(ApprovalView) });

const RevokeInput = OriginInput.extend({
  /**
   * Also delete the sealed value. Opt-in: ending a permission and destroying
   * the material are different decisions.
   */
  forget: z.boolean().default(false),
});

const RevokeOutput = z.object({
  origin: z.string().min(1).max(320),
  /** False when this origin had no approval row to revoke. */
  revoked: z.boolean(),
  revokedAt: z.string().min(1).max(40).nullable(),
  forgotten: z.boolean(),
});

const PolicyOutput = z.object({
  match: z.string().min(1).max(200),
  schemes: z.array(z.string().min(1).max(20)).max(8),
  approval: z.string().min(1).max(200),
  revocation: z.string().min(1).max(200),
  release: z.string().min(1).max(200),
  storage: z.string().min(1).max(200),
  import: z.string().min(1).max(200),
});

const StatusOutput = z.object({
  approved: z.number().int().min(0),
  revoked: z.number().int().min(0),
  policy: PolicyOutput,
});

/** Project a stored record onto exactly the fields a client may see. */
function view(record: OriginApproval): z.infer<typeof ApprovalView> {
  return {
    origin: record.origin,
    state: record.state,
    summary: record.summary,
    approvedAt: record.approvedAt,
    revokedAt: record.revokedAt,
  };
}

export function createCredentialsMethods(credentials: OriginCredentials): Record<string, ContributedMethod> {
  return {
    'credentials.list': {
      authz: 'background',
      input: z.object({}),
      output: ListOutput,
      summary: 'Origins with a credential approval, their state, and the sentence the person approved. Never a value.',
      handler: async () => ({ origins: credentials.list().map(view) }),
    },

    'credentials.request': {
      // The person-class dispatch is the human decision this row records.
      authz: 'person',
      input: OriginInput,
      output: ApprovalView,
      summary: 'Approve credential use for one exact https origin. Requires human presence; no value crosses this call.',
      handler: async (_host, _session, input: z.infer<typeof OriginInput>) => view(credentials.approve(input.origin)),
    },

    'credentials.revoke': {
      // Immediate by design: revoking must not need a second confirmation step.
      authz: 'person',
      input: RevokeInput,
      output: RevokeOutput,
      summary: 'Revoke an origin immediately, optionally deleting the sealed value. Requires human presence.',
      handler: async (_host, _session, input: z.infer<typeof RevokeInput>) => {
        const result = credentials.revoke(input.origin, input.forget);
        return {
          // Always the canonical spelling, so the response never echoes the
          // caller's bytes back at it.
          origin: result.origin,
          revoked: result.approval !== null,
          revokedAt: result.approval?.revokedAt ?? null,
          forgotten: result.forgotten,
        };
      },
    },

    'credentials.status': {
      authz: 'background',
      input: z.object({}),
      output: StatusOutput,
      summary: 'How many origins are approved or revoked, and the policy this vault enforces. No secrets.',
      handler: async () => {
        const counts = credentials.counts();
        return {
          approved: counts.approved,
          revoked: counts.revoked,
          policy: { ...CREDENTIAL_POLICY, schemes: [...CREDENTIAL_POLICY.schemes] },
        };
      },
    },
  };
}
