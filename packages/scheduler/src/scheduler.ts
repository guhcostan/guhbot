import type { Automation, AutomationTrigger, Run } from '@guhbot/protocol';
import type { Host, Session, Store } from '@guhbot/host-core';
import { nextFireTime, parseCron, type CronSchedule } from './cron.js';
import { WebhookSecrets } from './webhook.js';

/**
 * The scheduler.
 *
 * It owns exactly one thing: the mapping from an `Automation` row to the next
 * instant it should fire, held in memory. It owns no database, opens no socket
 * and writes nothing except through `Store` and `Host` — see
 * `docs/engineering.md`. The durable anchors it needs already exist on the row:
 * `cron` says when, `last_run_at` says when it last fired, and `created_at` is
 * the fallback for an automation that has never fired.
 *
 * ## Catch-up after downtime
 *
 * The policy is COALESCE, and it is a deliberate choice between two bad options.
 * `catchUp: 'once'` (the default) fires the missed occurrence exactly once at the
 * first tick after the host comes back, then jumps to the next future
 * occurrence. `catchUp: 'skip'` drops overdue occurrences entirely and starts
 * from the next future one.
 *
 * Firing every missed occurrence is not on the table: a host that was off for
 * three days would start 72 runs of an hourly job on boot, which spends the
 * user's money, floods the transcript, and is not what "every hour" meant. But
 * skipping everything silently is also wrong: a daily 08:00 triage that was
 * missed because the laptop was shut at 08:00 would never happen. Coalescing
 * keeps the intent (the work happens once, as soon as the host is back) without
 * the storm, and every dropped occurrence is counted in `scheduler.status` and
 * logged, so nothing disappears quietly.
 *
 * ## One run at a time
 *
 * If the previous run an automation started is still going, the next occurrence
 * is skipped rather than queued behind it. Two runs of the same automation
 * racing on the same mailbox or repository is how an automation corrupts
 * something that works perfectly when run by hand. In-flight state is in memory
 * on purpose: `runs` has no column linking a run to the automation that started
 * it, and host-core fails every unfinished run at boot, so a restart cannot
 * leave a run that is genuinely still executing.
 */

export type CatchUpMode = 'once' | 'skip';

