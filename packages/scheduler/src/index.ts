/**
 * @guhbot/scheduler — the automations scheduler.
 *
 * An automation row is a promise that something will happen later. This package
 * is what keeps it: it parses cron, computes the next fire time in the host's
 * local time zone, wakes at the right moment, starts the run through `Host`, and
 * refuses to stack a second run on top of one that is still going.
 *
 * It owns no durable state. Automations are read and written through `Store`,
 * runs are started through `Host`, and webhook credentials live in host-core's
 * sealed `secrets` table.
 */
export { createSchedulerCapability } from './capability.js';
export type { SchedulerCapability } from './capability.js';

export { Scheduler } from './scheduler.js';
export type {
  CatchUpMode,
  CreateScheduleInput,
  DisableScheduleResult,
  FireOutcome,
  ScheduleJob,
  SchedulerLogEvent,
  SchedulerLogKind,
  SchedulerOptions,
  SchedulerStatus,
  TickResult,
  TimerScheduler,
} from './scheduler.js';

export { CronError, describeCron, isValidCron, matchesDay, nextFireTime, parseCron } from './cron.js';
export type { CronSchedule } from './cron.js';

export {
  WEBHOOK_SECRET_HEADER,
  WebhookSecrets,
  newWebhookSecret,
  verifyWebhookSecret,
  webhookSecretName,
  webhookUrl,
} from './webhook.js';
export type { WebhookUrl } from './webhook.js';

export { SchedulerStatusOutput, createSchedulerMethods } from './methods.js';
export { createScheduleTools } from './tools.js';
