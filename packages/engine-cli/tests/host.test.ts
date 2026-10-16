import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Host, type Session } from '@guhbot/host-core';
import type { RunStatus } from '@guhbot/protocol';
import { createCliEngines, createEngineRegistry } from '../src/index.js';
import { cleanupTempDirs, fixture, installFakeCli, waitFor } from './support.js';

/**
 * The point of the engine seam: an engine's `RunExecutor` is handed to
 * `host-core` with no adapter. These tests drive a real `Host` — its own store,
 * its own run lifecycle — against a fixture-backed CLI.
 */

const dirs: string[] = [];
const hosts: Host[] = [];

function hostWithExecutor(executor: Host['executor']): Host {
  const dataDir = mkdtempSync(join(tmpdir(), 'guhbot-engine-host-'));
  dirs.push(dataDir);
  const host = new Host({ dataDir, version: '0.0.0-test', mode: 'local', executor });
  hosts.push(host);
  return host;
}

const session: Session = { id: 'sess_local', channel: 'local', device: null };

async function settled(host: Host, runId: string): Promise<RunStatus> {
  await waitFor(
    () => {
      const status = host.store.getRun(runId)?.status;
      return status !== undefined && status !== 'running' && status !== 'queued';
    },
    10_000,
    'the run to settle',
  );
  return host.store.getRun(runId)?.status ?? 'queued';
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  cleanupTempDirs();
});

describe('host integration', () => {
  it('runs a CLI engine through host-core without an adapter', async () => {
    const engine = createEngineRegistry(
      createCliEngines({
        commands: { codex: installFakeCli() },
        env: { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: fixture('codex-success.jsonl') },
      }),
    ).require('codex');

    const host = hostWithExecutor(engine.createExecutor({ cwd: tmpdir() }));
    const agent = host.store.createAgent({ name: 'Codex', instructions: 'Be terse.' });

    const { run } = await host.startRun(session, agent.id, 'run the command');

    expect(await settled(host, run.id)).toBe('succeeded');
    expect(host.store.getRun(run.id)?.error).toBeNull();

    const entries = host.store.listRecentEntries(agent.id, 20);
    expect(entries.filter((entry) => entry.role === 'agent' && entry.kind === 'message')).toEqual([
      expect.objectContaining({ content: "I'll run the command now.\ndone", runId: run.id }),
    ]);
    // The CLI's own tool use is in the transcript, so the run is auditable.
    expect(entries.some((entry) => entry.kind === 'tool-call')).toBe(true);
  });

  it('marks a rate-limited CLI run as failed, with the reason on the run', async () => {
    const engine = createEngineRegistry(
      createCliEngines({
        commands: { 'claude-code': installFakeCli() },
        env: { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: fixture('claude-rate-limited.jsonl') },
      }),
    ).require('claude-code');

    const host = hostWithExecutor(engine.createExecutor({ cwd: tmpdir() }));
    const agent = host.store.createAgent({ name: 'Claude Code', instructions: '' });

    const { run } = await host.startRun(session, agent.id, 'do the thing');

    // The CLI exits 0. Without the structured check this run would be
    // "succeeded" with an empty transcript, which is the lie we refuse.
    expect(await settled(host, run.id)).toBe('failed');
    expect(host.store.getRun(run.id)?.error).toMatch(/weekly limit/i);

    const entries = host.store.listRecentEntries(agent.id, 20);
    expect(entries.some((entry) => entry.kind === 'error' && /weekly limit/i.test(entry.content))).toBe(true);
    expect(entries.some((entry) => entry.role === 'agent' && entry.kind === 'message')).toBe(false);
  });

  it('records a user interrupt as interrupted, not failed', async () => {
    const engine = createEngineRegistry(
      createCliEngines({
        commands: { 'claude-code': installFakeCli() },
        env: { FAKE_CLI_MODE: 'hang' },
      }),
    ).require('claude-code');

    const host = hostWithExecutor(engine.createExecutor({ cwd: tmpdir() }));
    const agent = host.store.createAgent({ name: 'Claude Code', instructions: '' });
    const { run } = await host.startRun(session, agent.id, 'take your time');

    await waitFor(() => host.interruptRun(run.id), 10_000, 'the run to be interruptible');

    expect(await settled(host, run.id)).toBe('interrupted');
    expect(host.store.getRun(run.id)?.error).toBeNull();
  });
});
