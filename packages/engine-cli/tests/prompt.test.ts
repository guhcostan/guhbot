import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '@guhbot/protocol';
import { buildCliPrompt, createCliEngines, createEngineRegistry } from '../src/index.js';
import { cleanupTempDirs, fakeContext, fixture, installFakeCli, recordingSpawn } from './support.js';

/**
 * A CLI engine is one process per turn, so the transcript has to reach the CLI
 * somehow or every follow-up starts a cold session.
 */

function entry(role: Entry['role'], kind: Entry['kind'], content: string, toolName: string | null = null): Entry {
  return { id: `en_${content.length}`, agentId: 'ag_1', seq: 0, runId: 'run_1', role, kind, content, toolName, createdAt: '' };
}

afterEach(() => {
  cleanupTempDirs();
});

describe('prompt building', () => {
  it('passes a first turn through untouched', () => {
    const { context } = fakeContext({ prompt: 'list the files' });

    expect(buildCliPrompt(context)).toBe('list the files');
  });

  it('drops the history entry for the current prompt instead of sending it twice', () => {
    const { context } = fakeContext({
      prompt: 'and the second one?',
      history: [entry('user', 'message', 'list the files'), entry('user', 'message', 'and the second one?')],
    });

    const prompt = buildCliPrompt(context);

    expect(prompt).toContain('user: list the files');
    expect(prompt.match(/and the second one\?/g)).toHaveLength(1);
    expect(prompt).toContain('Current request:\nand the second one?');
  });

  it('renders agent and tool entries so a follow-up has context', () => {
    const { context } = fakeContext({
      prompt: 'now do the same for b.ts',
      history: [
        entry('user', 'message', 'fix the bug in a.ts'),
        entry('agent', 'tool-call', '{"path":"a.ts"}', 'read_file'),
        entry('tool', 'tool-result', 'const x = 1', 'read_file'),
        entry('agent', 'message', 'Fixed a.ts.'),
        entry('user', 'message', 'now do the same for b.ts'),
      ],
    });

    const prompt = buildCliPrompt(context);

    expect(prompt).toContain('user: fix the bug in a.ts');
    expect(prompt).toContain('agent: [called read_file with {"path":"a.ts"}]');
    expect(prompt).toContain('tool: const x = 1');
    expect(prompt).toContain('agent: Fixed a.ts.');
    expect(prompt.indexOf('fix the bug in a.ts')).toBeLessThan(prompt.indexOf('Current request:'));
  });

  it('bounds the transcript it replays', () => {
    const history = [entry('user', 'message', 'x'.repeat(5000)), entry('user', 'message', 'old question'), entry('user', 'message', 'new question')];
    const { context } = fakeContext({ prompt: 'new question', history });

    const prompt = buildCliPrompt(context, 200);

    expect(prompt).toContain('earlier turns omitted');
    expect(prompt.length).toBeLessThan(400);
  });

  it('reaches the CLI as a single argument, transcript included', async () => {
    const captured = recordingSpawn(installFakeCli());
    const engine = createEngineRegistry(
      createCliEngines({
        spawn: captured.spawn,
        env: { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: fixture('claude-success.jsonl') },
      }),
    ).require('claude-code');
    const { context } = fakeContext({
      prompt: 'and now b.ts',
      history: [entry('user', 'message', 'fix a.ts'), entry('user', 'message', 'and now b.ts')],
    });

    await engine.createExecutor({ cwd: '/tmp' }).execute(context, new AbortController().signal);

    const promptArgument = captured.calls[0]?.args[1] ?? '';
    expect(promptArgument).toContain('user: fix a.ts');
    expect(promptArgument).toContain('Current request:\nand now b.ts');
    // One argv element, never interpolated into a shell command line.
    expect(captured.calls[0]?.args.filter((arg) => arg.includes('fix a.ts'))).toHaveLength(1);
  });
});
