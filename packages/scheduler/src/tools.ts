import type { ToolDefinition } from '@guhbot/agent';
import type { Automation } from '@guhbot/protocol';
import type { Scheduler, ScheduleJob } from './scheduler.js';

/**
 * The agent-facing half of the capability.
 *
 * "Its own schedule" is ambiguous on a host with several agents, and the model
 * cannot know which agent it is running as: `ToolExecutionContext` carries no
 * agent identity. Resolution is therefore explicit, in this order:
 *
 *   1. the host's `resolveAgentId` hook, when the application pinned one;
 *   2. an `agentId` argument, for a host that wants the model to choose;
 *   3. the only agent on the host, when there is exactly one;
 *   4. otherwise a refusal that says how many agents exist.
 *
 * Mutating a schedule is durable state that will run unattended later, so
 * `schedule_create` and `schedule_delete` both require approval. Listing does
 * not, which is what lets an agent answer "what am I scheduled to do" without
 * waking anyone up.
 */

function asObject(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('tool arguments must be a JSON object');
  }
  return args as Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`"${key}" is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string when present`);
  return value.trim();
}

function resolveAgentId(scheduler: Scheduler, requested: string | null): string {
  const store = scheduler.store();
  const bound = scheduler.boundAgentId();

  if (bound !== null) {
    if (requested !== null && requested !== bound) {
      throw new Error(`this host's schedule tools are bound to agent ${bound}; refusing to schedule for ${requested}`);
    }
    if (store.getAgent(bound) === null) throw new Error(`no agent ${bound} on this host`);
    return bound;
  }

  if (requested !== null) {
    if (store.getAgent(requested) === null) throw new Error(`no agent ${requested} on this host`);
    return requested;
  }

  const agents = store.listAgents();
  const only = agents.length === 1 ? agents[0] : undefined;
  if (only === undefined) {
    throw new Error(
      `this host has ${agents.length} agents, so "my schedule" is ambiguous; pass agentId explicitly`,
    );
  }
  return only.id;
}

function present(job: ScheduleJob): Record<string, unknown> {
  return {
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
    note: job.note,
  };
}

function findByName(scheduler: Scheduler, agentId: string | null, name: string): Automation {
  const candidates = scheduler
    .store()
    .listAutomations(agentId ?? undefined)
    .filter((automation) => automation.name === name);
  if (candidates.length === 0) {
    const known = scheduler
      .store()
      .listAutomations(agentId ?? undefined)
      .map((automation) => automation.name);
    throw new Error(
      `no automation named "${name}"${known.length > 0 ? `; this host has: ${known.join(', ')}` : ''}`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `${candidates.length} automations are named "${name}"; pass automationId to choose one`,
    );
  }
  return candidates[0]!;
}

export function createScheduleTools(scheduler: Scheduler): ToolDefinition[] {
  return [
    {
      name: 'schedule_create',
      description:
        'Create a recurring schedule that starts a run with a prompt. The cron expression is five fields ' +
        '(minute hour day-of-month month day-of-week) read in the host\'s local time zone. ' +
        'When both day fields are restricted, a date matches if either matches, so "0 0 1 * 1" means ' +
        'the first of the month OR any Monday.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short label, e.g. "morning inbox triage".' },
          cron: {
            type: 'string',
            description:
              'Five-field cron: minute hour day-of-month month day-of-week. Supports *, ranges (9-17), ' +
              'steps (a star with /15), and lists (1,15). Day-of-week: 0 or 7 is Sunday.',
          },
          prompt: { type: 'string', description: 'The prompt dispatched when the schedule fires.' },
          agentId: { type: 'string', description: 'Agent to run as. Only needed when this host has several.' },
        },
        required: ['name', 'cron', 'prompt'],
        additionalProperties: false,
      },
      requiresApproval: true,
      execute: async (args) => {
        const object = asObject(args);
        const name = requireString(object, 'name');
        const cron = requireString(object, 'cron');
        const prompt = requireString(object, 'prompt');
        const requested = optionalString(object, 'agentId');

        if (name.length > 200) throw new Error('"name" must be at most 200 characters');
        if (cron.length > 200) throw new Error('"cron" must be at most 200 characters');
        if (prompt.length > 100_000) throw new Error('"prompt" must be at most 100000 characters');

        const agentId = resolveAgentId(scheduler, requested);
        const job = scheduler.createSchedule({ agentId, name, cron, prompt });
        return JSON.stringify(
          {
            created: present(job),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            note: 'The next fire time is computed in memory; automations.list reports nextRunAt as null.',
          },
          null,
          2,
        );
      },
    },

    {
      name: 'schedule_list',
      description: 'List this agent\'s automations with their cron expressions and next fire times.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Restrict the listing to one agent.' },
        },
        additionalProperties: false,
      },
      requiresApproval: false,
      execute: async (args) => {
        const object = asObject(args);
        const requested = optionalString(object, 'agentId');
        const bound = scheduler.boundAgentId();
        const agentId = requested ?? bound;
        const schedules = scheduler.listSchedules(agentId ?? undefined);
        return JSON.stringify(
          {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            schedules: schedules.map(present),
          },
          null,
          2,
        );
      },
    },

    {
      name: 'schedule_delete',
      description:
        'Stop a schedule so it never fires again, and revoke its webhook secret. host-core keeps the ' +
        'automation row (Store exposes no delete), so it stays visible in automations.list as disabled.',
      parameters: {
        type: 'object',
        properties: {
          automationId: { type: 'string', description: 'Id from schedule_list. Preferred.' },
          name: { type: 'string', description: 'Exact name, when it is unambiguous.' },
        },
        additionalProperties: false,
      },
      requiresApproval: true,
      execute: async (args) => {
        const object = asObject(args);
        const automationId = optionalString(object, 'automationId');
        const name = optionalString(object, 'name');

        const bound = scheduler.boundAgentId();
        let target: Automation;
        if (automationId !== null) {
          const found = scheduler.store().getAutomation(automationId);
          if (found === null) throw new Error(`no automation ${automationId}`);
          target = found;
        } else if (name !== null) {
          target = findByName(scheduler, bound, name);
        } else {
          throw new Error('pass automationId or name');
        }
        if (bound !== null && target.agentId !== bound) {
          throw new Error(`automation ${target.id} belongs to agent ${target.agentId}, not ${bound}`);
        }

        const result = scheduler.disableSchedule(target.id);
        return JSON.stringify(
          {
            stopped: result.disabled,
            automationId: result.automationId,
            webhookSecretRevoked: result.secretRevoked,
            schedule: result.schedule === null ? null : present(result.schedule),
            note: 'The automation is disabled and will never fire again; the row itself is not deleted.',
          },
          null,
          2,
        );
      },
    },
  ];
}
