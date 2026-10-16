import { HostError } from '@guhbot/host-core';
import type { ContributedMethod, Host } from '@guhbot/host-core';
import { IdSchema, RunSchema } from '@guhbot/protocol';
import type { Automation } from '@guhbot/protocol';
import { z } from 'zod';
import type { Scheduler } from './scheduler.js';
import { WEBHOOK_SECRET_HEADER, verifyWebhookSecret, webhookUrl } from './webhook.js';

/**
 * The client-facing half of the capability.
 *
 * Two boundaries are worth stating here rather than in a comment on one handler:
 *
 *  1. **Handing out a secret is `person` work.** `automations.webhook` returns a
 *     live credential, so the host checks that the caller is a person-class
 *     device before the handler runs. A stolen, merely-paired phone gets
 *     `forbidden`, which is the whole point of the class.
 *  2. **Verifying a secret is not.** `automations.webhookFire` is what the host's
 *     HTTP surface dispatches when a webhook POST arrives; the caller is an
 *     external service with no device at all, so the secret is the credential
 *     and the check happens inside the handler. It refuses anything that is not
 *     a POST, and the schema's default is GET so a caller that forgets to say
 *     POST fires nothing.
 */

const AutomationIdInput = z.object({ automationId: IdSchema });

const WebhookSecretInput = z.object({
  automationId: IdSchema,
  /** Replace an existing secret instead of returning it. Revokes the old value. */
  rotate: z.boolean().default(false),
});

const WebhookSecretOutput = z.object({
  automationId: IdSchema,
  /** Absolute when the host has bound a socket, otherwise the path to route. */
  url: z.string().min(1).max(2048),
  /** Returned once per call to a person-class device. Never logged, never in the URL. */
  secret: z.string().min(1).max(512),
  rotated: z.boolean(),
  note: z.string().max(1000).nullable(),
});

const WebhookRevokeOutput = z.object({
  automationId: IdSchema,
  /** False when there was nothing to revoke, which is not an error. */
  revoked: z.boolean(),
});

