import { afterEach, describe, expect, it } from 'vitest';
import type { Engine, EngineProbe, RunExecutor } from '@guhbot/agent';
import { createCliEngines, createEngineRegistry } from '../src/index.js';
import { cleanupTempDirs, installFakeCli } from './support.js';

/** The registry is what a host's configuration UI talks to. */

function stub(id: string, probe: () => Promise<EngineProbe>): Engine {
  const executor: RunExecutor = { execute: async () => undefined };
  return {
    id,
    name: `Stub ${id}`,
    requirement: 'nothing',
    probe,
    createExecutor: () => executor,
  };
}

afterEach(() => {
  cleanupTempDirs();
});

describe('engine registry', () => {
  it('registers every shipped engine when built without an argument', () => {
    expect(createEngineRegistry().ids()).toEqual(['claude-code', 'codex', 'opencode']);
  });

  it('lists the shipped engines by descriptor without starting anything', () => {
    const registry = createEngineRegistry(createCliEngines());

    expect(registry.ids()).toEqual(['claude-code', 'codex', 'opencode']);
    expect(registry.list()).toEqual([
      {
        id: 'claude-code',
        name: 'Claude Code',
        requirement: 'Claude Code installed and signed in (`claude` on PATH).',
      },
      { id: 'codex', name: 'Codex', requirement: expect.stringContaining('signed in') },
      { id: 'opencode', name: 'OpenCode', requirement: expect.stringContaining('signed in') },
    ]);
  });

  it('throws for an unknown id and names every id that would have worked', () => {
    const registry = createEngineRegistry(createCliEngines());

    expect(() => registry.require('claude')).toThrow(/no engine is configured with the id "claude"/);
    expect(() => registry.require('claude')).toThrow(/claude-code, codex, opencode/);
    expect(registry.get('claude')).toBeUndefined();
    expect(registry.get('codex')?.id).toBe('codex');
  });

  it('refuses two engines with the same id', () => {
    const probe = async (): Promise<EngineProbe> => ({ available: true, version: null, reason: null, blocked: null });

    expect(() => createEngineRegistry([stub('dupe', probe), stub('dupe', probe)])).toThrow(/ids must be unique/);
  });

  it('surfaces each engine probe result', async () => {
    const registry = createEngineRegistry([
      stub('ready', async () => ({ available: true, version: '1.2.3', reason: null, blocked: null })),
      stub('missing', async () => ({ available: false, version: null, reason: 'not found on PATH', blocked: null })),
      stub('throttled', async () => ({
        available: true,
        version: '1.0.0',
        reason: null,
        blocked: 'Claude Code is rate limited: the weekly limit resets at 2026-10-19T02:00:00.000Z.',
      })),
    ]);

    const statuses = await registry.probe();

    expect(statuses.map((status) => [status.id, status.probe.available, status.probe.blocked])).toEqual([
      ['ready', true, null],
      ['missing', false, null],
      ['throttled', true, expect.stringContaining('rate limited')],
    ]);
  });

  it('keeps a status list intact when one engine probe throws', async () => {
    const registry = createEngineRegistry([
      stub('angry', async () => {
        throw new Error('the CLI printed garbage');
      }),
      stub('fine', async () => ({ available: true, version: '1', reason: null, blocked: null })),
    ]);

    const statuses = await registry.probe();

    expect(statuses[0]?.probe).toEqual({
      available: false,
      version: null,
      reason: 'the probe failed: the CLI printed garbage',
      blocked: null,
    });
    expect(statuses[1]?.probe.available).toBe(true);
  });

  it('reports a real probe for a real (fixture) executable', async () => {
    const registry = createEngineRegistry(
      createCliEngines({
        commands: { 'claude-code': installFakeCli() },
        env: { FAKE_CLI_MODE: 'version', FAKE_CLI_VERSION: 'fake-cli 1.0.0' },
      }),
    );

    const statuses = await registry.probe();
    const claude = statuses.find((status) => status.id === 'claude-code');

    expect(claude?.probe).toEqual({ available: true, version: 'fake-cli 1.0.0', reason: null, blocked: null });
    // The other two are probed against whatever this machine has, so their
    // result is asserted only for shape: a registry must never throw at boot.
    expect(statuses).toHaveLength(3);
    expect(statuses.every((status) => typeof status.probe.available === 'boolean')).toBe(true);
  });
});
