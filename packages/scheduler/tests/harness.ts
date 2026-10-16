import { Host } from '@guhbot/host-core';
import type { RunContext, RunExecutor, Session } from '@guhbot/host-core';
import { createSchedulerCapability, type Scheduler, type SchedulerCapability, type SchedulerLogEvent, type TimerScheduler } from '../src/index.js';

/**
 * Test harness.
 *
 * Time is injected everywhere: the fake clock is the only clock, and the fake
 * timer queue is the only place a tick can come from. Nothing here waits for a
 * real interval, which is the difference between a suite that runs in a second
 * and a suite nobody runs.
 */

export class FakeClock {
  private current: number;

  constructor(start: Date = new Date()) {
    this.current = start.getTime();
  }

  readonly now = (): Date => new Date(this.current);

  get time(): number {
    return this.current;
  }

  /** Move the clock without running anything. Tests then call tick() or runDue(). */
  advance(ms: number): Date {
    this.current += ms;
    return this.now();
  }

  set(at: Date): void {
    this.current = at.getTime();
  }
}

interface PendingTimer {
  at: number;
  callback: () => void | Promise<void>;
}

export class FakeTimers implements TimerScheduler {
  private nextHandle = 1;
  private readonly pending = new Map<number, PendingTimer>();

  constructor(private readonly clock: FakeClock) {}

  setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.pending.set(handle, { at: this.clock.time + Math.max(0, delayMs), callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.pending.delete(handle);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Delay until the earliest armed timer, or null when none is armed. */
  get nextDelayMs(): number | null {
    let earliest: number | null = null;
    for (const timer of this.pending.values()) {
      const delay = Math.max(0, timer.at - this.clock.time);
      if (earliest === null || delay < earliest) earliest = delay;
    }
    return earliest;
  }

  /** Run every timer that is already due, awaiting each callback and its re-arms. */
  async runDue(): Promise<number> {
    let ran = 0;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= this.clock.time)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) return ran;
      this.pending.delete(due[0]);
      await due[1].callback();
      ran += 1;
      // A scheduler that re-arms at zero delay forever would otherwise spin here
      // instead of failing the test.
      if (ran > 500) throw new Error('fake timers ran 500 due callbacks; a zero-delay re-arm is looping');
    }
  }
}

export interface MountOptions {
  dataDir: string;
  /** Called for every run the host starts. Throw to make a run fail. */
  execute?: (context: RunContext) => Promise<void> | void;
  /** False builds a host with no executor at all, which is a real misconfiguration. */
  withExecutor?: boolean;
  now?: () => Date;
  timers?: TimerScheduler;
  catchUp?: 'once' | 'skip';
  pollMs?: number;
  resolveAgentId?: () => string | null;
  log?: (event: SchedulerLogEvent) => void;
}

export interface Mounted {
  host: Host;
  capability: SchedulerCapability;
  scheduler: Scheduler;
  /** Every run context the executor saw, in order. */
  calls: RunContext[];
  logs: SchedulerLogEvent[];
}

/**
 * Build a real Host with the scheduler capability mounted, exactly the way the
 * application does it: the capability is created first and reaches the host
 * through a getter, because the host needs the capability's methods at
 * construction time.
 */
export function mountScheduler(options: MountOptions): Mounted {
  const calls: RunContext[] = [];
  const logs: SchedulerLogEvent[] = [];
  const executor: RunExecutor = {
    execute: async (context) => {
      calls.push(context);
      if (options.execute) await options.execute(context);
    },
  };

  const holder: { host: Host | null } = { host: null };
  const capability = createSchedulerCapability({
    host: () => {
      if (holder.host === null) throw new Error('the host has not been constructed yet');
      return holder.host;
    },
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.timers !== undefined ? { timers: options.timers } : {}),
    ...(options.catchUp !== undefined ? { catchUp: options.catchUp } : {}),
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    ...(options.resolveAgentId !== undefined ? { resolveAgentId: options.resolveAgentId } : {}),
    log: (event) => {
      logs.push(event);
      options.log?.(event);
    },
  });

  const host = new Host({
    dataDir: options.dataDir,
    version: '0.0.0-test',
    mode: 'self-hosted',
    ...(options.withExecutor === false ? {} : { executor }),
    extraMethods: capability.methods ?? {},
  });
  holder.host = host;

  return { host, capability, scheduler: capability.scheduler, calls, logs };
}

export function createDevice(host: Host, deviceClass: 'person' | 'background'): Session {
  const device = host.store.createDevice({
    name: `${deviceClass} device`,
    platform: 'ios',
    deviceClass,
    tokenSalt: Buffer.from('test-salt'),
    tokenHash: Buffer.from('test-hash'),
  });
  return host.createSession('network', device);
}

/** A ToolExecutionContext stand-in; the tools under test touch none of it. */
export function toolContext(cwd: string): { readSecret: () => null; cwd: string; signal: AbortSignal; note: () => void } {
  return { readSecret: () => null, cwd, signal: new AbortController().signal, note: () => undefined };
}

/** Let a run the scheduler started settle without waiting on a timer. */
export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
