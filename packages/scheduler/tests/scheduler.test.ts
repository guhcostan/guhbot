import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MountOptions, Mounted } from './harness.js';
import { FakeClock, FakeTimers, flush, mountScheduler } from './harness.js';

/**
 * Scheduler behaviour, driven entirely by an injected clock and an injected
 * timer queue. No test here waits for a real interval: a suite that sleeps for a
 * minute to observe a cron tick is a suite that stops being run.
 */

let dataDir: string;
let mounted: Mounted[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'guhbot-scheduler-'));
});

afterEach(async () => {
  for (const item of mounted) await item.host.close();
  mounted = [];
  rmSync(dataDir, { recursive: true, force: true });
});

function boot(options: Omit<MountOptions, 'dataDir'> = {}): Mounted {
  const item = mountScheduler({ dataDir, ...options });
  mounted.push(item);
  return item;
}

interface Rig {
  clock: FakeClock;
  timers: FakeTimers;
  mounted: Mounted;
}

function rig(options: Omit<MountOptions, 'dataDir' | 'now' | 'timers'> = {}): Rig {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  return { clock, timers, mounted: boot({ now: clock.now, timers, ...options }) };
}

describe('scheduled automations', () => {
  it('fires at the computed instant with the automation prompt', async () => {
    const { clock, timers, mounted: test } = rig();
    const agent = test.host.store.createAgent({ name: 'ops' });
    const automation = test.host.store.createAutomation({
      agentId: agent.id,
      name: 'every minute',
      trigger: 'schedule',
      cron: '* * * * *',
      prompt: 'tick tock',
    });

    test.scheduler.start();
    await test.scheduler.tick();
    expect(test.calls).toHaveLength(0);

    const nextIso = test.scheduler.nextFireAt(automation.id);
    expect(nextIso).not.toBeNull();
    const target = new Date(nextIso!);
    expect(target.getTime()).toBeGreaterThan(clock.time);

    // A second before the occurrence, nothing has fired.
    clock.set(new Date(target.getTime() - 1000));
    await timers.runDue();
    expect(test.calls).toHaveLength(0);

    clock.set(target);
    await timers.runDue();

    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]!.prompt).toBe('tick tock');
    expect(test.calls[0]!.agent.id).toBe(agent.id);

    const runs = test.host.store.listRuns({ agentId: agent.id, limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.promptEntryId).not.toBeNull();
    expect(
      test.host.store.listRecentEntries(agent.id, 10).some((entry) => entry.content === 'tick tock'),
    ).toBe(true);

    // And it fires again at the next occurrence rather than once and stopping.
    clock.advance(60_000);
    await test.scheduler.tick();
    expect(test.calls).toHaveLength(2);
  });

  it('picks up an automation created by another client on the next tick', async () => {
    const { mounted: test } = rig();
    const agent = test.host.store.createAgent({ name: 'ops' });

    test.scheduler.start();
    await test.scheduler.tick();

    // This is what host-core's `automations.create` writes; nothing tells the
    // scheduler about it, so the re-read is the only way it is ever noticed.
    const automation = test.host.store.createAutomation({
      agentId: agent.id,
      name: 'later',
      trigger: 'schedule',
      cron: '0 8 * * *',
      prompt: 'morning',
    });
    expect(test.scheduler.nextFireAt(automation.id)).toBeNull();

    await test.scheduler.tick();
    expect(test.scheduler.nextFireAt(automation.id)).not.toBeNull();
  });

  it('does not register a webhook or manual automation on a clock', async () => {
    const { mounted: test } = rig();
    const agent = test.host.store.createAgent({ name: 'ops' });
    test.host.store.createAutomation({
      agentId: agent.id,
      name: 'hooked',
      trigger: 'webhook',
      cron: null,
      prompt: 'from the outside',
    });
    test.host.store.createAutomation({
      agentId: agent.id,
      name: 'by hand',
      trigger: 'manual',
      cron: '0 0 * * *',
      prompt: 'only when asked',
    });

    test.scheduler.start();
    await test.scheduler.tick();

    const jobs = test.scheduler.status().jobs;
    expect(jobs.every((job) => !job.registered)).toBe(true);
    expect(jobs.find((job) => job.name === 'hooked')?.note).toContain('webhook');
    expect(jobs.find((job) => job.name === 'by hand')?.note).toContain('manual');
  });

  it('drops an automation that is disabled and registers it again when re-enabled', async () => {
    const { mounted: test } = rig();
    const agent = test.host.store.createAgent({ name: 'ops' });
    const automation = test.host.store.createAutomation({
      agentId: agent.id,
      name: 'pausable',
      trigger: 'schedule',
      cron: '0 * * * *',
      prompt: 'hourly',
    });

    test.scheduler.start();
    await test.scheduler.tick();
    expect(test.scheduler.nextFireAt(automation.id)).not.toBeNull();

    test.host.store.setAutomationEnabled(automation.id, false);
    await test.scheduler.tick();
    expect(test.scheduler.nextFireAt(automation.id)).toBeNull();
    expect(test.scheduler.status().jobs.find((job) => job.automationId === automation.id)?.enabled).toBe(false);

    test.host.store.setAutomationEnabled(automation.id, true);
    await test.scheduler.tick();
    expect(test.scheduler.nextFireAt(automation.id)).not.toBeNull();
  });

  it('ignores an unknown or malformed cron expression instead of crashing', async () => {
    const { mounted: test } = rig();
    const agent = test.host.store.createAgent({ name: 'ops' });
    const automation = test.host.store.createAutomation({
      agentId: agent.id,
      name: 'garbage',
      trigger: 'schedule',
      cron: 'not a cron',
      prompt: 'never',
    });

    test.scheduler.start();
    await test.scheduler.tick();

    expect(test.scheduler.nextFireAt(automation.id)).toBeNull();
    const job = test.scheduler.status().jobs.find((entry) => entry.automationId === automation.id);
    expect(job?.registered).toBe(false);
    expect(job?.note).toBe('not registered: the cron expression could not be armed');
    expect(test.logs.some((event) => event.kind === 'unusable-automation')).toBe(true);
  });
});

