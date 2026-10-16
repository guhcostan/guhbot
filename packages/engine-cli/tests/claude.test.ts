import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine, EngineRunOptions } from '@guhbot/agent';
import { CliRunError, createCliEngines, createEngineRegistry, type CliEngineOptions } from '../src/index.js';
import { cleanupTempDirs, fakeContext, fixture, installFakeCli, makeTempDir, observedSignals, recordingSpawn, waitFor } from './support.js';

/**
 * The Claude Code engine, driven by recorded streams.
 *
 * The rate-limit and signed-out fixtures are trimmed copies of a real capture
 * from `claude -p ... --output-format stream-json --verbose` on 2.1.293, taken
 * while this machine was actually rate limited. The success fixture uses the
 * same envelopes with a successful turn substituted, because a machine that is
 * rate limited cannot produce one.
 */

function claudeEngine(options: CliEngineOptions = {}): Engine {
  return createEngineRegistry(createCliEngines(options)).require('claude-code');
}

/** Configure the fixture to replay a recorded stream, with extra env. */
function replay(stream: string, extra: Record<string, string> = {}): CliEngineOptions {
  return {
    commands: { 'claude-code': installFakeCli() },
    env: { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: fixture(stream), ...extra },
  };
}

async function run(engine: Engine, options: EngineRunOptions = { cwd: '/tmp' }) {
  const recorded = fakeContext();
  const controller = new AbortController();
  await engine.createExecutor(options).execute(recorded.context, controller.signal);
  return recorded;
}

afterEach(() => {
  cleanupTempDirs();
});

