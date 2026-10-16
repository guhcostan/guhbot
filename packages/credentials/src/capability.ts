import type { Capability } from '@guhbot/agent';
import type { Host } from '@guhbot/host-core';
import { OriginCredentials, type OriginCredentialProvider } from './credentials.js';
import { createCredentialsMethods } from './methods.js';
import { createCredentialsTools } from './tools.js';
import { createHostSecretVault, type SecretVault } from './vault.js';

/**
 * The per-origin credential vault capability.
 *
 * ## What it is for
 *
 * "Log in once, then the agent works in the tools you use" is the feature this
 * closes. A person approves one origin; from then on a tool that needs the
 * credential for *that* origin can read it, inside its own execution, and
 * nothing else can. The browser capability is the intended consumer, through
 * `OriginCredentialProvider`; the seam is exported and not yet wired.
 *
 * ## What this package refuses to do, and why
 *
 * The reference implementation for this feature (`docs/re/04-web-automation-
 * integrations.md` §2.3) reaches a signed-in browser session by asking **Finder**,
 * over AppleScript, to copy Chrome's cookie database, then decrypting it with
 * the `Chrome Safe Storage` Keychain item, filtering it to the approved
 * `(origin, profileId)` pairs, and shipping the cookie set to a remote box. That
 * mechanism is a TCC-avoidance trick: Finder already holds Full Disk Access, so
 * the copy succeeds without granting the agent host that permission.
 *
 * We do not implement any of it, and the refusal is the justification for this
 * package existing:
 *
 *  - **We never read another application's storage.** Not by scripting Finder,
 *    not through AppleScript, not by unlocking another app's Keychain item, and
 *    not by asking the user for Full Disk Access so we can open a browser's
 *    cookie database ourselves. Circumventing a consent prompt is not a feature.
 *  - **We never make this host a scripted controller of another app** to obtain
 *    a credential. `osascript` driving Finder is remote control of the user's
 *    desktop with the user's own authority.
 *  - **A credential never crosses the protocol**, in either direction. The
 *    reference's `injectChromeCookies` is `person`-class and carries cookies as
 *    arguments; a value on the wire is a value in a socket buffer, a log line
 *    and a crash dump. Here a value enters through the host's existing
 *    `secrets.put` (already person-class, already value-free on the way out)
 *    under the documented name from `credentialSecretName()`, and leaves only
 *    through `release()` inside a tool execution.
 *  - **No model-reachable import.** There is no tool, and no method a model can
 *    call, that ingests a credential from anywhere.
 *
 * ## Storage
 *
 * Approvals and values live in `host-core`'s existing `secrets` table under the
 * documented prefixes in `records.ts`. A capability may not add a table and
 * `host-core` owns every durable write, so this is a deliberate use of the
 * existing table rather than a second store: same AES-256-GCM secret box, same
 * master key, same backup story, one writer.
 */

export interface CredentialsCapability extends Capability {
  /** The vault itself, for an application that wants the state machine directly. */
  readonly credentials: OriginCredentials;
  /**
   * The seam another capability consumes. Hand this to the browser capability:
   * it calls `release(origin)` from inside a tool execution and never exposes
   * the result to a model, a transcript or a client.
   */
  readonly provider: OriginCredentialProvider;
}

export interface CredentialsCapabilityOptions {
  /**
   * The host that owns the `secrets` table.
   *
   * A getter, not the host itself, because the runtime needs this capability's
   * methods in hand before it can construct the `Host` — the same cycle the
   * scheduler documents. Nothing here touches the host until a tool runs or an
   * RPC method is called.
   */
  readonly host: () => Host;
  /** Injectable clock. Timestamps are durable, so a test can pin them. */
  readonly now?: () => number;
  /** Override the storage seam. Defaults to the host's own sealed secrets. */
  readonly vault?: SecretVault;
}

export function createCredentialsCapability(options: CredentialsCapabilityOptions): CredentialsCapability {
  const vault = options.vault ?? createHostSecretVault(options.host);
  const credentials = new OriginCredentials({
    vault,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  return {
    name: 'credentials',
    summary: 'Per-origin credential vault: a value is released only for an origin a person approved, and only inside a tool execution.',
    flags: { credentials: true },
    tools: () => createCredentialsTools(credentials),
    methods: createCredentialsMethods(credentials),
    dispose: async () => {
      credentials.dispose();
    },
    credentials,
    provider: credentials,
  };
}