/** The timer seam. Injected so a test can move time instead of waiting for it. */
export interface TimerScheduler {
  setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: TimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export type SchedulerLogKind =
  | 'started'
  | 'stopped'
  | 'disposed'
  | 'created'
  | 'fired'
  | 'skipped'
  | 'fire-failed'
  | 'unusable-automation'
  | 'error';

export interface SchedulerLogEvent {
  readonly kind: SchedulerLogKind;
  readonly automationId: string | null;
  /**
   * Human-readable detail. It never carries a secret and never carries a prompt:
   * a prompt is user text that may itself contain credentials.
   */
  readonly detail: string | null;
}

export interface SchedulerOptions {
  /**
   * Supplies the host. A getter rather than the host itself because the host is
   * constructed with this capability's methods already in hand; the first tick
   * happens on the event loop, after the application has finished wiring.
   */
  readonly host: () => Host;
  /** Injectable clock. Every decision this scheduler makes goes through it. */
  readonly now?: () => Date;
  /** Injectable timers. Defaults to the real ones. */
  readonly timers?: TimerScheduler;
  /** What to do with occurrences missed while the host was not running. */
  readonly catchUp?: CatchUpMode;
  /**
   * Upper bound on a single sleep, and therefore the cadence at which the store
   * is re-read for automations created by another client. It also means a
   * suspended host or a clock jump cannot hide a fire behind one long timer.
   */
  readonly pollMs?: number;
  /** Which agent "my schedule" means for the agent-facing tools. */
  readonly resolveAgentId?: () => string | null;
  /** Diagnostics sink. Never receives a secret or a prompt. */
  readonly log?: (event: SchedulerLogEvent) => void;
}

/** One automation, as the tools and `scheduler.status` see it. */
export interface ScheduleJob {
  readonly automationId: string;
  readonly agentId: string;
  readonly name: string;
  readonly trigger: AutomationTrigger;
  readonly cron: string | null;
  /** The row's own `enabled` flag. */
  readonly enabled: boolean;
  /** True when this scheduler is actually waiting on this automation. */
  readonly registered: boolean;
  /** Computed in memory. `Automation.nextRunAt` stays null: `Store` has no setter. */
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  /** True while a run this scheduler started is still going. */
  readonly running: boolean;
  /** How late the pending occurrence already is, when there is one. */
  readonly overdueMs: number | null;
  /** Why this automation is or is not armed, for diagnostics. */
  readonly note: string | null;
  readonly lastError: string | null;
}

export interface SchedulerStatus {
  readonly running: boolean;
  readonly disposed: boolean;
  readonly catchUp: CatchUpMode;
  readonly pollMs: number;
  readonly ticks: number;
  /** Runs started by this scheduler since it was constructed. */
  readonly fires: number;
  /** Occurrences that produced no run: coalesced, skipped, refused or failed. */
  readonly skipped: number;
  readonly lastError: string | null;
  readonly jobs: ScheduleJob[];
}

export interface TickResult {
  readonly fires: number;
  readonly skipped: number;
  /** True when a tick was already in progress; nothing was evaluated twice. */
  readonly busy: boolean;
}

export interface FireOutcome {
  readonly status: 'started' | 'skipped' | 'failed';
  readonly run: Run | null;
  readonly reason: string | null;
}

export interface CreateScheduleInput {
  readonly agentId: string;
  readonly name: string;
  readonly cron: string;
  readonly prompt: string;
}

export interface DisableScheduleResult {
  readonly automationId: string;
  readonly disabled: boolean;
  readonly secretRevoked: boolean;
  readonly schedule: ScheduleJob | null;
}

interface Job {
  automationId: string;
  agentId: string;
  name: string;
  cron: string;
  schedule: CronSchedule;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  /**
   * False until the first tick that saw this job. The catch-up policy applies at
   * that moment and never again, so a tick that merely runs late does not throw
   * away an occurrence.
   */
  primed: boolean;
  lastError: string | null;
}

/**
 * Cap on how many missed occurrences one tick will count. The count is a
 * diagnostic, not a decision, so a host that was off for a year of every-minute
 * fires reports the cap rather than stalling the tick walk walking through
 * half a million occurrences.
 */
const MAX_COALESCE_COUNT = 256;

function isTerminal(status: Run['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'interrupted';
}

function truncate(text: string, limit = 300): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Scheduler {
  private readonly options: SchedulerOptions;
  private readonly timers: TimerScheduler;
  private readonly now: () => Date;
  private readonly catchUp: CatchUpMode;
  private readonly pollMs: number;
  private readonly logEvent: (event: SchedulerLogEvent) => void;
  private readonly jobs = new Map<string, Job>();
  /** Automation id to the runs it started that have not finished. */
  private readonly inFlight = new Map<string, Set<string>>();

  private vault: WebhookSecrets | null = null;
  private timer: unknown = null;
  private releaseRuns: (() => void) | null = null;
  private session: Session | null = null;
  private running = false;
  private busy = false;
  /** True once a sync has been attempted, successfully or not. */
  private syncedOnce = false;
  private disposed = false;
  private ticks = 0;
  private fires = 0;
  private skipped = 0;
  private lastError: string | null = null;

  constructor(options: SchedulerOptions) {
    this.options = options;
    this.timers = options.timers ?? realTimers;
    this.now = options.now ?? (() => new Date());
    this.catchUp = options.catchUp ?? 'once';
    this.pollMs = options.pollMs ?? 30_000;
    this.logEvent = options.log ?? (() => undefined);
    if (!Number.isInteger(this.pollMs) || this.pollMs < 100) {
      throw new Error(
        `scheduler pollMs must be a whole number of milliseconds of at least 100, got ${String(options.pollMs)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Begin ticking. Idempotent, and safe to call before the host exists. */
  start(): void {
    if (this.disposed) throw new Error('this scheduler has been disposed');
    if (this.running) return;
    this.running = true;
    this.log({ kind: 'started', automationId: null, detail: null });
    // A zero-delay first tick rather than a synchronous one: the store must not
    // be touched before the application that owns it has finished wiring.
    this.arm();
  }

  /** Stop ticking without discarding what is known about the automations. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.clearTimer();
    this.log({ kind: 'stopped', automationId: null, detail: null });
  }

  /** Stop the timer, drop pending work, release the run listener. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.clearTimer();
    this.jobs.clear();
    this.inFlight.clear();
    this.releaseRuns?.();
    this.releaseRuns = null;
    this.log({ kind: 'disposed', automationId: null, detail: null });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  /**
   * Evaluate every job against the current time. The timer calls this; tests
   * call it directly after moving their clock, which is why it is public.
   */
  async tick(): Promise<TickResult> {
    if (this.disposed) return { fires: 0, skipped: 0, busy: false };
    if (this.busy) return { fires: 0, skipped: 0, busy: true };

    this.busy = true;
    let fires = 0;
    let skipped = 0;
    try {
      this.sync();
      const now = this.now();
      // Earliest pending occurrence first, so a slow fire cannot reorder a burst.
      const jobs = [...this.jobs.values()].sort(
        (a, b) =>
          (a.nextRunAt?.getTime() ?? Number.POSITIVE_INFINITY) -
          (b.nextRunAt?.getTime() ?? Number.POSITIVE_INFINITY),
      );
      for (const job of jobs) {
        const firstSighting = !job.primed;
        job.primed = true;
        if (job.nextRunAt === null || job.nextRunAt.getTime() > now.getTime()) continue;
        const outcome = await this.handleDue(job, now, firstSighting);
        fires += outcome.fires;
        skipped += outcome.skipped;
        if (this.disposed) break;
      }
      this.ticks += 1;
      return { fires, skipped, busy: false };
    } catch (error) {
      this.recordError(error);
      return { fires, skipped, busy: false };
    } finally {
      this.busy = false;
      this.arm();
    }
  }

  private async handleDue(
    job: Job,
    now: Date,
    firstSighting: boolean,
  ): Promise<{ fires: number; skipped: number }> {
    const occurrence = job.nextRunAt;
    if (occurrence === null) return { fires: 0, skipped: 0 };

    const missed = countOccurrences(job.schedule, occurrence, now);
    const overdueMs = Math.max(0, now.getTime() - occurrence.getTime());

    // Advance first. If firing throws, or the previous run is still going, the
    // occurrence must not stay pending: a tick that retries the same instant
    // forever is a spin loop that burns the host.
    job.nextRunAt = nextFireTime(job.schedule, now);

    if (firstSighting && this.catchUp === 'skip') {
      this.skipped += missed;
      this.log({
        kind: 'skipped',
        automationId: job.automationId,
        detail: `catch-up policy is "skip": dropped ${missed} occurrence(s), the pending one was ${String(overdueMs)}ms late`,
      });
      return { fires: 0, skipped: missed };
    }

    if (missed > 1) {
      this.log({
        kind: 'skipped',
        automationId: job.automationId,
        detail: `coalesced ${missed - 1} missed occurrence(s) into a single run (pending occurrence was ${String(overdueMs)}ms late)`,
      });
    }

    const outcome = await this.fire(job.automationId, 'schedule');
    if (outcome.status !== 'started') {
      this.skipped += missed;
      return { fires: 0, skipped: missed };
    }

    const coalesced = missed - 1;
    this.skipped += coalesced;
    return { fires: 1, skipped: coalesced };
  }

  /**
   * Start a run for an automation. Used by the schedule tick and by the webhook
   * method; both go through the same refusal path.
   */
  async fire(automationId: string, reason: 'schedule' | 'webhook'): Promise<FireOutcome> {
    if (this.disposed) {
      return { status: 'skipped', run: null, reason: 'this scheduler has been disposed' };
    }

    if (this.isRunning(automationId)) {
      this.log({
        kind: 'skipped',
        automationId,
        detail: 'the previous run is still going, so this occurrence was skipped rather than stacked',
      });
      return { status: 'skipped', run: null, reason: 'the previous run of this automation is still going' };
    }

    let host: Host;
    try {
      host = this.options.host();
    } catch (error) {
      return this.fail(automationId, `the host is not available yet: ${errorText(error)}`);
    }

    const automation = host.store.getAutomation(automationId);
    if (automation === null) {
      return { status: 'skipped', run: null, reason: `no automation ${automationId}` };
    }
    if (!automation.enabled) {
      return { status: 'skipped', run: null, reason: `automation ${automationId} is disabled` };
    }

    try {
      const { run } = await host.startRun(this.sessionFor(host), automation.agentId, automation.prompt);
      host.store.markAutomationRun(automation.id);

      // A run that finished while we were awaiting startRun must not be recorded
      // as in flight, or the automation would refuse to fire again forever.
      const current = host.store.getRun(run.id);
      if (current !== null && !isTerminal(current.status)) this.track(automation.id, run.id, host);

      this.fires += 1;
      this.lastError = null;
      this.log({ kind: 'fired', automationId: automation.id, detail: `${reason} trigger started run ${run.id}` });
      return { status: 'started', run, reason: null };
    } catch (error) {
      return this.fail(automation.id, errorText(error));
    }
  }

  private fail(automationId: string, message: string): FireOutcome {
    const detail = truncate(message);
    this.lastError = detail;
    const job = this.jobs.get(automationId);
    if (job !== undefined) job.lastError = detail;
    this.log({ kind: 'fire-failed', automationId, detail });
    return { status: 'failed', run: null, reason: detail };
  }

  // -------------------------------------------------------------------------
  // Automations
  // -------------------------------------------------------------------------

  /**
   * Create a scheduled automation for an agent. Validates the cron here so a
   * schedule that can never fire is refused at creation rather than stored and
   * silently ignored.
   */
  createSchedule(input: CreateScheduleInput): ScheduleJob {
    const schedule = parseCron(input.cron);
    const host = this.options.host();

    if (host.store.getAgent(input.agentId) === null) {
      throw new Error(`no agent ${input.agentId} on this host`);
    }
    const text = input.cron.trim();
    if (nextFireTime(schedule, this.now()) === null) {
      throw new Error(`cron "${text}" never matches a real date, so it would never fire`);
    }

    const automation = host.store.createAutomation({
      agentId: input.agentId,
      name: input.name,
      trigger: 'schedule',
      cron: text,
      prompt: input.prompt,
    });
    this.sync();
    this.arm();
    const view = this.view(automation);
    this.log({
      kind: 'created',
      automationId: automation.id,
      detail: `created; next fire ${view.nextRunAt ?? 'never'}`,
    });
    return view;
  }

  /**
   * Stop an automation from ever firing again.
   *
   * `Store` exposes no delete, and nothing outside host-core may write SQL, so
   * this disables the row and revokes any webhook secret: the automation stays
   * visible in `automations.list` and can never run again. Callers should say so
   * rather than claiming the row is gone.
   */
  disableSchedule(automationId: string): DisableScheduleResult {
    const host = this.options.host();
    const automation = host.store.getAutomation(automationId);
    if (automation === null) {
      throw new Error(`no automation ${automationId}`);
    }
    const disabled = host.store.setAutomationEnabled(automationId, false);
    const secretRevoked = this.secrets().revoke(host, automationId);
    this.jobs.delete(automationId);
    this.arm();
    const updated = host.store.getAutomation(automationId);
    return {
      automationId,
      disabled: disabled !== null,
      secretRevoked,
      schedule: updated === null ? null : this.view(updated),
    };
  }

  /** Every automation on the host, with this scheduler's view of each. */
  listSchedules(agentId?: string): ScheduleJob[] {
    const host = this.options.host();
    return host.store.listAutomations(agentId).map((automation) => this.view(automation));
  }

  /** The view of a single automation, or null when it does not exist. */
  schedule(automationId: string): ScheduleJob | null {
    const automation = this.options.host().store.getAutomation(automationId);
    return automation === null ? null : this.view(automation);
  }

  status(agentId?: string): SchedulerStatus {
    return {
      running: this.running,
      disposed: this.disposed,
      catchUp: this.catchUp,
      pollMs: this.pollMs,
      ticks: this.ticks,
      fires: this.fires,
      skipped: this.skipped,
      lastError: this.lastError,
      jobs: this.listSchedules(agentId),
    };
  }

  /** The current pending occurrence for an automation, for callers that need it. */
  nextFireAt(automationId: string): string | null {
    return this.jobs.get(automationId)?.nextRunAt?.toISOString() ?? null;
  }

  /**
   * The store this scheduler drives. host-core owns it and this is the only way
   * automations are read or written; the scheduler never opens a database.
   */
  store(): Store {
    return this.options.host().store;
  }

  /** The agent the agent-facing tools speak for, when the host pinned one. */
  boundAgentId(): string | null {
    return this.options.resolveAgentId?.() ?? null;
  }

  /** Sealed-secret access for webhook credentials. */
  secrets(): WebhookSecrets {
    this.vault ??= new WebhookSecrets(this.options.host().dataDir);
    return this.vault;
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  /** Re-read automations from the store and add, refresh or drop jobs. */
  sync(): void {
    if (this.disposed) return;
    let automations: Automation[];
    try {
      automations = this.options.host().store.listAutomations();
    } catch (error) {
      // The host may not be wired yet. Mark the first sync as attempted so the
      // next wake is a poll away: arming at zero delay again would turn a host
      // that is not ready into a spin loop.
      this.syncedOnce = true;
      this.recordError(error);
      return;
    }

    const live = new Set<string>();
    for (const automation of automations) {
      if (automation.trigger !== 'schedule' || !automation.enabled) continue;
      live.add(automation.id);
      const existing = this.jobs.get(automation.id);
      if (existing !== undefined && existing.cron === automation.cron) {
        existing.agentId = automation.agentId;
        existing.name = automation.name;
        continue;
      }
      if (existing !== undefined) {
        // The expression changed. Recompute from the row's anchor rather than
        // from the old next-fire time, which belonged to a different expression.
        this.jobs.delete(automation.id);
      }
      const job = this.buildJob(automation);
      if (job !== null) this.jobs.set(automation.id, job);
    }

    for (const id of [...this.jobs.keys()]) {
      if (!live.has(id)) this.jobs.delete(id);
    }
    this.syncedOnce = true;
  }

  private buildJob(automation: Automation): Job | null {
    const cron = automation.cron;
    if (cron === null || cron.trim().length === 0) {
      this.note(`automation ${automation.id} has no cron expression, so it cannot be scheduled`);
      return null;
    }
    let schedule: CronSchedule;
    try {
      schedule = parseCron(cron);
    } catch (error) {
      this.note(`automation ${automation.id} has an unusable cron expression: ${errorText(error)}`);
      return null;
    }

    const anchor = parseAnchor(automation, this.now());
    const next = nextFireTime(schedule, anchor);
    if (next === null) {
      this.note(`automation ${automation.id} cron "${cron}" never matches a real date`);
      return null;
    }
    return {
      automationId: automation.id,
      agentId: automation.agentId,
      name: automation.name,
      cron,
      schedule,
      nextRunAt: next,
      lastRunAt: automation.lastRunAt === null ? null : new Date(automation.lastRunAt),
      primed: false,
      lastError: null,
    };
  }

  private view(automation: Automation): ScheduleJob {
    const job = this.jobs.get(automation.id);
    const runs = this.inFlight.get(automation.id);
    const nextRunAt = job?.nextRunAt ?? null;
    const overdueMs = nextRunAt === null ? null : Math.max(0, this.now().getTime() - nextRunAt.getTime());
    return {
      automationId: automation.id,
      agentId: automation.agentId,
      name: automation.name,
      trigger: automation.trigger,
      cron: automation.cron,
      enabled: automation.enabled,
      registered: job !== undefined,
      nextRunAt: nextRunAt === null ? null : nextRunAt.toISOString(),
      lastRunAt: automation.lastRunAt,
      running: (runs?.size ?? 0) > 0,
      overdueMs: overdueMs !== null && overdueMs > 0 ? overdueMs : null,
      note: job === undefined ? this.explain(automation) : null,
      lastError: job?.lastError ?? null,
    };
  }

  private explain(automation: Automation): string | null {
    if (!automation.enabled) return 'disabled: it will not fire until it is enabled again';
    if (automation.trigger === 'manual') return 'manual trigger: only automations.runNow fires it';
    if (automation.trigger === 'webhook') {
      return 'webhook trigger: fires on a POST carrying its secret, not on a clock';
    }
    return 'not registered: the cron expression could not be armed';
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private sessionFor(host: Host): Session {
    // `local` is honest: this is code running inside the host process, not a
    // client that reached it. It is not a way to widen authority, because the
    // scheduler only ever starts runs for automations the store already holds.
    this.session ??= host.createSession('local');
    return this.session;
  }

  private isRunning(automationId: string): boolean {
    return (this.inFlight.get(automationId)?.size ?? 0) > 0;
  }

  private track(automationId: string, runId: string, host: Host): void {
    if (this.releaseRuns === null) {
      this.releaseRuns = host.on('run.updated', ({ run }) => {
        if (!isTerminal(run.status)) return;
        for (const [id, runs] of this.inFlight) {
          if (!runs.delete(run.id)) continue;
          if (runs.size === 0) this.inFlight.delete(id);
        }
      });
    }
    const runs = this.inFlight.get(automationId) ?? new Set<string>();
    runs.add(runId);
    this.inFlight.set(automationId, runs);
  }

  private arm(): void {
    this.clearTimer();
    if (!this.running || this.disposed) return;

    const now = this.now().getTime();
    let delay = this.syncedOnce ? this.pollMs : 0;
    for (const job of this.jobs.values()) {
      if (job.nextRunAt === null) continue;
      delay = Math.min(delay, Math.max(0, job.nextRunAt.getTime() - now));
    }
    this.timer = this.timers.setTimeout(
      () => this.tick().then(() => undefined, () => undefined),
      delay,
    );
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private note(detail: string): void {
    this.log({ kind: 'unusable-automation', automationId: null, detail });
  }

  private recordError(error: unknown): void {
    const detail = truncate(errorText(error));
    this.lastError = detail;
    this.log({ kind: 'error', automationId: null, detail });
  }

  private log(event: SchedulerLogEvent): void {
    // A sink that throws must not take the scheduler down with it.
    try {
      this.logEvent(event);
    } catch {
      // Deliberately swallowed: diagnostics are never worth a missed fire.
    }
  }
}

/**
 * Where to search for the next occurrence.
 *
 * `last_run_at` is the durable record of the last fire, so it is the honest
 * anchor. `created_at` covers an automation that has never fired, and "now"
 * covers a row whose timestamps are missing or unparseable.
 */
function parseAnchor(automation: Automation, now: Date): Date {
  const candidate = automation.lastRunAt ?? automation.createdAt;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? now : parsed;
}

/** How many occurrences the schedule selects in (first, now], capped. */
function countOccurrences(schedule: CronSchedule, first: Date, now: Date): number {
  let count = 1;
  let cursor = first;
  while (count < MAX_COALESCE_COUNT) {
    const next = nextFireTime(schedule, cursor);
    if (next === null || next.getTime() > now.getTime()) break;
    cursor = next;
    count += 1;
  }
  return count;
}
