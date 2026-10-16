import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostError } from '@guhbot/host-core';
import type { RunContext } from '@guhbot/host-core';
import type { Automation } from '@guhbot/protocol';
import { newWebhookSecret, verifyWebhookSecret, webhookSecretName, webhookUrl } from '../src/index.js';
import type { Mounted } from './harness.js';
import { FakeClock, FakeTimers, createDevice, flush, mountScheduler } from './harness.js';

/**
 * Webhook credentials are the only way an unauthenticated request can start an
 * agent, so these tests are about refusals first and about the happy path after.
 * The secret is treated the way the host treats it: it may be returned to a
 * person-class device once, and it must never show up anywhere else.
 */

let dataDir: string;
let mounted: Mounted[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'guhbot-webhook-'));
});

afterEach(async () => {
  for (const item of mounted) await item.host.close();
  mounted = [];
  rmSync(dataDir, { recursive: true, force: true });
});

interface WebhookRig extends Mounted {
  agentId: string;
  automation: Automation;
}

function bootWebhook(options: { execute?: (context: RunContext) => Promise<void> | void } = {}): WebhookRig {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const item = mountScheduler({
    dataDir,
    now: clock.now,
    timers,
    ...(options.execute !== undefined ? { execute: options.execute } : {}),
  });
  mounted.push(item);
  const agent = item.host.store.createAgent({ name: 'ops' });
  const automation = item.host.store.createAutomation({
    agentId: agent.id,
    name: 'deploy hook',
    trigger: 'webhook',
    cron: null,
    prompt: 'handle the webhook',
  });
  item.scheduler.start();
  return { ...item, agentId: agent.id, automation };
}

async function refusal(promise: Promise<unknown>): Promise<HostError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HostError) return error;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

interface MintedSecret {
  automationId: string;
  url: string;
  secret: string;
  rotated: boolean;
  note: string | null;
}

interface FireResult {
  automationId: string;
  status: 'started' | 'skipped' | 'failed';
  run: { id: string; status: string } | null;
  reason: string | null;
}

describe('minting a webhook secret', () => {
  it('returns a URL and a high-entropy secret, and never puts the secret in the URL', async () => {
    const { host, automation } = bootWebhook();
    const local = host.createSession('local');

    const minted = (await host.dispatch(local, 'automations.webhook', {
      automationId: automation.id,
    })) as MintedSecret;

    expect(minted.automationId).toBe(automation.id);
    expect(minted.rotated).toBe(true);
    expect(minted.secret.length).toBeGreaterThanOrEqual(32);
    expect(minted.url).toContain(`/webhooks/automations/${automation.id}`);
    expect(minted.url).not.toContain(minted.secret);
    expect(minted.note).toContain('POST');
  });

  it('returns the existing secret until it is rotated', async () => {
    const { host, automation } = bootWebhook();
    const local = host.createSession('local');
    const first = (await host.dispatch(local, 'automations.webhook', { automationId: automation.id })) as MintedSecret;
    const again = (await host.dispatch(local, 'automations.webhook', { automationId: automation.id })) as MintedSecret;
    expect(again.rotated).toBe(false);
    expect(again.secret).toBe(first.secret);

    const rotated = (await host.dispatch(local, 'automations.webhook', {
      automationId: automation.id,
      rotate: true,
    })) as MintedSecret;
    expect(rotated.rotated).toBe(true);
    expect(rotated.secret).not.toBe(first.secret);

    // The old value is dead the moment it is rotated away.
    const withOld = await refusal(
      host.dispatch(local, 'automations.webhookFire', {
        automationId: automation.id,
        secret: first.secret,
        method: 'POST',
      }),
    );
    expect(withOld.code).toBe('forbidden');
    const withNew = (await host.dispatch(local, 'automations.webhookFire', {
      automationId: automation.id,
      secret: rotated.secret,
      method: 'POST',
    })) as FireResult;
    expect(withNew.status).toBe('started');
  });

  it('stores the secret sealed rather than in the clear', async () => {
    const { host, automation } = bootWebhook();
    const local = host.createSession('local');
    const minted = (await host.dispatch(local, 'automations.webhook', { automationId: automation.id })) as MintedSecret;

    const sealed = host.store.readSealedSecret(webhookSecretName(automation.id));
    expect(sealed).not.toBeNull();
    expect(sealed).not.toContain(minted.secret);
    expect(host.store.listSecrets().map((meta) => meta.name)).toContain(webhookSecretName(automation.id));
  });

  it('refuses to mint a webhook secret for a schedule automation', async () => {
    const { host, agentId } = bootWebhook();
    const scheduled = host.store.createAutomation({
      agentId,
      name: 'clock',
      trigger: 'schedule',
      cron: '0 8 * * *',
      prompt: 'morning',
    });
    const error = await refusal(
      host.dispatch(host.createSession('local'), 'automations.webhook', { automationId: scheduled.id }),
    );
    expect(error.code).toBe('bad-request');
    expect(error.message).toContain('only a webhook automation');
  });
});

