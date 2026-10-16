/**
 * @guhbot/credentials — the per-origin credential vault.
 *
 * A credential is released only when a `person`-class decision approved that
 * exact origin, only inside a tool execution, and only until it is revoked.
 * There is no RPC method that returns one and no tool that can ask for one by
 * name.
 *
 * The safety-critical pieces are exported so they can be reasoned about and
 * tested on their own. `normaliseOrigin` and `originsMatch` in particular are
 * the whole matching policy: exact scheme + host + port on canonicalised
 * origins, with no suffix, prefix or substring logic anywhere.
 *
 * ## Wiring, for the application
 *
 * ```ts
 * // The capability must exist before the host, so it takes a getter.
 * const credentials = createCredentialsCapability({ host: () => host });
 * const { tools, extraMethods, flags } = collectContributions([credentials]);
 * host = new Host({ dataDir, version, mode, capabilities: flags, extraMethods });
 * // Hand `credentials.provider` to the browser capability when that seam is
 * // wired. Nothing else should hold a reference to it.
 * ```
 *
 * Storing a value is the operator's job and uses the host's existing secret
 * write, under the name this package documents:
 *
 * ```ts
 * const name = credentialSecretName('https://example.com'); // 'origin:https://example.com'
 * if (name !== null) host.putSecret(name, value, null);
 * ```
 *
 * That is the only ingestion path on purpose. There is no browser-profile
 * import, no cookie-database reader and no Chrome Keychain access — see the
 * refusal note in `capability.ts`.
 */
export { createCredentialsCapability } from './capability.js';
export type { CredentialsCapability, CredentialsCapabilityOptions } from './capability.js';
export {
  CREDENTIAL_POLICY,
  OriginCredentials,
  type CredentialPolicy,
  type OriginCredentialProvider,
  type OriginCredentialsOptions,
  type ReleasedCredential,
  type RevocationResult,
} from './credentials.js';
export { createCredentialsMethods } from './methods.js';
export { CREDENTIAL_ORIGINS_TOOL, createCredentialsTools } from './tools.js';
export { createHostSecretVault, type SecretVault, type SecretVaultRow } from './vault.js';
export {
  CREDENTIAL_NAME_PREFIX,
  DEFAULT_HTTPS_PORT,
  credentialSecretName,
  normaliseOrigin,
  originsMatch,
  type NormalisedOrigin,
  type OriginScheme,
} from './origin.js';
export {
  APPROVAL_NAME_PREFIX,
  APPROVAL_RECORD_KIND,
  CREDENTIAL_SCOPE,
  approvalRecordName,
  credentialApprovalSummary,
  decodeApproval,
  encodeApproval,
  type ApprovalState,
  type OriginApproval,
} from './records.js';
