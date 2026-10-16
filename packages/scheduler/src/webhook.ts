import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Host } from '@guhbot/host-core';
import { createSecretBox, loadOrCreateMasterKey } from '@guhbot/host-core';
import type { SecretBox } from '@guhbot/host-core';

/**
 * Webhook credentials for automations.
 *
 * A webhook automation is started by an HTTP request that carries a secret. That
 * makes the secret the only thing standing between the public internet and an
 * agent that runs with the user's own permissions, so the rules here are tighter
 * than they look:
 *
 *  - The secret is 256 bits from the CSPRNG, never derived from the automation
 *    id or from anything a caller can guess.
 *  - It is stored sealed (AES-256-GCM under the host master key) in host-core's
 *    `secrets` table, which this capability reaches through `Store`. The
 *    scheduler owns no database of its own; see `docs/engineering.md`.
 *  - Comparison hashes both sides and then compares fixed-width digests with
 *    `timingSafeEqual`, so the comparison cannot be turned into a byte-by-byte
 *    oracle and cannot leak the secret's length through an early return.
 *  - Revocation deletes the sealed row, so a leaked secret stops working
 *    immediately and permanently rather than being blacklisted in memory.
 *  - It is never logged, never put in a URL and never echoed in a response: the
 *    one method that returns it is `person` class, because handing out a
 *    credential is exactly what a stolen phone must not be able to do.
 *
 * ## What the fire path refuses
 *
 * `automations.webhookFire` refuses a request that is not a POST (a GET is
 * refused explicitly, and GET is the default so a caller that forgets to say
 * POST fires nothing). A GET that fires an agent is a remote-code-execution
 * surface: link previewers, mail scanners, crawlers and antivirus proxies all
 * follow URLs, and any of them would otherwise start a run by accident. It also
 * refuses a missing secret, a wrong secret, a revoked secret, a disabled
 * automation, and a non-webhook automation.
 *
 * ## Where the request comes from
 *
 * Only `@guhbot/server` binds a socket, so this package never listens. The URL
 * below (`/webhooks/automations/<id>`) is the path the server must route: it
 * reads the secret from the `X-Guhbot-Webhook-Secret` header, never from the
 * query string, and dispatches `automations.webhookFire` with the host's own
 * local session. Nothing here trusts the transport: the secret is verified
 * inside the method.
 */

const SECRET_BYTES = 32;

/** Header the secret belongs in. Query strings end up in access logs. */
export const WEBHOOK_SECRET_HEADER = 'x-guhbot-webhook-secret';

/** Namespace for these secrets inside host-core's shared `secrets` table. */
export function webhookSecretName(automationId: string): string {
  return `automation-webhook:${automationId}`;
}

export function newWebhookSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * Constant-time comparison of a presented secret against the stored one.
 *
 * Both sides are SHA-256 hashed first. That is what makes the comparison a fixed
 * 32-byte memcmp: comparing raw strings of different lengths with
 * `timingSafeEqual` either throws or needs an early length check, and both leak
 * the length of the real secret.
 */
export function verifyWebhookSecret(expected: string, presented: string): boolean {
  // An empty stored secret means "no webhook is configured"; it must never match
  // an empty presented secret, which is what a caller sends when it forgets.
  if (expected.length === 0 || presented.length === 0) return false;
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(presented, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export interface WebhookUrl {
  /** Absolute when the host has bound a socket, otherwise the path to route. */
  readonly url: string;
  /** Operational detail worth showing next to the URL; never the secret. */
  readonly note: string | null;
}

export function webhookUrl(host: Host, automationId: string): WebhookUrl {
  const status = host.status();
  const path = `/webhooks/automations/${encodeURIComponent(automationId)}`;
  const note =
    `POST only; send the secret in the ${WEBHOOK_SECRET_HEADER} header. ` +
    'A GET is refused, and the secret is never accepted in the query string.';

  if (status.port === 0 || status.addresses.length === 0) {
    return { url: path, note: `${note} This host has not bound a socket yet, so this is the path to route.` };
  }
  const address = status.addresses[0] ?? '127.0.0.1';
  const authority = address.includes(':') ? `[${address}]` : address;
  return { url: `http://${authority}:${status.port}${path}`, note };
}

/**
 * Sealed-secret access for webhook credentials.
 *
 * The secret box is derived once (scrypt is deliberately expensive) and reused
 * for the life of the capability, which matters because verification happens on
 * every inbound webhook request.
 */
export class WebhookSecrets {
  private box: SecretBox | null = null;

  constructor(private readonly dataDir: string) {}

  /** Mint or rotate. Returns the new secret to the caller; only the seal is stored. */
  mint(host: Host, automationId: string): string {
    const secret = newWebhookSecret();
    host.putSecret(webhookSecretName(automationId), secret, 'automation');
    return secret;
  }

  read(host: Host, automationId: string): string | null {
    const sealed = host.store.readSealedSecret(webhookSecretName(automationId));
    if (sealed === null) return null;
    try {
      this.box ??= createSecretBox(loadOrCreateMasterKey(this.dataDir));
      return this.box.open(sealed);
    } catch {
      // A secret we cannot decrypt reads as absent: refusing a webhook is the
      // safe direction, and it keeps a corrupt row from crashing the scheduler.
      return null;
    }
  }

  revoke(host: Host, automationId: string): boolean {
    const name = webhookSecretName(automationId);
    const meta = host.store.listSecrets().find((candidate) => candidate.name === name);
    if (meta === undefined) return false;
    return host.store.deleteSecret(meta.id);
  }
}