describe('firing a webhook', () => {
  it('starts the run when the secret matches', async () => {
    const { host, automation, calls } = bootWebhook();
    const local = host.createSession('local');
    const minted = (await host.dispatch(local, 'automations.webhook', { automationId: automation.id })) as MintedSecret;

    const fired = (await host.dispatch(local, 'automations.webhookFire', {
      automationId: automation.id,
      secret: minted.secret,
      method: 'POST',
    })) as FireResult;

    expect(fired.status).toBe('started');
    expect(fired.run).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe('handle the webhook');
    await flush();
    expect(host.store.getRun(fired.run!.id)?.status).toBe('succeeded');
    expect(host.store.getAutomation(automation.id)?.lastRunAt).not.toBeNull();
    // The response carries the run, never the credential that started it.
    expect(JSON.stringify(fired)).not.toContain(minted.secret);
  });

  it('refuses a wrong secret, a missing secret and an unknown automation', async () => {
    const { host, automation } = bootWebhook();
    const local = host.createSession('local');
    const minted = (await host.dispatch(local, 'automations.webhook', { automationId: automation.id })) as MintedSecret;

    const wrong = await refusal(
      host.dispatch(local, 'automations.webhookFire', {
        automationId: automation.id,
        secret: `${minted.secret}x`,
        method: 'POST',
      }),
    );
    expect(wrong.code).toBe('forbidden');
    expect(wrong.message).toContain('did not match');
    // The presented value is never echoed back.
    expect(wrong.message).not.toContain(minted.secret);
    expect(wrong.message).not.toContain(`${minted.secret}x`);

    const missing = await refusal(
      host.dispatch(local, 'automations.webhookFire', { automationId: automation.id, method: 'POST' }),
    );
    expect(missing.code).toBe('forbidden');

    const unknown = await refusal(
      host.dispatch(local, 'automations.webhookFire', {
        automationId: 'au_nope',
        secret: minted.secret,
        method: 'POST',
      }),
    );
    expect(unknown.code).toBe('not-found');
  });

  it('refuses a GET, and refuses a caller that does not say POST', async () => {
    const { host, automation, calls } = bootWebhook();
    const local = host.createSession('local');
    const minted = (await host.dispatch(local, 'automations.webhook', { automationId: automation.id })) as MintedSecret;

    // A link preview, mail scanner, crawler or antivirus proxy issues a GET.
    // Firing an agent on one of those is remote code execution by accident.
    const withGet = await refusal(
      host.dispatch(local, 'automations.webhookFire', {
        automationId: automation.id,
        secret: minted.secret,
        method: 'GET',
      }),
    );
    expect(withGet.code).toBe('forbidden');
    expect(withGet.message).toContain('must be POSTed');

    for (const method of ['HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      const refused = await refusal(
        host.dispatch(local, 'automations.webhookFire', {
          automationId: automation.id,
          secret: minted.secret,
          method,
        }),
      );
      expect(refused.code).toBe('forbidden');
    }

    // Omitting the method defaults to GET, which is refused: a forgetful caller
    // fires nothing.
    const omitted = await refusal(
      host.dispatch(local, 'automations.webhookFire', { automationId: automation.id, secret: minted.secret }),
    );
    expect(omitted.code).toBe('forbidden');
    expect(calls).toHaveLength(0);
  });

  it('refuses a revoked secret and accepts a freshly minted one', async () => {
    const { host, automation } = bootWebhook();
    const local = host.createSession('local');
    const minted = (await host.dispatch(local, 'automations.webhook', { automationId: automation.id })) as MintedSecret;

    const revoked = (await host.dispatch(local, 'automations.webhookRevoke', {
      automationId: automation.id,
    })) as { revoked: boolean };
    expect(revoked.revoked).toBe(true);
    expect(host.store.listSecrets().map((meta) => meta.name)).not.toContain(webhookSecretName(automation.id));

    const afterRevoke = await refusal(
      host.dispatch(local, 'automations.webhookFire', {
        automationId: automation.id,
        secret: minted.secret,
        method: 'POST',
      }),
    );
    expect(afterRevoke.code).toBe('forbidden');
    expect(afterRevoke.message).toContain('no webhook secret is configured');

    const fresh = (await host.dispatch(local, 'automations.webhook', {
      automationId: automation.id,
      rotate: true,
    })) as MintedSecret;
    const fired = (await host.dispatch(local, 'automations.webhookFire', {
      automationId: automation.id,
      secret: fresh.secret,
      method: 'POST',
    })) as FireResult;
    expect(fired.status).toBe('started');

    // Revoking twice is not an error, it is just false the second time.
    await host.dispatch(local, 'automations.webhookRevoke', { automationId: automation.id });
    const second = (await host.dispatch(local, 'automations.webhookRevoke', {
      automationId: automation.id,
    })) as { revoked: boolean };
    expect(second.revoked).toBe(false);
  });

  it('refuses a webhook for a disabled automation', async () => {
    const { host, automation } = bootWebhook();
    const local = host.createSession('local');
    const minted = (await host.dispatch(local, 'automations.webhook', { automationId: automation.id })) as MintedSecret;
    host.store.setAutomationEnabled(automation.id, false);

    const error = await refusal(
      host.dispatch(local, 'automations.webhookFire', {
        automationId: automation.id,
        secret: minted.secret,
        method: 'POST',
      }),
    );
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('disabled');
  });

  it('refuses to fire a non-webhook automation even with a valid-looking secret', async () => {
    const { host, agentId } = bootWebhook();
    const scheduled = host.store.createAutomation({
      agentId,
      name: 'clock',
      trigger: 'schedule',
      cron: '0 8 * * *',
      prompt: 'morning',
    });
    const error = await refusal(
      host.dispatch(host.createSession('local'), 'automations.webhookFire', {
        automationId: scheduled.id,
        secret: 'anything',
        method: 'POST',
      }),
    );
    expect(error.code).toBe('bad-request');
  });

  it('skips a second request while the first run is still going', async () => {
    let held = 1;
    const pending: Array<() => void> = [];
    const { host, automation, calls } = bootWebhook({
      execute: () =>
        new Promise<void>((resolve) => {
          if (held > 0) {
            held -= 1;
            pending.push(resolve);
            return;
          }
          resolve();
        }),
    });
    const local = host.createSession('local');
    const minted = (await host.dispatch(local, 'automations.webhook', { automationId: automation.id })) as MintedSecret;

    const first = (await host.dispatch(local, 'automations.webhookFire', {
      automationId: automation.id,
      secret: minted.secret,
      method: 'POST',
    })) as FireResult;
    expect(first.status).toBe('started');

    const second = (await host.dispatch(local, 'automations.webhookFire', {
      automationId: automation.id,
      secret: minted.secret,
      method: 'POST',
    })) as FireResult;
    expect(second.status).toBe('skipped');
    expect(second.reason).toContain('still going');
    expect(calls).toHaveLength(1);

    pending.shift()?.();
    await flush();
    const third = (await host.dispatch(local, 'automations.webhookFire', {
      automationId: automation.id,
      secret: minted.secret,
      method: 'POST',
    })) as FireResult;
    expect(third.status).toBe('started');
    expect(calls).toHaveLength(2);
  });
});