describe('catch-up after downtime', () => {
  it('fires once after three days, not seventy-two times', async () => {
    const { clock, mounted: test } = rig();
    const agent = test.host.store.createAgent({ name: 'ops' });
    const automation = test.host.store.createAutomation({
      agentId: agent.id,
      name: 'hourly',
      trigger: 'schedule',
      cron: '0 * * * *',
      prompt: 'hourly work',
    });

    test.scheduler.start();
    await test.scheduler.tick();
    expect(test.calls).toHaveLength(0);

    // The host was off for three days: 72 hourly occurrences were missed.
    clock.advance(72 * 3_600_000);
    await test.scheduler.tick();

    expect(test.calls).toHaveLength(1);
    const status = test.scheduler.status();
    expect(status.fires).toBe(1);
    expect(status.skipped).toBe(71);

    // The coalesced occurrence is not retried at the same instant...
    await test.scheduler.tick();
    expect(test.calls).toHaveLength(1);
    // ...and the schedule keeps running normally afterwards.
    clock.advance(3_600_000);
    await test.scheduler.tick();
    expect(test.calls).toHaveLength(2);
    expect(new Date(test.scheduler.nextFireAt(automation.id)!).getTime()).toBeGreaterThan(clock.time);
  });

  it('drops the missed occurrence entirely under the skip policy', async () => {
    // The clock starts three days after the automation was created, which is
    // what the world looks like the moment a host boots again. Under `skip` the
    // overdue occurrence is dropped instead of run late.
    const clock = new FakeClock(new Date(Date.now() + 72 * 3_600_000));
    const timers = new FakeTimers(clock);
    const test = boot({ now: clock.now, timers, catchUp: 'skip' });
    const agent = test.host.store.createAgent({ name: 'ops' });
    const automation = test.host.store.createAutomation({
      agentId: agent.id,
      name: 'hourly',
      trigger: 'schedule',
      cron: '0 * * * *',
      prompt: 'hourly work',
    });

    test.scheduler.start();
    await test.scheduler.tick();

    expect(test.calls).toHaveLength(0);
    const status = test.scheduler.status();
    expect(status.fires).toBe(0);
    expect(status.skipped).toBeGreaterThanOrEqual(60);
    expect(status.jobs.find((job) => job.automationId === automation.id)?.registered).toBe(true);
    expect(new Date(test.scheduler.nextFireAt(automation.id)!).getTime()).toBeGreaterThan(clock.time);

    clock.advance(3_600_000);
    await test.scheduler.tick();
    expect(test.calls).toHaveLength(1);
  });

  it('fires the missed occurrence under the default policy in the same setup', async () => {
    const clock = new FakeClock(new Date(Date.now() + 72 * 3_600_000));
    const timers = new FakeTimers(clock);
    const test = boot({ now: clock.now, timers });
    const agent = test.host.store.createAgent({ name: 'ops' });
    test.host.store.createAutomation({
      agentId: agent.id,
      name: 'hourly',
      trigger: 'schedule',
      cron: '0 * * * *',
      prompt: 'hourly work',
    });

    test.scheduler.start();
    await test.scheduler.tick();

    expect(test.calls).toHaveLength(1);
    expect(test.scheduler.status().fires).toBe(1);
  });

  it('anchors the next fire on the durable last_run_at rather than on boot time', async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const test = boot({ now: clock.now, timers });
    const agent = test.host.store.createAgent({ name: 'ops' });
    const automation = test.host.store.createAutomation({
      agentId: agent.id,
      name: 'daily',
      trigger: 'schedule',
      cron: '0 8 * * *',
      prompt: 'daily',
    });

    // A previous process ran it: last_run_at is the only durable record of that.
    test.host.store.markAutomationRun(automation.id);
    test.scheduler.start();
    await test.scheduler.tick();

    const anchor = new Date(test.host.store.getAutomation(automation.id)!.lastRunAt!);
    const expected = new Date(anchor);
    expected.setHours(8, 0, 0, 0);
    if (expected.getTime() <= anchor.getTime()) expected.setDate(expected.getDate() + 1);
    expect(new Date(test.scheduler.nextFireAt(automation.id)!).getTime()).toBe(expected.getTime());
    expect(new Date(test.scheduler.nextFireAt(automation.id)!).getTime()).toBeGreaterThan(anchor.getTime());
  });
});

