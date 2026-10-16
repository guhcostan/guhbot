import { createSecretBox, loadOrCreateMasterKey, type Host, type SecretBox } from '@guhbot/host-core';

/**
 * The storage seam.
 *
 * Four operations, all of which a capability is allowed to have and none of
 * which crosses the protocol boundary. `open` is the only one that yields
 * plaintext, it is reachable only from this package's release path, and its
 * result must never be logged, written into a transcript, returned by an RPC
 * method or handed to a model.
 *
 * It exists as an interface rather than a direct `Store` import so that the
 * release path can be tested against a fake (a row that will not decrypt, a row
 * that was hand-edited) and so a hosted deployment can back it with a different
 * sealer without this package growing a second code path.
 */
export interface SecretVaultRow {
  readonly id: string;
  readonly name: string;
}

export interface SecretVault {
  /** Seal under `host-core`'s scheme and persist. Returns nothing, by design. */
  put(name: string, value: string, scope: string | null): void;
  /** Open the value stored under `name`, or `null` when absent or unreadable. */
  open(name: string): string | null;
  /** Row ids and names only. Never values. */
  rows(): readonly SecretVaultRow[];
  /** Delete a row by id. */
  remove(id: string): boolean;
}

/**
 * The vault over a live host.
 *
 * A getter rather than the host itself, for the same reason the scheduler takes
 * one: the runtime needs every capability's methods in hand *before* it can
 * construct the `Host`, so the host does not exist yet when the capability is
 * built. Nothing here touches the host until a tool or a release actually runs.
 *
 * Sealing goes through `host.putSecret`, which is the host's own box. Opening
 * cannot: `host-core` deliberately exposes no public unseal (there is no
 * `readSecret` on `Host`, and there is no `secrets.get` on the wire), so this
 * builds a box from the same master key file with the same exported
 * `createSecretBox`. That is the host's scheme and the host's key — not a second
 * encryption scheme, and not a file of our own. The box is built lazily, so a
 * host that never releases a credential never derives that key at all.
 */
export function createHostSecretVault(resolveHost: () => Host): SecretVault {
  let box: SecretBox | null = null;

  const secretBox = (): SecretBox => {
    if (box === null) box = createSecretBox(loadOrCreateMasterKey(resolveHost().dataDir));
    return box;
  };

  return {
    put: (name, value, scope) => {
      resolveHost().putSecret(name, value, scope);
    },
    open: (name) => {
      const sealed = resolveHost().store.readSealedSecret(name);
      if (sealed === null) return null;
      try {
        return secretBox().open(sealed);
      } catch {
        // A row sealed under a rotated key, or hand-edited, reads as absent.
        // Refusing is the only safe direction: a partial or guessed value would
        // be sent to a live origin as if a person had approved it.
        return null;
      }
    },
    rows: () => resolveHost().store.listSecrets().map((meta) => ({ id: meta.id, name: meta.name })),
    remove: (id) => resolveHost().store.deleteSecret(id),
  };
}
