import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertCapability, collectContributions } from '@guhbot/agent';
import type { ToolDefinition } from '@guhbot/agent';
import { createSchedulerCapability } from '../src/index.js';
import type { MountOptions, Mounted } from './harness.js';
import { FakeClock, FakeTimers, mountScheduler, toolContext } from './harness.js';

let dataDir: string;
let mounted: Mounted[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'guhbot-scheduler-cap-'));
});

afterEach(async () => {
  for (const item of mounted) await item.host.close();
  mounted = [];
  rmSync(dataDir, { recursive: true, force: true });
});

function boot(options: Omit<MountOptions, 'dataDir' | 'now' | 'timers'> = {}): Mounted {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const item = mountScheduler({ dataDir, now: clock.now, timers, ...options });
  mounted.push(item);
  return item;
}

function toolOf(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
}

function json<T>(text: string): T {
  return JSON.parse(text) as T;
}

describe('capability surface', () => {
  it('satisfies the capability contract and declares the scheduler flag', () => {
    const { capability } = boot();
    expect(() => assertCapability(capability)).not.toThrow();
    expect(capability.name).toBe('scheduler');
    expect(capability.flags).toEqual({ scheduler: true });
    expect(capability.summary.length).toBeGreaterThan(10);
    expect(typeof capability.dispose).toBe('function');
  });

  it('contributes three tools and four methods through the collection seam', () => {
    const { capability } = boot();
    const { tools, extraMethods, flags } = collectContributions([capability]);

    expect(tools.map((tool) => tool.name).sort()).toEqual(['schedule_create', 'schedule_delete', 'schedule_list']);
    expect(Object.keys(extraMethods).sort()).toEqual([
      'automations.webhook',
      'automations.webhookFire',
      'automations.webhookRevoke',
      'scheduler.status',
    ]);
    expect(flags).toEqual({ scheduler: true });
  });

  it('states requiresApproval explicitly on every tool, with the intended value', () => {
    const { capability } = boot();
    const tools = capability.tools?.() ?? [];
    const expectations: Record<string, boolean> = {
      schedule_create: true,
      schedule_list: false,
      schedule_delete: true,
    };
    for (const tool of tools) {
      expect(Object.hasOwn(tool, 'requiresApproval')).toBe(true);
      expect(tool.requiresApproval).toBe(expectations[tool.name]);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('can be prepared before the host exists, because the first tick is deferred', async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const capability = createSchedulerCapability({
      host: () => {
        throw new Error('the host is not wired yet');
      },
      now: clock.now,
      timers,
    });

    await expect(capability.ready?.()).resolves.toBeUndefined();
    expect(capability.scheduler.status).toBeTypeOf('function');
    await expect(capability.dispose?.()).resolves.toBeUndefined();
    expect(capability.scheduler.isDisposed).toBe(true);
  });

  it('backs off instead of spinning while the host is not reachable', async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const events: string[] = [];
    const capability = createSchedulerCapability({
      host: () => {
        throw new Error('the host is not wired yet');
      },
      now: clock.now,
      timers,
      pollMs: 1000,
      log: (event) => events.push(event.kind),
    });

    capability.scheduler.start();
    await capability.scheduler.tick();

    // A zero-delay re-arm here would be a busy loop on a host that has not
    // finished wiring; the retry has to wait a poll.
    expect(timers.nextDelayMs).toBe(1000);
    expect(events).toContain('error');
    await capability.dispose();
  });

  it('arms and clears a real timer when no timer seam is injected', async () => {
    // The only test that touches the production timer adapter. It must not
    // leave anything armed: dispose() runs synchronously, so the zero-delay
    // first tick is cancelled before the event loop ever reaches it.
    const item = mountScheduler({ dataDir });
    mounted.push(item);

    item.scheduler.start();
    expect(item.scheduler.status().running).toBe(true);
    await item.scheduler.dispose();
    expect(item.scheduler.isDisposed).toBe(true);
  });

  it('starts ticking on ready() and stops on dispose()', async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const capability = createSchedulerCapability({
      host: () => {
        throw new Error('unused');
      },
      now: clock.now,
      timers,
    });

    await capability.ready?.();
    expect(timers.size).toBe(1);
    await capability.dispose?.();
    expect(timers.size).toBe(0);
    await capability.dispose?.();
    expect(timers.size).toBe(0);
  });
});