describe('one run at a time', () => {
  it('skips the next occurrence while the previous run is still going', async () => {
    // Only the first run is held open. Once it is released the schedule has to
    // pick up again, which proves the skip was a skip and not the scheduler
    // wedging itself shut.
    let held = 1;
    const pending: Array<() => void> = [];
    const { clock, mounted: test } = rig({
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
    const agent = test.host.store.createAgent({ name: 'ops' });
    const automation = test.host.store.createAutomation({
      agentId: agent.id,
      name: 'slow',
      trigger: 'schedule',
      cron: '0 * * * *',
      prompt: 'long job',
    });

    test.scheduler.start();
    await test.scheduler.tick();
    clock.advance(3_600_000 + 60_000);
    await test.scheduler.tick();
    expect(test.calls).toHaveLength(1);

    const running = test.scheduler.status().jobs.find((job) => job.automationId === automation.id);
    expect(running?.running).toBe(true);

    clock.advance(3_600_000);
    await test.scheduler.tick();

    expect(test.calls).toHaveLength(1);
    expect(test.scheduler.status().skipped).toBeGreaterThanOrEqual(1);
    expect(
      test.logs.some((event) => event.kind === 'skipped' && (event.detail ?? '').includes('still going')),
    ).toBe(true);

    // Let the run finish: the automation must fire again rather than stay
    // blocked forever on a run that is no longer going.
    pending.shift()?.();
    await flush();
    clock.advance(3_600_000);
    await test.scheduler.tick();
    expect(test.calls).toHaveLength(2);
  });
});

describe('failing fires', () => {
  it('reports a host that cannot start a run and keeps waiting', async () => {
    const { clock, timers, mounted: test } = rig({ withExecutor: false });
    const agent = test.host.store.createAgent({ name: 'ops' });
    const automation = test.host.store.createAutomation({
      agentId: agent.id,
      name: 'orphan',
      trigger: 'schedule',
      cron: '* * * * *',
      prompt: 'never runs',
    });

    test.scheduler.start();
    await test.scheduler.tick();
    const target = new Date(test.scheduler.nextFireAt(automation.id)!);
    clock.set(target);
    await timers.runDue();

    expect(test.calls).toHaveLength(0);
    const status = test.scheduler.status();
    expect(status.fires).toBe(0);
    expect(status.lastError).toContain('no model provider configured');
    // The next fire moved on, so the tick is not a spin loop.
    expect(new Date(test.scheduler.nextFireAt(automation.id)!).getTime()).toBeGreaterThan(clock.time);
    expect(timers.nextDelayMs).toBeGreaterThan(0);
  });

  it('fires both automations when one of them fails', async () => {
    const { clock, timers, mounted: test } = rig({
      execute: async (context) => {
        if (context.prompt === 'bad') throw new Error('executor exploded');
      },
    });
    const agent = test.host.store.createAgent({ name: 'ops' });
    const good = test.host.store.createAutomation({
      agentId: agent.id,
      name: 'good',
      trigger: 'schedule',
      cron: '* * * * *',
      prompt: 'good',
    });
    const bad = test.host.store.createAutomation({
      agentId: agent.id,
      name: 'bad',
      trigger: 'schedule',
      cron: '* * * * *',
      prompt: 'bad',
    });

    test.scheduler.start();
    await test.scheduler.tick();

    const first = test.scheduler.nextFireAt(good.id);
    const second = test.scheduler.nextFireAt(bad.id);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    clock.set(new Date(Math.max(Date.parse(first!), Date.parse(second!))));
    await timers.runDue();

    expect(test.calls.map((call) => call.prompt).sort()).toEqual(['bad', 'good']);
    await flush();

    const statusOf = (prompt: string): string | undefined => {
      const call = test.calls.find((entry) => entry.prompt === prompt);
      return call === undefined ? undefined : test.host.store.getRun(call.run.id)?.status;
    };
    expect(statusOf('good')).toBe('succeeded');
    expect(statusOf('bad')).toBe('failed');
    expect(test.host.store.listRuns({ agentId: agent.id, limit: 10 })).toHaveLength(2);
  });
});

describe('dispose', () => {
  it('stops the timer and refuses to fire afterwards', async () => {
    const { clock, timers, mounted: test } = rig();
    const agent = test.host.store.createAgent({ name: 'ops' });
    test.host.store.createAutomation({
      agentId: agent.id,
      name: 'every minute',
      trigger: 'schedule',
      cron: '* * * * *',
      prompt: 'tick',
    });

    test.scheduler.start();
    await test.scheduler.tick();
    expect(timers.size).toBeGreaterThan(0);

    await test.scheduler.dispose();
    expect(test.scheduler.isDisposed).toBe(true);
    expect(timers.size).toBe(0);

    clock.advance(3 * 24 * 3_600_000);
    expect(await timers.runDue()).toBe(0);
    expect(test.calls).toHaveLength(0);
    expect((await test.scheduler.tick()).fires).toBe(0);

    // Idempotent, and it does not come back to life.
    await test.scheduler.dispose();
    expect(timers.size).toBe(0);
    expect(() => test.scheduler.start()).toThrow(/disposed/);
  });

  it('drops in-memory job state so nothing is left armed', async () => {
    const { mounted: test } = rig();
    const agent = test.host.store.createAgent({ name: 'ops' });
    test.host.store.createAutomation({
      agentId: agent.id,
      name: 'every minute',
      trigger: 'schedule',
      cron: '* * * * *',
      prompt: 'tick',
    });

    test.scheduler.start();
    await test.scheduler.tick();
    await test.scheduler.dispose();
    expect(test.scheduler.status().jobs.every((job) => !job.registered)).toBe(true);
  });

  it('stop() halts ticking without disposing', async () => {
    const { clock, timers, mounted: test } = rig();
    const agent = test.host.store.createAgent({ name: 'ops' });
    test.host.store.createAutomation({
      agentId: agent.id,
      name: 'every minute',
      trigger: 'schedule',
      cron: '* * * * *',
      prompt: 'tick',
    });

    test.scheduler.start();
    await test.scheduler.tick();
    test.scheduler.stop();
    expect(timers.size).toBe(0);
    clock.advance(24 * 3_600_000);
    expect(await timers.runDue()).toBe(0);
    expect(test.calls).toHaveLength(0);
    expect(test.scheduler.isDisposed).toBe(false);
  });
});

describe('creating and stopping a schedule in the scheduler itself', () => {
  it('refuses an unusable cron and an impossible one at creation time', () => {
    const { mounted: test } = rig();
    const agent = test.host.store.createAgent({ name: 'ops' });
    expect(() =>
      test.scheduler.createSchedule({ agentId: agent.id, name: 'bad', cron: '60 * * * *', prompt: 'x' }),
    ).toThrow(/out of range 0-59/);
    expect(() =>
      test.scheduler.createSchedule({ agentId: agent.id, name: 'never', cron: '0 0 30 2 *', prompt: 'x' }),
    ).toThrow(/never matches a real date/);
    expect(() =>
      test.scheduler.createSchedule({ agentId: 'ag_missing', name: 'ghost', cron: '0 0 * * *', prompt: 'x' }),
    ).toThrow(/no agent ag_missing/);
    expect(test.host.store.listAutomations()).toHaveLength(0);
  });

  it('stops a schedule from firing again and revokes its webhook secret', async () => {
    const { clock, mounted: test } = rig();
    const agent = test.host.store.createAgent({ name: 'ops' });
    const created = test.scheduler.createSchedule({
      agentId: agent.id,
      name: 'created in process',
      cron: '0 * * * *',
      prompt: 'hourly',
    });
    expect(created.registered).toBe(true);
    expect(created.nextRunAt).not.toBeNull();

    const webhook = test.host.store.createAutomation({
      agentId: agent.id,
      name: 'hooked',
      trigger: 'webhook',
      cron: null,
      prompt: 'from outside',
    });
    test.scheduler.secrets().mint(test.host, webhook.id);
    expect(test.scheduler.secrets().read(test.host, webhook.id)).not.toBeNull();

    test.scheduler.start();
    await test.scheduler.tick();
    clock.advance(3_600_000 + 60_000);
    await test.scheduler.tick();
    expect(test.calls).toHaveLength(1);

    const stopped = test.scheduler.disableSchedule(created.automationId);
    expect(stopped.disabled).toBe(true);
    expect(stopped.schedule?.enabled).toBe(false);
    expect(stopped.schedule?.registered).toBe(false);

    // The row survives, which is why the tool that calls this says "stopped",
    // not "deleted".
    expect(test.host.store.getAutomation(created.automationId)).not.toBeNull();

    clock.advance(24 * 3_600_000);
    await test.scheduler.tick();
    expect(test.calls).toHaveLength(1);

    const revoked = test.scheduler.disableSchedule(webhook.id);
    expect(revoked.secretRevoked).toBe(true);
    expect(test.scheduler.secrets().read(test.host, webhook.id)).toBeNull();
    expect(() => test.scheduler.disableSchedule('au_missing')).toThrow(/no automation/);
  });
});
