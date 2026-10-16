import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '@guhbot/agent';
import { CliRunError, createCliEngines, createEngineRegistry, type CliEngineOptions, type CliTurnResult } from '../src/index.js';
import { cleanupTempDirs, fakeContext, fixture, installFakeCli, recordingSpawn } from './support.js';

/**
 * The Codex engine.
 *
 * `tests/fixtures/codex-*.jsonl` are trimmed copies of real `codex exec --json`
 * output from codex-cli 0.162.1, including the two non-fatal `item` errors it
 * emits on every run for unstable features and MCP servers that need auth.
 */

function codexEngine(options: CliEngineOptions = {}): Engine {
  return createEngineRegistry(createCliEngines(options)).require('codex');
}

function replay(stream: string, extra: Record<string, string> = {}): CliEngineOptions {
  return {
    commands: { codex: installFakeCli() },
    env: { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: fixture(stream), ...extra },
  };
}

afterEach(() => {
  cleanupTempDirs();
});

describe('codex engine', () => {
  it('passes --skip-git-repo-check, because Codex refuses to run outside a trusted directory', () => {
    const engine = codexEngine();
    const args = (engine as Engine & { buildArgs: (prompt: string, options: { cwd: string }) => string[] }).buildArgs(
      'do the thing',
      { cwd: '/work' },
    );

    // Without this flag `codex exec` refuses to start in any directory that is
    // not a git repository, which is most host working directories.
    expect(args).toContain('--skip-git-repo-check');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    // The prompt is a positional argument, and `--` keeps a prompt that starts
    // with a dash from being read as a flag.
    expect(args[args.length - 1]).toBe('do the thing');
    expect(args[args.length - 2]).toBe('--');
  });

  it('streams each agent_message delta in order and records the run', async () => {
    const captured = recordingSpawn(installFakeCli());
    // No command override here: the point is the real argv the engine builds for
    // `codex`, which the spy records before running the fixture instead.
    const engine = codexEngine({
      spawn: captured.spawn,
      env: { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: fixture('codex-success.jsonl') },
    });
    const recorded = fakeContext();

    await engine.createExecutor({ cwd: '/tmp' }).execute(recorded.context, new AbortController().signal);

    expect(captured.calls[0]?.command).toBe('codex');
    expect(captured.calls[0]?.args).toContain('--skip-git-repo-check');
    expect(recorded.deltas.map((delta) => delta.text)).toEqual(["I'll run the command now.\n", 'done']);
    expect(recorded.entries.filter((entry) => entry.kind === 'message')).toEqual([
      { role: 'agent', kind: 'message', content: "I'll run the command now.\ndone", toolName: null },
    ]);
  });

  it('treats a non-fatal item error as noise and still succeeds', async () => {
    const engine = codexEngine(replay('codex-success.jsonl'));
    const recorded = fakeContext();

    // The recorded stream carries two `{"type":"item.completed","item":{"type":"error"}}`
    // warnings, as every real Codex run does.
    await engine.createExecutor({ cwd: '/tmp' }).execute(recorded.context, new AbortController().signal);

    expect(recorded.entries.some((entry) => entry.kind === 'error')).toBe(false);
    expect(recorded.deltas.length).toBeGreaterThan(0);
  });

  it('records the commands Codex ran itself', async () => {
    const engine = codexEngine(replay('codex-success.jsonl'));
    const recorded = fakeContext();

    await engine.createExecutor({ cwd: '/tmp' }).execute(recorded.context, new AbortController().signal);

    expect(recorded.entries.filter((entry) => entry.kind === 'tool-call')).toEqual([
      { role: 'agent', kind: 'tool-call', content: '{"command":"/bin/zsh -lc \'echo hi\'"}', toolName: 'shell' },
    ]);
    expect(recorded.entries.filter((entry) => entry.kind === 'tool-result')).toEqual([
      { role: 'tool', kind: 'tool-result', content: 'hi\n', toolName: 'shell' },
    ]);
  });

  it('reports token usage to the caller', async () => {
    const results: CliTurnResult[] = [];
    const engine = codexEngine({ ...replay('codex-success.jsonl'), onTurnResult: (result) => results.push(result) });

    await engine.createExecutor({ cwd: '/tmp' }).execute(fakeContext().context, new AbortController().signal);

    expect(results[0]?.usage).toMatchObject({ input_tokens: 55909, output_tokens: 53, cached_input_tokens: 40960 });
    // Codex on a ChatGPT plan reports no dollar cost; null is the honest value.
    expect(results[0]?.costUsd).toBeNull();
    expect(results[0]?.sessionId).toBe('01a144f9-499a-7641-bbe1-6bf2a1a4b1fb');
  });

  it('fails with the structured turn.failed message', async () => {
    const engine = codexEngine(replay('codex-failed.jsonl'));
    const recorded = fakeContext();

    const error = await engine
      .createExecutor({ cwd: '/tmp' })
      .execute(recorded.context, new AbortController().signal)
      .then(() => null)
      .catch((thrown: unknown) => thrown as CliRunError);

    expect(error?.message).toMatch(/reported an error/i);
    expect(error?.message).toContain('not supported when using Codex with a ChatGPT account');
    expect(error?.blocked).toBeNull();
    expect(recorded.entries[0]).toMatchObject({ kind: 'error' });
  });
});