describe('the secret stays out of everything that is returned or logged', () => {
  it('never appears in status, in a fire result, in the URL or in a log line', async () => {
    const { host, automation, logs } = bootWebhook();
    const local = host.createSession('local');
    const minted = (await host.dispatch(local, 'automations.webhook', { automationId: automation.id })) as MintedSecret;

    await host.dispatch(local, 'automations.webhookFire', {
      automationId: automation.id,
      secret: minted.secret,
      method: 'POST',
    });
    // A refusal path too, because error strings are the usual leak.
    await refusal(
      host.dispatch(local, 'automations.webhookFire', {
        automationId: automation.id,
        secret: 'wrong',
        method: 'POST',
      }),
    );
    await refusal(
      host.dispatch(local, 'automations.webhook', { automationId: automation.id, rotate: 'yes' }),
    );

    const status = await host.dispatch(local, 'scheduler.status', {});
    const describe = await host.dispatch(local, 'host.describe', {});
    const jobs = await host.dispatch(local, 'automations.list', {});

    const haystack = [
      JSON.stringify(status),
      JSON.stringify(describe),
      JSON.stringify(jobs),
      JSON.stringify(logs),
      JSON.stringify(minted.note),
      minted.url,
    ].join('\n');
    expect(haystack).not.toContain(minted.secret);
    // Not even a prefix of it, which is what an over-helpful truncation leaks.
    expect(haystack).not.toContain(minted.secret.slice(0, 8));
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe('constant-time verification', () => {
  it('compares through node:crypto timingSafeEqual rather than an early-exit equality', () => {
    const source = readFileSync(new URL('../src/webhook.ts', import.meta.url), 'utf8');
    expect(source).toContain("from 'node:crypto'");
    expect(source).toContain('timingSafeEqual(');
    // Both sides are hashed first, so the comparison is a fixed-width memcmp and
    // cannot leak the secret's length.
    expect(source).toContain("createHash('sha256')");
    expect(source).not.toMatch(/expected\s*===\s*presented/);
  });

  it('accepts only the exact secret and never throws on a hostile value', () => {
    const secret = newWebhookSecret();
    expect(verifyWebhookSecret(secret, secret)).toBe(true);
    expect(verifyWebhookSecret(secret, `${secret.slice(0, -1)}x`)).toBe(false);
    expect(verifyWebhookSecret(secret, secret.slice(0, -1))).toBe(false);
    expect(verifyWebhookSecret(secret, `${secret}extra`)).toBe(false);
    expect(verifyWebhookSecret(secret, '')).toBe(false);
    expect(verifyWebhookSecret(secret, 'x'.repeat(10_000))).toBe(false);
    expect(verifyWebhookSecret(secret, 'são-paulo-\u0000-\ud83d\ude00')).toBe(false);
    // An empty stored secret means "no webhook is configured"; it must never
    // match the empty string a forgetful caller sends.
    expect(verifyWebhookSecret('', '')).toBe(false);
    expect(verifyWebhookSecret('', secret)).toBe(false);
  });

  it('mints a distinct secret every time', () => {
    const secrets = new Set(Array.from({ length: 32 }, () => newWebhookSecret()));
    expect(secrets.size).toBe(32);
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThanOrEqual(32);
      expect(secret).not.toContain('=');
    }
  });

  it('builds the URL without the secret even before the host has bound a socket', () => {
    const { host, automation } = bootWebhook();
    const built = webhookUrl(host, automation.id);
    expect(built.url).toBe(`/webhooks/automations/${automation.id}`);
    expect(built.note).toContain('x-guhbot-webhook-secret');
  });
});

describe('authorization classes', () => {
  it('makes handing out a secret person class and observation background class', async () => {
    const { host, automation } = bootWebhook();
    const methods = host.describeMethods();
    const authz = (name: string): string | undefined => methods.find((method) => method.name === name)?.authz;

    expect(authz('automations.webhook')).toBe('person');
    expect(authz('automations.webhookRevoke')).toBe('person');
    expect(authz('automations.webhookFire')).toBe('person');
    expect(authz('scheduler.status')).toBe('background');

    const background = createDevice(host, 'background');
    const person = createDevice(host, 'person');

    const forbidden = await refusal(
      host.dispatch(background, 'automations.webhook', { automationId: automation.id }),
    );
    expect(forbidden.code).toBe('forbidden');
    expect(forbidden.message).toContain('human presence');

    expect((await refusal(host.dispatch(background, 'automations.webhookRevoke', { automationId: automation.id }))).code).toBe(
      'forbidden',
    );
    expect(
      (await refusal(
        host.dispatch(background, 'automations.webhookFire', { automationId: automation.id, secret: 'x', method: 'POST' }),
      )).code,
    ).toBe('forbidden');

    // A person-class device may mint it.
    const minted = (await host.dispatch(person, 'automations.webhook', { automationId: automation.id })) as MintedSecret;
    expect(minted.secret.length).toBeGreaterThanOrEqual(32);

    // Observation is open to a paired device, and the status shape carries no
    // credential.
    const status = (await host.dispatch(background, 'scheduler.status', {})) as { jobs: unknown[]; catchUp: string };
    expect(status.catchUp).toBe('once');
    expect(JSON.stringify(status)).not.toContain(minted.secret);
  });

  it('filters scheduler.status by agent and reports the registered jobs', async () => {
    const { host, automation, agentId } = bootWebhook();
    const other = host.store.createAgent({ name: 'other' });
    host.store.createAutomation({
      agentId: other.id,
      name: 'other clock',
      trigger: 'schedule',
      cron: '30 7 * * *',
      prompt: 'other work',
    });

    const status = (await host.dispatch(host.createSession('local'), 'scheduler.status', { agentId })) as {
      jobs: Array<{ automationId: string; registered: boolean; note: string | null }>;
    };
    expect(status.jobs.map((job) => job.automationId)).toEqual([automation.id]);
    expect(status.jobs[0]!.registered).toBe(false);

    const all = (await host.dispatch(host.createSession('local'), 'scheduler.status', {})) as {
      jobs: Array<{ registered: boolean }>;
    };
    expect(all.jobs).toHaveLength(2);
  });
});
