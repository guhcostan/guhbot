import type { Capability } from '@guhbot/agent';
import { createSchedulerMethods } from './methods.js';
import { Scheduler, type SchedulerOptions } from './scheduler.js';
import { createScheduleTools } from './tools.js';

/**
 * The scheduler capability.
 *
 * It contributes the tools an agent uses to manage its own schedule, the RPC
 * methods a client uses to manage automations and webhooks, and one flag so
 * `host.status.capabilities` says whether anything is actually keeping time.
 *
 * Wiring note for the application: `ready()` starts the timer, and the first
 * tick deliberately lands on the event loop rather than in `ready()` itself,
 * because the host is constructed with this capability's methods already in
 * hand — so `options.host` cannot be resolved until after `ready()` has run.
 * The returned object also exposes `.scheduler` for an application that would
 * rather start, stop or inspect it explicitly (for example, only after the
 * server has bound its socket).
 */
export interface SchedulerCapability extends Capability {
  readonly scheduler: Scheduler;
}

export function createSchedulerCapability(options: SchedulerOptions): SchedulerCapability {
  const scheduler = new Scheduler(options);

  return {
    name: 'scheduler',
    summary: 'Fires scheduled and webhook automations, and lets an agent manage its own schedule.',
    flags: { scheduler: true },
    ready: async () => {
      scheduler.start();
    },
    tools: () => createScheduleTools(scheduler),
    methods: createSchedulerMethods(scheduler),
    dispose: async () => {
      await scheduler.dispose();
    },
    scheduler,
  };
}
