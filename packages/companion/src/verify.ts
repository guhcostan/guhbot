/**
 * The device-token verification seam.
 *
 * The companion must refuse an unknown or revoked token **before** the harness
 * is involved, and it cannot answer that question by itself. Tokens live in the
 * harness: they are salted scrypt hashes in its database, and `Host.authenticate`
 * is the only thing that can check one. The protocol deliberately exposes no
 * `verifyToken` method — a remote "is this token valid?" oracle is exactly the
 * thing an attacker with a network position wants — so a companion in a
 * separate process has no RPC that can tell it what it needs to know.
 *
 * That makes verification a **seam, not an implementation**: the deployment
 * connects it. Two shapes exist, and the difference matters:
 *
 * - **In the host's process** (the desktop app spawning its own host, a launcher
 *   script, a container entrypoint that builds the `Host` itself):
 *   `createHostVerifyToken(host)` is the whole wiring. It calls straight into
 *   `Host.authenticate`, so "revoked" means revoked on the very next attempt.
 *
 * - **In a separate process** (the standalone `guhbot-companion` CLI): the
 *   deployment supplies its own `VerifyToken` — from its control plane, its own
 *   device registry, or a module it points the CLI at. The companion cannot
 *   invent one, and it must not reach into the harness's database to read the
 *   device table: `@guhbot/host-core` owns every durable write, and a second
 *   opener of `data.db` is a corruption risk for a check that is not worth it.
 *
 * A verifier that throws is treated as "not valid". Fail closed: a broken
 * verifier must never turn into an open relay.
 */

/** The part of a device the companion needs: who it is, and what class it holds. */
export interface DeviceIdentity {
  readonly id: string;
  readonly name: string;
  readonly class: 'person' | 'background';
}

/** Resolve a device token to a device, or `null` when it is unknown or revoked. */
export type VerifyToken = (token: string) => Promise<DeviceIdentity | null>;

/**
 * The shape `createHostVerifyToken` needs.
 *
 * Structural on purpose: `Host` satisfies it, and so does a test double, without
 * the companion taking a dependency on the whole host runtime. This process
 * terminates the network, so it links as little as possible — it is the one
 * place an attacker can reach.
 */
export interface TokenAuthenticator {
  authenticate(token: string): DeviceIdentity | null;
}

/** The default implementation: the harness's own device table, called in-process. */
export function createHostVerifyToken(host: TokenAuthenticator): VerifyToken {
  return async (token: string): Promise<DeviceIdentity | null> => host.authenticate(token);
}