describe('claude code engine', () => {
  it('streams deltas as they arrive and finishes with the agent message', async () => {
    const { entries, deltas } = await run(claudeEngine(replay('claude-success.jsonl')));

    // Order matters: the client renders these as they land, so a reordering
    // would be visible text appearing out of sequence.
    expect(deltas.map((delta) => delta.text)).toEqual(['Hello ', 'from ', 'Claude Code.']);
    expect(deltas.map((delta) => delta.seq)).toEqual([0, 0, 0]);
    expect(deltas.map((delta) => delta.text).join('')).toBe('Hello from Claude Code.');

    // The finished assistant message repeats the streamed text; the transcript
    // must hold it exactly once.
    expect(entries.filter((entry) => entry.kind === 'message')).toEqual([
      { role: 'agent', kind: 'message', content: 'Hello from Claude Code.', toolName: null },
    ]);
  });

  it('surfaces the reported cost in the transcript', async () => {
    const { entries } = await run(claudeEngine(replay('claude-success.jsonl')));

    expect(entries).toContainEqual({
      role: 'system',
      kind: 'status',
      content: 'Claude Code reported $0.0123 of usage for this turn.',
      toolName: null,
    });
  });

  it('reports cost and usage to the caller without echoing anything secret', async () => {
    const results: unknown[] = [];
    const engine = claudeEngine({ ...replay('claude-success.jsonl'), onTurnResult: (result) => results.push(result) });

    await run(engine);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      engineId: 'claude-code',
      costUsd: 0.0123,
      model: 'claude-sonnet-4-5',
      sessionId: 'sess-success',
      exitCode: 0,
    });
    expect((results[0] as { usage: Record<string, number> }).usage).toMatchObject({ input_tokens: 12, output_tokens: 6 });
  });

  it('skips init, hooks and command bookkeeping', async () => {
    const { entries, deltas } = await run(claudeEngine(replay('claude-success.jsonl')));

    const noisy = entries.filter((entry) => /hook_started|commands_changed|"subtype":"init"/.test(entry.content));
    expect(noisy).toEqual([]);
    expect(deltas.map((delta) => delta.text).join('')).not.toContain('hook');
  });

  it('fails with the weekly limit instead of succeeding with an empty answer', async () => {
    const engine = claudeEngine(replay('claude-rate-limited.jsonl'));
    const recorded = fakeContext();

    // The real stream exits 0. A driver that trusts the exit code reports a
    // successful empty turn, which is the lie this engine exists to prevent.
    const error = await engine
      .createExecutor({ cwd: '/tmp' })
      .execute(recorded.context, new AbortController().signal)
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CliRunError);
    const failure = error as CliRunError;
    expect(failure.message).toMatch(/weekly limit/i);
    expect(failure.message).toContain('2026-10-19T02:00:00.000Z');
    expect(failure.message).toMatch(/rate limited/i);
    expect(failure.blocked?.kind).toBe('rate-limit');

    // Nothing was produced, and the failure is visible in the transcript.
    expect(recorded.deltas).toEqual([]);
    expect(recorded.entries).toHaveLength(1);
    expect(recorded.entries[0]).toMatchObject({ role: 'system', kind: 'error' });
    expect(recorded.entries[0]?.content).toMatch(/weekly limit/i);
  });

  it('does not treat a warning-level rate limit event as a refusal', async () => {
    // `allowed_warning` means "close to the limit, still working". Failing that
    // turn would break runs that would otherwise have succeeded.
    const { entries, deltas } = await run(claudeEngine(replay('claude-success.jsonl')));

    expect(deltas.map((delta) => delta.text).join('')).toBe('Hello from Claude Code.');
    expect(entries.some((entry) => entry.kind === 'error')).toBe(false);
  });

  it('fails a signed-out session with advice the user can act on', async () => {
    const engine = claudeEngine(replay('claude-signed-out.jsonl'));
    const recorded = fakeContext();

    const error = await engine
      .createExecutor({ cwd: '/tmp' })
      .execute(recorded.context, new AbortController().signal)
      .then(() => null)
      .catch((thrown: unknown) => thrown as CliRunError);

    expect(error?.message).toMatch(/not signed in/i);
    expect(error?.message).toMatch(/sign in/i);
    expect(error?.blocked?.kind).toBe('signed-out');
    expect(recorded.deltas).toEqual([]);
  });

  it('handles a line split across chunks, a blank line and a banner', async () => {
    const dir = makeTempDir();
    // 41 bytes is not a line boundary, so several events straddle writes. A
    // blank line and a banner are wedged in where a CLI would put them.
    const stream = join(dir, 'chunked.jsonl');
    writeFileSync(
      stream,
      [
        'not json, just a banner',
        '',
        ...readFileSync(fixture('claude-success.jsonl'), 'utf8').split('\n'),
        '',
      ].join('\n'),
    );

    const { deltas, entries } = await run(
      claudeEngine({
        commands: { 'claude-code': installFakeCli() },
        env: { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: stream, FAKE_CLI_CHUNK: '41' },
      }),
    );

    expect(deltas.map((delta) => delta.text).join('')).toBe('Hello from Claude Code.');
    expect(entries.filter((entry) => entry.kind === 'message')).toHaveLength(1);
  });

  it('still reports success when a version prints no partial messages', async () => {
    const dir = makeTempDir();
    const stream = join(dir, 'no-partials.jsonl');
    writeFileSync(
      stream,
      [
        '{"type":"system","subtype":"init","session_id":"s1"}',
        '{"type":"assistant","message":{"id":"m1","model":"claude-sonnet-4-5","content":[{"type":"text","text":"All done."}]}}',
        '{"type":"result","subtype":"success","is_error":false,"result":"All done.","total_cost_usd":0.002,"session_id":"s1"}',
      ].join('\n'),
    );

    const { deltas, entries } = await run(
      claudeEngine({
        commands: { 'claude-code': installFakeCli() },
        env: { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: stream },
      }),
    );

    expect(deltas.map((delta) => delta.text).join('')).toBe('All done.');
    expect(entries.filter((entry) => entry.kind === 'message')).toHaveLength(1);
  });

  it('records tool calls and results the CLI ran itself', async () => {
    const dir = makeTempDir();
    const stream = join(dir, 'tools.jsonl');
    writeFileSync(
      stream,
      [
        '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1","model":"claude-sonnet-4-5"}}}',
        '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash"}}}',
        '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}}',
        '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
        '{"type":"assistant","message":{"id":"m1","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}',
        '{"type":"assistant","message":{"id":"m2","model":"claude-sonnet-4-5","content":[{"type":"text","text":"Listed."}]}}',
      ].join('\n'),
    );

    const { entries } = await run(
      claudeEngine({
        commands: { 'claude-code': installFakeCli() },
        env: { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: stream },
      }),
    );

    // Exactly one call, recorded from the stream rather than duplicated from the
    // finished message that repeats it.
    expect(entries.filter((entry) => entry.kind === 'tool-call')).toEqual([
      { role: 'agent', kind: 'tool-call', content: '{"command":"ls"}', toolName: 'Bash' },
    ]);
    expect(entries.filter((entry) => entry.kind === 'message')).toEqual([
      { role: 'agent', kind: 'message', content: 'Listed.', toolName: null },
    ]);
  });

  it('fails a non-zero exit with no parseable output, carrying the stderr tail', async () => {
    const engine = claudeEngine({
      commands: { 'claude-code': installFakeCli() },
      env: {
        FAKE_CLI_MODE: 'fail',
        FAKE_CLI_EXIT: '2',
        FAKE_CLI_STDERR: 'Error: cannot find module "foo"\n  at load (/app/foo.js:1)\nplease fix your config\n',
      },
    });

    const error = await engine
      .createExecutor({ cwd: '/tmp' })
      .execute(fakeContext().context, new AbortController().signal)
      .then(() => null)
      .catch((thrown: unknown) => thrown as CliRunError);

    expect(error?.message).toMatch(/exited with code 2/);
    expect(error?.message).toContain('please fix your config');
    expect(error?.blocked).toBeNull();
  });

  it('fails an exit-0 turn that says nothing at all', async () => {
    const engine = claudeEngine({
      commands: { 'claude-code': installFakeCli() },
      env: { FAKE_CLI_MODE: 'fail', FAKE_CLI_EXIT: '0', FAKE_CLI_STDOUT: '' },
    });

    const error = await engine
      .createExecutor({ cwd: '/tmp' })
      .execute(fakeContext().context, new AbortController().signal)
      .then(() => null)
      .catch((thrown: unknown) => thrown as CliRunError);

    expect(error?.message).toMatch(/without producing an answer/i);
  });

  it('kills the child when the run is cancelled', async () => {
    const dir = makeTempDir();
    const signalFile = join(dir, 'signals.txt');
    const pidFile = join(dir, 'pid.txt');
    const engine = claudeEngine({
      commands: { 'claude-code': installFakeCli() },
      env: { FAKE_CLI_MODE: 'hang', FAKE_CLI_SIGNAL_FILE: signalFile, FAKE_CLI_PID_FILE: pidFile },
      killGraceMs: 200,
    });

    const recorded = fakeContext();
    const controller = new AbortController();
    const running = engine.createExecutor({ cwd: '/tmp' }).execute(recorded.context, controller.signal);

    await waitFor(() => observedSignals(pidFile).length > 0, 5000, 'the child to start');
    controller.abort();
    await running;

    // The process observed a real signal, so cancellation reached the child
    // rather than only stopping the reader.
    await waitFor(() => observedSignals(signalFile).length > 0, 5000, 'the child to record its signal');
    expect(observedSignals(signalFile)).toContain('SIGTERM');
    // A cancelled turn is not a failed turn, and it recorded nothing.
    expect(recorded.entries).toEqual([]);
  });

  it('kills the child and fails the run when the turn times out', async () => {
    const dir = makeTempDir();
    const signalFile = join(dir, 'signals.txt');
    const pidFile = join(dir, 'pid.txt');
    const engine = claudeEngine({
      commands: { 'claude-code': installFakeCli() },
      env: { FAKE_CLI_MODE: 'hang', FAKE_CLI_SIGNAL_FILE: signalFile, FAKE_CLI_PID_FILE: pidFile },
      killGraceMs: 500,
    });

    // Long enough that the child is well past its own startup: what is under test
    // is the timeout, not a race against Node booting.
    const error = await engine
      .createExecutor({ cwd: '/tmp', turnTimeoutMs: 1500 })
      .execute(fakeContext().context, new AbortController().signal)
      .then(() => null)
      .catch((thrown: unknown) => thrown as CliRunError);

    expect(error?.message).toMatch(/still running after/i);
    expect(error?.message).toMatch(/turnTimeoutMs/);
    // The child existed and observed the signal, so the timeout reached the
    // process rather than only abandoning the reader.
    expect(observedSignals(pidFile).length).toBeGreaterThan(0);
    expect(observedSignals(signalFile)).toContain('SIGTERM');
  });

  it('passes the host working directory and its own argv to the child', async () => {
    const captured = recordingSpawn(installFakeCli());
    const engine = claudeEngine({
      spawn: captured.spawn,
      env: { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: fixture('claude-success.jsonl') },
    });

    await run(engine, { cwd: '/tmp', model: 'claude-opus-4-1' });

    expect(captured.calls).toHaveLength(1);
    const call = captured.calls[0];
    expect(call?.command).toBe('claude');
    expect(call?.cwd).toBe('/tmp');
    expect(call?.args.slice(0, 2)).toEqual(['-p', 'do the thing']);
    expect(call?.args).toContain('--output-format');
    expect(call?.args).toContain('stream-json');
    expect(call?.args).toContain('--verbose');
    expect(call?.args).toEqual(expect.arrayContaining(['--model', 'claude-opus-4-1']));
  });

  it('appends engine-specific arguments verbatim', async () => {
    const engine = claudeEngine(replay('claude-success.jsonl'));
    const args = (engine as Engine & { buildArgs: (prompt: string, options: EngineRunOptions) => string[] }).buildArgs(
      'hi',
      { cwd: '/tmp', extraArgs: ['--permission-mode', 'acceptEdits'] },
    );

    expect(args.slice(-2)).toEqual(['--permission-mode', 'acceptEdits']);
  });
});
