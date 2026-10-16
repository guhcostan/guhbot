import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '@guhbot/agent';
import { CliRunError, createCliEngines, createEngineRegistry, type CliEngineOptions, type CliTurnResult } from '../src/index.js';
import { cleanupTempDirs, fakeContext, fixture, installFakeCli } from './support.js';

/**
 * The OpenCode engine.
 *
 * `tests/fixtures/opencode-success.jsonl` and `opencode-error.jsonl` are trimmed
 * copies of real `opencode run --format json` output from v2.0.25.
 */

function opencodeEngine(options: CliEngineOptions = {}): Engine {
  return createEngineRegistry(createCliEngines(options)).require('opencode');
}

function replay(stream: string, extra: Record<string, string> = {}): CliEngineOptions {
  return {
    commands: { opencode: installFakeCli() },
    env: { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: fixture(stream), ...extra },
  };
}

afterEach(() => {
  cleanupTempDirs();
});

describe('opencode engine', () => {
  it('emits text parts as they arrive and sums the per-step cost', async () => {
    const results: CliTurnResult[] = [];
    const engine = opencodeEngine({ ...replay('opencode-success.jsonl'), onTurnResult: (result) => results.push(result) });
    const recorded = fakeContext();

    await engine.createExecutor({ cwd: '/tmp' }).execute(recorded.context, new AbortController().signal);

    expect(recorded.deltas.map((delta) => delta.text)).toEqual(['Listing current directory now.', 'Done.']);
    // Two step_finish events, 0.00085425 + 0.0004.
    expect(results[0]?.costUsd).toBeCloseTo(0.00125425, 8);
    expect(recorded.entries).toContainEqual({
      role: 'system',
      kind: 'status',
      content: 'OpenCode reported $0.0013 of usage for this turn.',
      toolName: null,
    });
  });

  it('records the tool call and its output', async () => {
    const engine = opencodeEngine(replay('opencode-success.jsonl'));
    const recorded = fakeContext();

    await engine.createExecutor({ cwd: '/tmp' }).execute(recorded.context, new AbortController().signal);

    expect(recorded.entries.filter((entry) => entry.kind === 'tool-call')).toEqual([
      { role: 'agent', kind: 'tool-call', content: '{"command":"ls -la"}', toolName: 'shell' },
    ]);
    expect(recorded.entries.filter((entry) => entry.kind === 'tool-result')[0]?.content).toContain('total 0');
  });

  it('fails a structured provider error', async () => {
    const engine = opencodeEngine(replay('opencode-error.jsonl'));

    const error = await engine
      .createExecutor({ cwd: '/tmp' })
      .execute(fakeContext().context, new AbortController().signal)
      .then(() => null)
      .catch((thrown: unknown) => thrown as CliRunError);

    expect(error?.message).toContain('Model unavailable: nope/nope');
    expect(error?.blocked).toBeNull();
  });

  it('fails a rate-limited provider with the limit, not an empty answer', async () => {
    const engine = opencodeEngine(replay('opencode-rate-limited.jsonl'));
    const recorded = fakeContext();

    const error = await engine
      .createExecutor({ cwd: '/tmp' })
      .execute(recorded.context, new AbortController().signal)
      .then(() => null)
      .catch((thrown: unknown) => thrown as CliRunError);

    expect(error?.message).toMatch(/rate limited/i);
    expect(error?.message).toMatch(/usage limit/i);
    expect(error?.blocked?.kind).toBe('rate-limit');
    expect(recorded.deltas).toEqual([]);
  });

  it('passes the model through and keeps the prompt a single argument', () => {
    const engine = opencodeEngine();
    const args = (
      engine as Engine & { buildArgs: (prompt: string, options: { cwd: string; model?: string }) => string[] }
    ).buildArgs('-not-a-flag', { cwd: '/work', model: 'anthropic/claude-sonnet-4-5' });

    expect(args.slice(0, 3)).toEqual(['run', '--format', 'json']);
    expect(args).toEqual(expect.arrayContaining(['--model', 'anthropic/claude-sonnet-4-5']));
    expect(args.slice(-2)).toEqual(['--', '-not-a-flag']);
  });
});