describe('schedule tools', () => {
  it('creates a schedule for the only agent and reports its next fire time', async () => {
    const { host, capability, scheduler } = boot();
    const agent = host.store.createAgent({ name: 'ops' });
    const tools = capability.tools?.() ?? [];

    const created = json<{ created: { automationId: string; nextRunAt: string | null; registered: boolean } }>(
      await toolOf(tools, 'schedule_create').execute(
        { name: 'morning triage', cron: '0 8 * * 1-5', prompt: 'triage my inbox' },
        toolContext(dataDir),
      ),
    );

    expect(created.created.registered).toBe(true);
    expect(created.created.nextRunAt).not.toBeNull();

    const row = host.store.getAutomation(created.created.automationId);
    expect(row?.agentId).toBe(agent.id);
    expect(row?.trigger).toBe('schedule');
    expect(row?.cron).toBe('0 8 * * 1-5');
    expect(row?.prompt).toBe('triage my inbox');
    // host-core's Store has no setter for next_run_at, so the row keeps null and
    // the scheduler is the only place the next fire is known. This test exists
    // to make that gap visible rather than surprising.
    expect(row?.nextRunAt).toBeNull();
    expect(scheduler.nextFireAt(created.created.automationId)).not.toBeNull();
  });

  it('refuses an invalid cron with the parser message', async () => {
    const { host, capability } = boot();
    host.store.createAgent({ name: 'ops' });
    const tools = capability.tools?.() ?? [];

    await expect(
      toolOf(tools, 'schedule_create').execute(
        { name: 'bad', cron: '60 * * * *', prompt: 'x' },
        toolContext(dataDir),
      ),
    ).rejects.toThrow(/out of range 0-59/);
    await expect(
      toolOf(tools, 'schedule_create').execute(
        { name: 'bad', cron: '0 0 30 2 *', prompt: 'x' },
        toolContext(dataDir),
      ),
    ).rejects.toThrow(/never matches a real date/);
    await expect(
      toolOf(tools, 'schedule_create').execute({ name: 'bad', cron: '* * * * *' }, toolContext(dataDir)),
    ).rejects.toThrow(/"prompt" is required/);
    expect(host.store.listAutomations()).toHaveLength(0);
  });

  it('refuses to guess the agent when the host has several', async () => {
    const { host, capability } = boot();
    const first = host.store.createAgent({ name: 'one' });
    host.store.createAgent({ name: 'two' });
    const tools = capability.tools?.() ?? [];

    await expect(
      toolOf(tools, 'schedule_create').execute(
        { name: 'ambiguous', cron: '0 8 * * *', prompt: 'x' },
        toolContext(dataDir),
      ),
    ).rejects.toThrow(/ambiguous/);

    const created = json<{ created: { automationId: string } }>(
      await toolOf(tools, 'schedule_create').execute(
        { name: 'explicit', cron: '0 8 * * *', prompt: 'x', agentId: first.id },
        toolContext(dataDir),
      ),
    );
    expect(host.store.getAutomation(created.created.automationId)?.agentId).toBe(first.id);

    await expect(
      toolOf(tools, 'schedule_create').execute(
        { name: 'ghost', cron: '0 8 * * *', prompt: 'x', agentId: 'ag_missing' },
        toolContext(dataDir),
      ),
    ).rejects.toThrow(/no agent ag_missing/);
  });

  it('honours a host that pinned the agent the tools speak for', async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const holder: { id: string | null } = { id: null };
    const item = mountScheduler({
      dataDir,
      now: clock.now,
      timers,
      resolveAgentId: () => holder.id,
    });
    mounted.push(item);

    const bound = item.host.store.createAgent({ name: 'bound' });
    const other = item.host.store.createAgent({ name: 'other' });
    holder.id = bound.id;
    const tools = item.capability.tools?.() ?? [];

    await expect(
      toolOf(tools, 'schedule_create').execute(
        { name: 'not mine', cron: '0 8 * * *', prompt: 'x', agentId: other.id },
        toolContext(dataDir),
      ),
    ).rejects.toThrow(/bound to agent/);

    const created = json<{ created: { automationId: string } }>(
      await toolOf(tools, 'schedule_create').execute(
        { name: 'mine', cron: '0 8 * * *', prompt: 'x' },
        toolContext(dataDir),
      ),
    );
    expect(item.host.store.getAutomation(created.created.automationId)?.agentId).toBe(bound.id);

    // A delete aimed at another agent's automation is refused too.
    const foreign = item.host.store.createAutomation({
      agentId: other.id,
      name: 'foreign',
      trigger: 'schedule',
      cron: '0 9 * * *',
      prompt: 'x',
    });
    await expect(
      toolOf(tools, 'schedule_delete').execute({ automationId: foreign.id }, toolContext(dataDir)),
    ).rejects.toThrow(/belongs to agent/);
  });

  it('lists schedules with their cron, next fire and why they are not armed', async () => {
    const { host, capability } = boot();
    const agent = host.store.createAgent({ name: 'ops' });
    const tools = capability.tools?.() ?? [];
    await toolOf(tools, 'schedule_create').execute(
      { name: 'listed', cron: '*/15 * * * *', prompt: 'x' },
      toolContext(dataDir),
    );
    host.store.createAutomation({
      agentId: agent.id,
      name: 'hooked',
      trigger: 'webhook',
      cron: null,
      prompt: 'x',
    });

    const listed = json<{ timeZone: string; schedules: Array<{ name: string; nextRunAt: string | null; note: string | null }> }>(
      await toolOf(tools, 'schedule_list').execute({}, toolContext(dataDir)),
    );

    expect(listed.timeZone.length).toBeGreaterThan(0);
    expect(listed.schedules).toHaveLength(2);
    const scheduled = listed.schedules.find((entry) => entry.name === 'listed');
    expect(scheduled?.nextRunAt).not.toBeNull();
    expect(scheduled?.note).toBeNull();
    expect(listed.schedules.find((entry) => entry.name === 'hooked')?.note).toContain('webhook');
  });

  it('stops a schedule by name or id without deleting the row', async () => {
    const { host, capability, scheduler } = boot();
    host.store.createAgent({ name: 'ops' });
    const tools = capability.tools?.() ?? [];
    const created = json<{ created: { automationId: string } }>(
      await toolOf(tools, 'schedule_create').execute(
        { name: 'stoppable', cron: '* * * * *', prompt: 'x' },
        toolContext(dataDir),
      ),
    );

    const stopped = json<{ stopped: boolean; automationId: string; note: string }>(
      await toolOf(tools, 'schedule_delete').execute({ name: 'stoppable' }, toolContext(dataDir)),
    );
    expect(stopped.stopped).toBe(true);
    expect(stopped.automationId).toBe(created.created.automationId);
    expect(stopped.note).toContain('not deleted');
    expect(scheduler.nextFireAt(created.created.automationId)).toBeNull();

    // The row survives, disabled, and nothing will fire it again.
    const row = host.store.getAutomation(created.created.automationId);
    expect(row).not.toBeNull();
    expect(row?.enabled).toBe(false);

    await expect(
      toolOf(tools, 'schedule_delete').execute({}, toolContext(dataDir)),
    ).rejects.toThrow(/pass automationId or name/);
    await expect(
      toolOf(tools, 'schedule_delete').execute({ name: 'nothing by that name' }, toolContext(dataDir)),
    ).rejects.toThrow(/no automation named/);
    await expect(
      toolOf(tools, 'schedule_delete').execute({ automationId: 'au_missing' }, toolContext(dataDir)),
    ).rejects.toThrow(/no automation au_missing/);
  });

  it('asks for the id when two schedules share a name', async () => {
    const { host, capability } = boot();
    host.store.createAgent({ name: 'ops' });
    const tools = capability.tools?.() ?? [];
    for (const cron of ['0 8 * * *', '0 9 * * *']) {
      await toolOf(tools, 'schedule_create').execute({ name: 'twins', cron, prompt: 'x' }, toolContext(dataDir));
    }
    await expect(
      toolOf(tools, 'schedule_delete').execute({ name: 'twins' }, toolContext(dataDir)),
    ).rejects.toThrow(/pass automationId to choose one/);
  });

  it('disables a schedule end to end: no run after the delete', async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const item = mountScheduler({ dataDir, now: clock.now, timers });
    mounted.push(item);
    item.host.store.createAgent({ name: 'ops' });
    const tools = item.capability.tools?.() ?? [];

    const created = json<{ created: { automationId: string } }>(
      await toolOf(tools, 'schedule_create').execute(
        { name: 'fires once', cron: '0 * * * *', prompt: 'hourly' },
        toolContext(dataDir),
      ),
    );
    item.scheduler.start();
    await item.scheduler.tick();
    clock.advance(3_600_000 + 60_000);
    await item.scheduler.tick();
    expect(item.calls).toHaveLength(1);

    await toolOf(tools, 'schedule_delete').execute(
      { automationId: created.created.automationId },
      toolContext(dataDir),
    );

    clock.advance(24 * 3_600_000);
    await item.scheduler.tick();
    expect(item.calls).toHaveLength(1);
    expect(item.host.store.getAutomation(created.created.automationId)?.enabled).toBe(false);
  });
});