const WebhookFireInput = z.object({
  automationId: IdSchema,
  secret: z.string().max(512).default(''),
  /**
   * The HTTP method of the request that carried the secret. GET is the default
   * on purpose: a caller that forgets to declare POST is refused instead of
   * firing an agent.
   */
  method: z.enum(['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).default('GET'),
});

const WebhookFireOutput = z.object({
  automationId: IdSchema,
  status: z.enum(['started', 'skipped', 'failed']),
  run: RunSchema.nullable(),
  reason: z.string().max(1000).nullable(),
});

const ScheduleJobSchema = z.object({
  automationId: IdSchema,
  agentId: IdSchema,
  name: z.string().max(200),
  trigger: z.enum(['schedule', 'webhook', 'manual']),
  cron: z.string().max(200).nullable(),
  enabled: z.boolean(),
  registered: z.boolean(),
  nextRunAt: z.string().max(64).nullable(),
  lastRunAt: z.string().max(64).nullable(),
  running: z.boolean(),
  overdueMs: z.number().int().min(0).nullable(),
  note: z.string().max(500).nullable(),
  lastError: z.string().max(500).nullable(),
});

export const SchedulerStatusOutput = z.object({
  running: z.boolean(),
  disposed: z.boolean(),
  catchUp: z.enum(['once', 'skip']),
  pollMs: z.number().int().min(100),
  ticks: z.number().int().min(0),
  fires: z.number().int().min(0),
  skipped: z.number().int().min(0),
  lastError: z.string().max(500).nullable(),
  jobs: z.array(ScheduleJobSchema).max(10_000),
});

function requireAutomation(host: Host, automationId: string): Automation {
  const automation = host.store.getAutomation(automationId);
  if (automation === null) throw new HostError('not-found', `no automation ${automationId}`);
  if (automation.trigger !== 'webhook') {
    throw new HostError(
      'bad-request',
      `automation ${automationId} is a "${automation.trigger}" automation: only a webhook automation has a webhook URL`,
    );
  }
  return automation;
}

export function createSchedulerMethods(scheduler: Scheduler): Record<string, ContributedMethod> {
  return {
    'automations.webhook': {
      // A live credential leaves the host through this method, so it needs a
      // device a human created while physically present.
      authz: 'person',
      input: WebhookSecretInput,
      output: WebhookSecretOutput,
      summary: 'Return the webhook URL for a webhook automation and mint or rotate its secret.',
      handler: async (host, _session, input) => {
        const parsed = WebhookSecretInput.parse(input);
        const automation = requireAutomation(host, parsed.automationId);

        let secret = scheduler.secrets().read(host, automation.id);
        let rotated = false;
        if (secret === null || parsed.rotate) {
          secret = scheduler.secrets().mint(host, automation.id);
          rotated = true;
        }
        const { url, note } = webhookUrl(host, automation.id);
        return { automationId: automation.id, url, secret, rotated, note };
      },
    },

    'automations.webhookRevoke': {
      // Revoking is a durable-state change and it decides whether an unattended
      // agent may still be started from outside, so it is person class.
      authz: 'person',
      input: AutomationIdInput,
      output: WebhookRevokeOutput,
      summary: 'Revoke the webhook secret of an automation, permanently refusing its webhook URL.',
      handler: async (host, _session, input) => {
        const parsed = AutomationIdInput.parse(input);
        const automation = requireAutomation(host, parsed.automationId);
        return { automationId: automation.id, revoked: scheduler.secrets().revoke(host, automation.id) };
      },
    },

    'automations.webhookFire': {
      // Starting a run is a durable write, so this stays person class even though
      // the real gate is the secret: the host's HTTP surface dispatches it with
      // the host's own local session, and a background-class device is refused
      // before the secret is even compared.
      authz: 'person',
      input: WebhookFireInput,
      output: WebhookFireOutput,
      summary: 'Start a webhook automation from a POST carrying its secret. GET is refused.',
      handler: async (host, _session, input) => {
        const parsed = WebhookFireInput.parse(input);

        // Refused before anything else: a link preview, mail scanner, crawler or
        // antivirus proxy follows a URL with GET, and firing an agent on one of
        // those is a remote-code-execution surface, not a webhook.
        if (parsed.method !== 'POST') {
          throw new HostError(
            'forbidden',
            `a webhook must be POSTed; ${parsed.method} is refused so that anything which merely follows the URL cannot start this agent`,
          );
        }

        const automation = requireAutomation(host, parsed.automationId);
        if (!automation.enabled) {
          throw new HostError('forbidden', `automation ${automation.id} is disabled`);
        }

        const expected = scheduler.secrets().read(host, automation.id);
        if (expected === null) {
          throw new HostError(
            'forbidden',
            `no webhook secret is configured for automation ${automation.id}; mint one with automations.webhook`,
          );
        }
        if (!verifyWebhookSecret(expected, parsed.secret)) {
          // The presented value is never echoed, never logged and never compared
          // with anything but the constant-time check above.
          throw new HostError('forbidden', `the ${WEBHOOK_SECRET_HEADER} header did not match this automation's secret`);
        }

        const outcome = await scheduler.fire(automation.id, 'webhook');
        return {
          automationId: automation.id,
          status: outcome.status,
          run: outcome.run,
          reason: outcome.reason,
        };
      },
    },

    'scheduler.status': {
      // Observation only: it reports ids, cron expressions and fire times. No
      // secret and no prompt is ever part of this shape.
      authz: 'background',
      input: z.object({ agentId: IdSchema.optional() }),
      output: SchedulerStatusOutput,
      summary: 'Registered schedules, their next fire times, and whether the scheduler is ticking.',
      handler: async (_host, _session, input) => {
        const parsed = z.object({ agentId: IdSchema.optional() }).parse(input);
        const status = scheduler.status(parsed.agentId);
        return {
          running: status.running,
          disposed: status.disposed,
          catchUp: status.catchUp,
          pollMs: status.pollMs,
          ticks: status.ticks,
          fires: status.fires,
          skipped: status.skipped,
          lastError: status.lastError,
          jobs: status.jobs.map((job) => ({
            automationId: job.automationId,
            agentId: job.agentId,
            name: job.name,
            trigger: job.trigger,
            cron: job.cron,
            enabled: job.enabled,
            registered: job.registered,
            nextRunAt: job.nextRunAt,
            lastRunAt: job.lastRunAt,
            running: job.running,
            overdueMs: job.overdueMs,
            note: job.note,
            lastError: job.lastError,
          })),
        };
      },
    },
  };
}
