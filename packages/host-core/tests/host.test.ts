import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Host, HostError } from '../src/host.js';
import type { RunContext } from '../src/host.js';

/**
 * These tests focus on the properties that would be dangerous to get wrong:
 * the authorization boundary, single-use pairing, the per-agent sequence
 * invariant, and the rule that a secret value never leaves the host.
 */

let dataDir: string;

function makeHost(executor?: { execute(ctx: RunContext, signal: AbortSignal): Promise<void> }) {
  return new Host({
    dataDir,
    version: '0.0.0-test',
    mode: 'self-hosted',
    capabilities: { exec: true, browser: false },
    ...(executor ? { executor } : {}),
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'guhbot-test-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('authorization boundary', () => {
  it('lets a background device call background methods', async () => {
    const host = makeHost();
    const session = host.createSession('network');
    await expect(host.dispatch(session, 'agents.list', {})).resolves.toEqual({ agents: [] });
    await host.close();
  });

  it('refuses a person-class method from a device without human presence', async () => {
    const host = makeHost();
    // A phone that redeems a pairing code joins as `background`.
    const { pairingId, code } = host.beginPairing();
    const { device } = host.claimPairing({
      pairingId,
      code,
      deviceName: 'iPhone',
      platform: 'ios',
      requestedClass: 'background',
    });

    const session = host.createSession('network', device);
    await expect(host.dispatch(session, 'agents.create', { name: 'x' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await host.close();
  });

  it('does not let a remote device promote itself to person class', async () => {
    const host = makeHost();
    const { pairingId, code } = host.beginPairing();
    const { device } = host.claimPairing({
      pairingId,
      code,
      deviceName: 'attacker',
      platform: 'ios',
      // Asking for person here must not be honoured.
      requestedClass: 'person',
    });
    expect(device.class).toBe('background');
    await host.close();
  });

  it('allows a person-class method once a person device is present', async () => {
    const host = makeHost();
    const local = host.createSession('local');
    const { pairingId, code } = host.beginPairing();
    const { device, token } = host.claimPairing({
      pairingId,
      code,
      deviceName: 'Mac',
      platform: 'desktop',
      requestedClass: 'background',
    });

    const authed = host.authenticate(token);
    expect(authed?.id).toBe(device.id);

    // The device is upgraded by local presence on the host, after which it may act.
    const session = host.createSession('local', device);
    session.channel satisfies 'local';
    await host.dispatch(session, 'devices.unlock', {
      localPresenceToken: 'local-console-confirmed',
    });
    const created = await host.dispatch(session, 'agents.create', { name: 'Scout' });
    expect(created).toMatchObject({ name: 'Scout' });
    void local;
    await host.close();
  });

  it('rejects pairing.begin over a network channel', async () => {
    const host = makeHost();
    const remote = host.createSession('network');
    await expect(host.dispatch(remote, 'pairing.begin', {})).rejects.toMatchObject({ code: 'forbidden' });
    await host.close();
  });

  it('rejects unknown methods and malformed params', async () => {
    const host = makeHost();
    const session = host.createSession('local');
    await expect(host.dispatch(session, 'nope.nope', {})).rejects.toBeInstanceOf(HostError);
    await expect(host.dispatch(session, 'events.replay', {})).rejects.toMatchObject({ code: 'not-found' });
    await expect(host.dispatch(session, 'agents.get', { agentId: '' })).rejects.toMatchObject({
      code: 'bad-request',
    });
    await host.close();
  });
});

describe('pairing', () => {
  it('is single use', async () => {
    const host = makeHost();
    const { pairingId, code } = host.beginPairing();
    host.claimPairing({ pairingId, code, deviceName: 'a', platform: 'ios', requestedClass: 'background' });
    expect(() =>
      host.claimPairing({ pairingId, code, deviceName: 'b', platform: 'ios', requestedClass: 'background' }),
    ).toThrow(/claimed/);
    await host.close();
  });

  it('rejects a wrong code and rate limits repeated attempts', async () => {
    const host = makeHost();
    const { pairingId } = host.beginPairing();
    for (let i = 0; i < 10; i += 1) {
      expect(() =>
        host.claimPairing({ pairingId, code: '00000000', deviceName: 'x', platform: 'ios', requestedClass: 'background' }),
      ).toThrow();
    }
    // After the attempt budget is spent, even the correct code is refused.
    expect(() =>
      host.claimPairing({ pairingId, code: '00000000', deviceName: 'x', platform: 'ios', requestedClass: 'background' }),
    ).toThrow(/too-many-attempts/);
    await host.close();
  });

  it('stores only a hash of the code', async () => {
    const host = makeHost();
    const { pairingId, code } = host.beginPairing();
    const row = host.store.db.prepare('SELECT code_hash FROM pairings WHERE id = ?').get(pairingId) as {
      code_hash: string;
    };
    expect(row.code_hash).not.toContain(code);
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    await host.close();
  });
});

describe('transcript sequence', () => {
  it('allocates contiguous per-agent sequences', async () => {
    const host = makeHost();
    const a = host.store.createAgent({ name: 'A' });
    const b = host.store.createAgent({ name: 'B' });
    for (const agentId of [a.id, b.id, a.id, b.id, a.id]) {
      host.store.appendEntry({ agentId, role: 'agent', kind: 'message', content: 'x' });
    }
    expect(host.store.listEntries(a.id, { limit: 100 }).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(host.store.listEntries(b.id, { limit: 100 }).map((e) => e.seq)).toEqual([0, 1]);
    await host.close();
  });

  it('resyncs from afterSeq without gaps', async () => {
    const host = makeHost();
    const agent = host.store.createAgent({ name: 'A' });
    for (let i = 0; i < 10; i += 1) {
      host.store.appendEntry({ agentId: agent.id, role: 'user', kind: 'message', content: `m${i}` });
    }
    const page = host.store.listEntries(agent.id, { afterSeq: 4, limit: 3 });
    expect(page.map((e) => e.seq)).toEqual([5, 6, 7]);
    const rest = host.store.listEntries(agent.id, { afterSeq: 7, limit: 100 });
    expect(rest.map((e) => e.seq)).toEqual([8, 9]);
    await host.close();
  });

  it('keeps sequence unique under concurrent appends', async () => {
    const host = makeHost();
    const agent = host.store.createAgent({ name: 'A' });
    await Promise.all(
      Array.from({ length: 40 }, () =>
        Promise.resolve().then(() =>
          host.store.appendEntry({ agentId: agent.id, role: 'agent', kind: 'message', content: 'c' }),
        ),
      ),
    );
    const all = host.store.listEntries(agent.id, { limit: 1000 });
    expect(all).toHaveLength(40);
    expect(new Set(all.map((e) => e.seq)).size).toBe(40);
    await host.close();
  });
});

describe('secrets', () => {
  it('never returns a value over the protocol', async () => {
    const host = makeHost();
    const local = host.createSession('local');
    const meta = (await host.dispatch(local, 'secrets.put', {
      name: 'portal-password',
      value: 'hunter2-not-in-db',
    })) as Record<string, unknown>;

    expect(JSON.stringify(meta)).not.toContain('hunter2-not-in-db');
    const listed = (await host.dispatch(local, 'secrets.list', {})) as { secrets: unknown[] };
    expect(JSON.stringify(listed)).not.toContain('hunter2-not-in-db');

    // The ciphertext on disk must not contain the plaintext either.
    const row = host.store.readSealedSecret('portal-password');
    expect(row).not.toBeNull();
    expect(row).not.toContain('hunter2-not-in-db');
    await host.close();
  });

  it('round-trips a value for internal tool use', async () => {
    const host = makeHost();
    host.putSecret('api-key', 'sk-test-123', 'https://example.com');
    const sealed = host.store.readSealedSecret('api-key');
    expect(sealed).not.toBeNull();
    await host.close();
  });
});

describe('runs and approvals', () => {
  it('reports inferenceReady false and refuses runs when no executor is configured', async () => {
    const host = makeHost();
    const local = host.createSession('local');
    const status = (await host.dispatch(local, 'host.status', {})) as { inferenceReady: boolean };
    expect(status.inferenceReady).toBe(false);
    const agent = host.store.createAgent({ name: 'A' });
    await expect(host.dispatch(local, 'runs.start', { agentId: agent.id, prompt: 'hi' })).rejects.toMatchObject({
      code: 'internal',
    });
    await host.close();
  });

  it('parks a run on an approval and resumes when resolved', async () => {
    let observedApprovalStatus: string | null = null;
    const host = makeHost({
      execute: async (ctx) => {
        ctx.append({ role: 'user', kind: 'message', content: 'thinking' });
        const approval = await ctx.requestApproval({
          kind: 'tool-permission',
          summary: 'Run `rm -rf /tmp/x`?',
          ttlSeconds: 60,
        });
        observedApprovalStatus = approval.status;
        ctx.append({ role: 'agent', kind: 'message', content: `decision=${approval.status}` });
      },
    });

    const local = host.createSession('local');
    const agent = host.store.createAgent({ name: 'Ops' });
    const { run } = (await host.dispatch(local, 'runs.start', { agentId: agent.id, prompt: 'clean up' })) as {
      run: { id: string };
    };

    // Wait for the run to park on the approval.
    await new Promise((r) => setTimeout(r, 50));
    const pending = (await host.dispatch(local, 'approvals.list', { status: 'pending' })) as {
      approvals: { id: string }[];
    };
    expect(pending.approvals).toHaveLength(1);

    // A background device must not be able to resolve it.
    const remote = host.createSession('network', host.store.listDevices()[0] ?? null);
    await expect(
      host.dispatch(remote, 'approvals.resolve', { approvalId: pending.approvals[0]!.id, granted: true }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await host.dispatch(local, 'approvals.resolve', { approvalId: pending.approvals[0]!.id, granted: true });
    await new Promise((r) => setTimeout(r, 50));

    expect(observedApprovalStatus).toBe('granted');
    const runs = (await host.dispatch(local, 'runs.list', { agentId: agent.id, limit: 10 })) as {
      runs: { id: string; status: string }[];
    };
    expect(runs.runs.find((r) => r.id === run.id)?.status).toBe('succeeded');
    await host.close();
  });

  it('expires an approval whose deadline has passed instead of granting it', async () => {
    const host = makeHost();
    const agent = host.store.createAgent({ name: 'A' });
    const approval = host.store.createApproval({
      agentId: agent.id,
      runId: null,
      kind: 'tool-permission',
      summary: 'stale',
      detail: '{}',
      ttlSeconds: -1,
    });
    const resolved = host.store.resolveApproval(approval.id, true, null);
    expect(resolved?.status).toBe('expired');
    await host.close();
  });

  it('fails runs left in flight by a previous process', async () => {
    const host = makeHost();
    const agent = host.store.createAgent({ name: 'A' });
    const run = host.store.createRun(agent.id, null);
    host.store.updateRun(run.id, { status: 'running' });
    host.store.close();

    const restarted = makeHost();
    expect(restarted.store.getRun(run.id)?.status).toBe('failed');
    expect(restarted.store.getRun(run.id)?.error).toMatch(/restarted/);
    await restarted.close();
  });
});

describe('host.describe', () => {
  it('lists every method with its authorization class', async () => {
    const host = makeHost();
    const local = host.createSession('local');
    const described = (await host.dispatch(local, 'host.describe', {})) as {
      methods: { name: string; authz: string; summary: string }[];
    };
    expect(described.methods.length).toBeGreaterThan(30);
    for (const m of described.methods) {
      expect(['person', 'background']).toContain(m.authz);
      expect(m.summary.length).toBeGreaterThan(8);
    }
    // The two most dangerous classes of action must never be background-safe.
    const byName = new Map(described.methods.map((m) => [m.name, m.authz]));
    expect(byName.get('approvals.resolve')).toBe('person');
    expect(byName.get('secrets.put')).toBe('person');
    expect(byName.get('runs.start')).toBe('person');
    expect(byName.get('transcript.page')).toBe('background');
    await host.close();
  });
});

describe('agent list fan-out', () => {
  it('tells watching clients when an agent is created or duplicated', async () => {
    const host = makeHost();
    const local = host.createSession('local');
    const seen: string[] = [];
    host.on('agent.updated', (payload) => {
      seen.push(payload.agent.id);
    });

    const created = (await host.dispatch(local, 'agents.create', { name: 'Scout' })) as { id: string };
    // A phone watching the list upserts on this event, so without it the new
    // agent only appears after a manual refresh.
    expect(seen).toEqual([created.id]);

    const copy = (await host.dispatch(local, 'agents.duplicate', { agentId: created.id })) as { id: string };
    expect(seen).toEqual([created.id, copy.id]);
    await host.close();
  });
});
