import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunContext } from '@guhbot/host-core';
import type { MemoryCapability } from '../src/index.js';
import { deviceSession, mountMemory, toolNamed } from './harness.js';

/**
 * The boundary that only a real host can test: which device may call which
 * method, and what a serialized response is allowed to contain.
 */

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guhbot-memory-host-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Listed {
  memories: { id: string; text: string; agentId: string }[];
  nextCursor: string | null;
}

describe('memory methods over the RPC dispatcher', () => {
  it('lets a background device list one agent\'s facts and nothing else', async () => {
    const { host, capability } = mountMemory({ dataDir: freshDir() });
    const alpha = host.store.createAgent({ name: 'Alpha' });
    const beta = host.store.createAgent({ name: 'Beta' });
    capability.store.remember(alpha.id, { text: 'alpha signs annual contracts', source: 'user' });
    capability.store.remember(beta.id, { text: 'beta kubernetes cluster is in frankfurt', source: 'agent' });

    const device = deviceSession(host, 'background');
    const listed = (await host.dispatch(device, 'memory.list', { agentId: alpha.id })) as Listed;

    expect(listed.memories).toHaveLength(1);
    expect(listed.memories[0]?.agentId).toBe(alpha.id);
    expect(listed.nextCursor).toBeNull();
    const serialized = JSON.stringify(listed);
    expect(serialized).toContain('alpha signs annual contracts');
    expect(serialized).not.toContain('frankfurt');
    expect(serialized).not.toContain(beta.id);
  });

  it('refuses memory.forget on a background device and keeps the fact', async () => {
    const { host, capability } = mountMemory({ dataDir: freshDir() });
    const alpha = host.store.createAgent({ name: 'Alpha' });
    const stored = capability.store.remember(alpha.id, { text: 'alpha signs annual contracts', source: 'user' });
    const device = deviceSession(host, 'background');

    await expect(
      host.dispatch(device, 'memory.forget', { agentId: alpha.id, memoryId: stored.memory.id }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const listed = (await host.dispatch(device, 'memory.list', { agentId: alpha.id })) as Listed;
    expect(listed.memories).toHaveLength(1);
  });

  it('lets a person-class device forget a fact', async () => {
    const { host, capability } = mountMemory({ dataDir: freshDir() });
    const alpha = host.store.createAgent({ name: 'Alpha' });
    const stored = capability.store.remember(alpha.id, { text: 'alpha signs annual contracts', source: 'user' });
    const device = deviceSession(host, 'person');

    const result = (await host.dispatch(device, 'memory.forget', {
      agentId: alpha.id,
      memoryId: stored.memory.id,
    })) as { forgotten: boolean };

    expect(result).toEqual({ forgotten: true });
    expect(capability.counts().memories).toBe(0);
  });

  it('will not forget another agent\'s fact even with human presence', async () => {
    const { host, capability } = mountMemory({ dataDir: freshDir() });
    const alpha = host.store.createAgent({ name: 'Alpha' });
    const beta = host.store.createAgent({ name: 'Beta' });
    const theirs = capability.store.remember(beta.id, { text: 'beta kubernetes cluster', source: 'agent' });
    const device = deviceSession(host, 'person');

    const result = (await host.dispatch(device, 'memory.forget', {
      agentId: alpha.id,
      memoryId: theirs.memory.id,
    })) as { forgotten: boolean };

    expect(result.forgotten).toBe(false);
    expect(capability.store.list(beta.id, { limit: 10 }).memories).toHaveLength(1);
  });

  it('answers memory.status on a background device with counts and no text', async () => {
    const { host, capability } = mountMemory({ dataDir: freshDir(), maxMemoriesPerAgent: 7 });
    const alpha = host.store.createAgent({ name: 'Alpha' });
    capability.store.remember(alpha.id, { text: 'alpha signs annual contracts', source: 'user' });

    const status = (await host.dispatch(deviceSession(host, 'background'), 'memory.status', {})) as Record<
      string,
      unknown
    >;

    expect(status['agents']).toBe(1);
    expect(status['memories']).toBe(1);
    expect(status['bytes']).toBeGreaterThan(0);
    expect(status['caps']).toEqual({ maxMemoriesPerAgent: 7, maxBytesPerAgent: 65_536, maxTextChars: 2_000 });
    expect(JSON.stringify(status)).not.toContain('annual');
  });

  it('reports an unknown agent as not-found rather than an empty page', async () => {
    const { host } = mountMemory({ dataDir: freshDir() });

    await expect(host.dispatch(deviceSession(host, 'background'), 'memory.list', { agentId: 'ag_missing' })).rejects.toMatchObject(
      { code: 'not-found' },
    );
  });

  it('registers the three methods with honest authorization classes', async () => {
    const { host } = mountMemory({ dataDir: freshDir() });
    const described = (await host.dispatch(host.createSession('local'), 'host.describe', {})) as {
      methods: { name: string; authz: string; summary: string }[];
    };
    const classes = Object.fromEntries(described.methods.map((entry) => [entry.name, entry.authz]));

    expect(classes['memory.list']).toBe('background');
    expect(classes['memory.forget']).toBe('person');
    expect(classes['memory.status']).toBe('background');
    expect(host.status().capabilities['memory']).toBe(true);
  });

  it('rejects parameters that do not match the method schema', async () => {
    const { host } = mountMemory({ dataDir: freshDir() });
    const device = deviceSession(host, 'background');

    await expect(host.dispatch(device, 'memory.list', { limit: 5_000 })).rejects.toMatchObject({ code: 'bad-request' });
    await expect(host.dispatch(device, 'memory.list', {})).rejects.toMatchObject({ code: 'bad-request' });
  });
});

describe('memory and the agent lifecycle', () => {
  it('stores memory under its own meta key, not in secrets and not in the transcript', async () => {
    const { host, capability } = mountMemory({ dataDir: freshDir() });
    const alpha = host.store.createAgent({ name: 'Alpha' });
    const stored = capability.store.remember(alpha.id, { text: 'alpha signs annual contracts', source: 'user' });

    // The storage decision, asserted: a namespaced key in host-core's own meta
    // table, because `secrets` would misdescribe plaintext as sealed and would
    // surface memory rows in `secrets.list`.
    const raw = host.store.getMeta(`memory.agent.${alpha.id}`);
    expect(raw).toContain(stored.memory.id);
    expect(host.store.listSecrets()).toEqual([]);
    // And memory is not a second transcript: only this capability reads it back.
    expect(host.store.countEntries(alpha.id)).toBe(0);
    const secrets = (await host.dispatch(deviceSession(host, 'background'), 'secrets.list', {})) as {
      secrets: unknown[];
    };
    expect(secrets.secrets).toEqual([]);
  });

  it('deletes an agent\'s facts with the agent', async () => {
    const { host, capability } = mountMemory({ dataDir: freshDir() });
    const alpha = host.store.createAgent({ name: 'Alpha' });
    const beta = host.store.createAgent({ name: 'Beta' });
    capability.store.remember(alpha.id, { text: 'alpha signs annual contracts', source: 'user' });
    capability.store.remember(beta.id, { text: 'beta kubernetes cluster is in frankfurt', source: 'agent' });
    expect(capability.counts()).toMatchObject({ agents: 2, memories: 2 });

    host.store.deleteAgents([beta.id]);
    const status = (await host.dispatch(deviceSession(host, 'background'), 'memory.status', {})) as Record<
      string,
      unknown
    >;

    expect(status['agents']).toBe(1);
    expect(status['memories']).toBe(1);
    // The plaintext is gone, not merely unindexed: an empty value is the closest
    // thing to a delete that `Store` exposes for a meta key.
    expect(host.store.getMeta(`memory.agent.${beta.id}`)).toBe('');
  });

  it('attributes a tool call to the agent of the run it is inside', async () => {
    const holder: { capability: MemoryCapability | null } = { capability: null };
    const recalled: Record<string, unknown>[] = [];
    let release: (() => void) | null = null;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { host, capability } = mountMemory({
      dataDir: freshDir(),
      executor: {
        execute: async (context: RunContext) => {
          const tool = toolNamed(holder.capability!, 'memory_recall');
          const output = await tool.execute({ query: 'contracts kubernetes' }, {
            readSecret: () => null,
            cwd: process.cwd(),
            signal: new AbortController().signal,
            note: () => undefined,
          });
          const parsed = JSON.parse(output) as { memories: Record<string, unknown>[] };
          recalled.push(...parsed.memories);
          context.append({ role: 'agent', kind: 'message', content: 'recalled' });
          release?.();
        },
      },
    });
    holder.capability = capability;

    const alpha = host.store.createAgent({ name: 'Alpha' });
    const beta = host.store.createAgent({ name: 'Beta' });
    capability.store.remember(alpha.id, { text: 'alpha signs annual contracts', source: 'user' });
    capability.store.remember(beta.id, { text: 'beta kubernetes cluster is in frankfurt', source: 'agent' });

    // Two agents, and the capability is deliberately unbound: the only thing that
    // can attribute this call is the run in flight.
    await host.dispatch(deviceSession(host, 'person'), 'runs.start', { agentId: alpha.id, prompt: 'what do you know?' });
    await finished;

    expect(recalled.map((row) => row['text'])).toEqual(['alpha signs annual contracts']);
    expect(JSON.stringify(recalled)).not.toContain('frankfurt');

    // The same run scored a use on alpha's fact and none on beta's.
    expect(capability.store.list(alpha.id, { limit: 5 }).memories[0]).toMatchObject({ useCount: 1 });
    expect(capability.store.list(beta.id, { limit: 5 }).memories[0]).toMatchObject({ useCount: 0 });
  });

  it('attributes a tool call to the agent of a run that parked on an approval', async () => {
    const holder: { capability: MemoryCapability | null } = { capability: null };
    let release: (() => void) | null = null;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];

    const { host, capability } = mountMemory({
      dataDir: freshDir(),
      executor: {
        execute: async (context: RunContext) => {
          // A parked run is still "unfinished": status waiting-approval. If the
          // resolution ladder only looked at `running`, this call would refuse.
          const approval = await context.requestApproval({
            kind: 'tool-permission',
            summary: 'Run memory_forget?',
            ttlSeconds: 60,
          });
          seen.push(approval.status);
          const tool = toolNamed(holder.capability!, 'memory_recall');
          const output = await tool.execute({ query: 'contracts' }, {
            readSecret: () => null,
            cwd: process.cwd(),
            signal: new AbortController().signal,
            note: () => undefined,
          });
          seen.push(output);
          release?.();
        },
      },
    });
    holder.capability = capability;

    const alpha = host.store.createAgent({ name: 'Alpha' });
    host.store.createAgent({ name: 'Beta' });
    capability.store.remember(alpha.id, { text: 'alpha signs annual contracts', source: 'user' });

    const person = deviceSession(host, 'person');
    await host.dispatch(person, 'runs.start', { agentId: alpha.id, prompt: 'forget the contract terms' });
    const pending = host.store.listApprovals({ status: 'pending' });
    expect(pending).toHaveLength(1);
    await host.dispatch(person, 'approvals.resolve', { approvalId: pending[0]!.id, granted: true });
    await finished;

    expect(seen[0]).toBe('granted');
    const parsed = JSON.parse(seen[1] ?? '{}') as { agentId: string; memories: { text: string }[] };
    expect(parsed.agentId).toBe(alpha.id);
    expect(parsed.memories.map((row) => row.text)).toEqual(['alpha signs annual contracts']);
  });
});
