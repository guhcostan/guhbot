import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '@guhbot/agent';
import { createCliEngines, createEngineRegistry, expandTemplate, type ExecEngineTemplate } from '../src/index.js';
import { cleanupTempDirs, fakeContext, fixture, installFakeCli } from './support.js';

/**
 * The generic engine is what keeps this package extensible without a code change
 * per tool: a template plus one of the known dialects, or plain lines.
 */

function execEngine(template: ExecEngineTemplate, env: Record<string, string>): Engine {
  return createEngineRegistry(createCliEngines({ exec: [template], env })).require(template.id);
}

afterEach(() => {
  cleanupTempDirs();
});

describe('generic exec engine', () => {
  it('refuses a template that would never receive the prompt', () => {
    expect(() =>
      createCliEngines({
        exec: [{ id: 'broken', name: 'Broken', requirement: 'x', command: 'true', args: ['--print'] }],
      }),
    ).toThrow(/no \{prompt\} placeholder/);
  });

  it('drops --model together with an absent model, rather than leaving a dangling flag', () => {
    expect(expandTemplate(['run', '--model', '{model}', '{prompt}'], 'hi', { cwd: '/work' })).toEqual(['run', 'hi']);
    expect(expandTemplate(['run', '--model', '{model}', '{prompt}'], 'hi', { cwd: '/work', model: 'm-1' })).toEqual([
      'run',
      '--model',
      'm-1',
      'hi',
    ]);
    expect(expandTemplate(['{prompt}'], 'hi', { cwd: '/work', extraArgs: ['--verbose'] })).toEqual(['hi', '--verbose']);
  });

  it('drives any tool that speaks a known dialect', async () => {
    const engine = execEngine(
      {
        id: 'my-agent',
        name: 'My Agent',
        requirement: 'a wrapper script on PATH',
        command: installFakeCli(),
        args: ['--prompt', '{prompt}'],
        format: 'claude-stream-json',
      },
      { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: fixture('claude-success.jsonl') },
    );

    const recorded = fakeContext();
    await engine.createExecutor({ cwd: '/tmp' }).execute(recorded.context, new AbortController().signal);

    expect(recorded.deltas.map((delta) => delta.text).join('')).toBe('Hello from Claude Code.');
  });

  it('falls back to plain lines when there is no JSON to parse', async () => {
    const engine = execEngine(
      {
        id: 'plain',
        name: 'Plain',
        requirement: 'a script that prints prose',
        command: installFakeCli(),
        args: ['{prompt}'],
      },
      { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: fixture('plain.txt') },
    );

    const recorded = fakeContext();
    await engine.createExecutor({ cwd: '/tmp' }).execute(recorded.context, new AbortController().signal);

    expect(recorded.deltas.map((delta) => delta.text).join('')).toBe('first line\nsecond line\n');
    expect(recorded.entries.find((entry) => entry.kind === 'message')?.content).toBe('first line\nsecond line\n');
  });

  it('keeps a template engine out of the way of the built-in ids', () => {
    const engines = createCliEngines({
      exec: [{ id: 'my-agent', name: 'My Agent', requirement: 'x', command: 'true', args: ['{prompt}'] }],
    });

    expect(engines.map((engine) => engine.id)).toEqual(['claude-code', 'codex', 'opencode', 'my-agent']);
  });
});
