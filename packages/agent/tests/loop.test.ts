import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '@guhbot/protocol';
import type { RunContext } from '@guhbot/host-core';
import { AgentLoop } from '../src/loop.js';
import { builtinTools, resolveInside } from '../src/tools/builtin.js';
import type { ModelEvent, ModelProvider, ModelRequest } from '../src/provider.js';
import type { ToolDefinition } from '../src/types.js';

/**
 * A provider that replays a scripted list of turns.
 *
 * Every turn is a fixed sequence of events, so tests assert on loop behavior
 * without a network call and without a mock framework.
 */
class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted';
  readonly defaultModel = 'scripted-1';
  readonly requests: ModelRequest[] = [];
  private turn = 0;

  constructor(private readonly turns: ModelEvent[][]) {}

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    this.requests.push(request);
    const script = this.turns[this.turn] ?? [{ type: 'stop', reason: 'end' } as ModelEvent];
    this.turn += 1;
    for (const event of script) yield event;
  }
}

/** Capture everything the loop does, without a database. */
function fakeContext(options: { approve?: boolean; cancelAfter?: number } = {}) {
  const entries: { role: Entry['role']; kind: Entry['kind']; content: string; toolName?: string | null }[] = [];
  const deltas: string[] = [];
  const approvals: { summary: string; status: string }[] = [];
  let approvalCount = 0;

  const context: RunContext = {
    run: { id: 'run_1', agentId: 'ag_1', status: 'running', promptEntryId: null, error: null, startedAt: '', endedAt: null },
    agent: {
      id: 'ag_1',
      name: 'Tester',
      status: 'active',
      instructions: 'Be terse.',
      model: null,
      avatarUrl: null,
      hidden: false,
      draftingDisabled: false,
      notifyOnUpdates: true,
      unreadCount: 0,
      createdAt: '',
      updatedAt: '',
    },
    prompt: 'do the thing',
    history: [],
    append: (input) => {
      entries.push({ role: input.role, kind: input.kind, content: input.content, toolName: input.toolName ?? null });
      const entry: Entry = {
        id: `en_${entries.length}`,
        agentId: 'ag_1',
        seq: entries.length - 1,
        runId: 'run_1',
        role: input.role,
        kind: input.kind,
        content: input.content,
        toolName: input.toolName ?? null,
        createdAt: '',
      };
      return entry;
    },
    emitDelta: (_seq, text) => {
      deltas.push(text);
    },
    readSecret: () => null,
    requestApproval: async (input) => {
      approvalCount += 1;
      const granted = options.approve ?? false;
      approvals.push({ summary: input.summary, status: granted ? 'granted' : 'denied' });
      return {
        id: 'ap_1',
        agentId: 'ag_1',
        runId: 'run_1',
        kind: 'tool-permission',
        status: granted ? 'granted' : 'denied',
        summary: input.summary,
        detail: '{}',
        createdAt: '',
        expiresAt: null,
        resolvedAt: null,
        resolutionNote: null,
      };
    },
    isCancelled: () => options.cancelAfter !== undefined && approvalCount >= options.cancelAfter,
  };

  return { context, entries, deltas, approvals };
}

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo text back.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  requiresApproval: false,
  execute: async (args) => `echo:${(args as { text: string }).text}`,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guhbot-agent-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('agent loop', () => {
  it('writes one agent entry for a plain text answer', async () => {
    const provider = new ScriptedProvider([[{ type: 'text-delta', text: 'Done.' }, { type: 'stop', reason: 'end' }]]);
    const loop = new AgentLoop({ provider, tools: [], cwd: dir });
    const { context, entries, deltas } = fakeContext();

    await loop.execute(context, new AbortController().signal);

    expect(entries).toEqual([{ role: 'agent', kind: 'message', content: 'Done.', toolName: null }]);
    expect(deltas.join('')).toBe('Done.');
    expect(provider.requests).toHaveLength(1);
  });

  it('runs a tool, records both sides, and feeds the result back', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', call: { id: 'c1', name: 'echo', arguments: { text: 'hi' }, rawArguments: '{"text":"hi"}', parseError: null } },
        { type: 'stop', reason: 'tool-calls' },
      ],
      [{ type: 'text-delta', text: 'I echoed it.' }, { type: 'stop', reason: 'end' }],
    ]);
    const loop = new AgentLoop({ provider, tools: [echoTool], cwd: dir });
    const { context, entries } = fakeContext();

    await loop.execute(context, new AbortController().signal);

    expect(entries.map((e) => e.kind)).toEqual(['tool-call', 'tool-result', 'message']);
    expect(entries[1]?.content).toBe('echo:hi');
    expect(provider.requests).toHaveLength(2);
    // The second request must carry the assistant tool_calls plus the tool result,
    // otherwise providers reject the conversation.
    const second = provider.requests[1]!;
    expect(second.messages.some((m) => m.role === 'assistant' && m.toolCalls?.length === 1)).toBe(true);
    expect(second.messages.some((m) => m.role === 'tool' && m.toolCallId === 'c1')).toBe(true);
  });

  it('parks the run on approval and tells the model when it is refused', async () => {
    const guarded: ToolDefinition = { ...echoTool, requiresApproval: true };
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', call: { id: 'c1', name: 'echo', arguments: { text: 'x' }, rawArguments: '{"text":"x"}', parseError: null } },
        { type: 'stop', reason: 'tool-calls' },
      ],
      [{ type: 'text-delta', text: 'Understood.' }, { type: 'stop', reason: 'end' }],
    ]);
    const loop = new AgentLoop({ provider, tools: [guarded], cwd: dir });
    const { context, entries, approvals } = fakeContext({ approve: false });

    await loop.execute(context, new AbortController().signal);

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.summary).toBe('Run echo?');
    const toolResult = entries.find((e) => e.kind === 'tool-result');
    expect(toolResult?.content).toMatch(/Refused/);
    expect(toolResult?.content).toMatch(/Do not retry/);
  });

  it('runs the tool when approval is granted', async () => {
    const guarded: ToolDefinition = { ...echoTool, requiresApproval: true };
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', call: { id: 'c1', name: 'echo', arguments: { text: 'y' }, rawArguments: '{"text":"y"}', parseError: null } },
        { type: 'stop', reason: 'tool-calls' },
      ],
      [{ type: 'stop', reason: 'end' }],
    ]);
    const loop = new AgentLoop({ provider, tools: [guarded], cwd: dir });
    const { context, entries } = fakeContext({ approve: true });

    await loop.execute(context, new AbortController().signal);
    expect(entries.find((e) => e.kind === 'tool-result')?.content).toBe('echo:y');
  });

  it('returns an error result for an unknown tool instead of failing the run', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', call: { id: 'c1', name: 'nope', arguments: {}, rawArguments: '{}', parseError: null } },
        { type: 'stop', reason: 'tool-calls' },
      ],
      [{ type: 'text-delta', text: 'ok' }, { type: 'stop', reason: 'end' }],
    ]);
    const loop = new AgentLoop({ provider, tools: [echoTool], cwd: dir });
    const { context, entries } = fakeContext();

    await loop.execute(context, new AbortController().signal);
    expect(entries.find((e) => e.kind === 'tool-result')?.content).toMatch(/no tool named "nope"/);
    expect(entries.find((e) => e.kind === 'tool-result')?.content).toMatch(/Available tools: echo/);
  });

  it('rejects malformed tool arguments without invoking the tool', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', call: { id: 'c1', name: 'echo', arguments: {}, rawArguments: '{oops', parseError: 'Unexpected token o' } },
        { type: 'stop', reason: 'tool-calls' },
      ],
      [{ type: 'stop', reason: 'end' }],
    ]);
    const loop = new AgentLoop({ provider, tools: [echoTool], cwd: dir });
    const { context, entries } = fakeContext();

    await loop.execute(context, new AbortController().signal);
    expect(entries.find((e) => e.kind === 'tool-result')?.content).toMatch(/not valid JSON/);
  });

  it('stops at maxTurns and records why', async () => {
    const infinite = new ScriptedProvider(
      Array.from({ length: 10 }, () => [
        { type: 'tool-call', call: { id: 'c', name: 'echo', arguments: { text: 'x' }, rawArguments: '{"text":"x"}', parseError: null } } as ModelEvent,
        { type: 'stop', reason: 'tool-calls' } as ModelEvent,
      ]),
    );
    const loop = new AgentLoop({ provider: infinite, tools: [echoTool], cwd: dir, maxTurns: 3 });
    const { context, entries } = fakeContext();

    await loop.execute(context, new AbortController().signal);
    expect(entries.filter((e) => e.kind === 'tool-call')).toHaveLength(3);
    expect(entries.at(-1)?.content).toMatch(/Stopped after 3 turns/);
  });

  it('stops at maxToolCalls', async () => {
    const many = new ScriptedProvider([
      [
        { type: 'tool-call', call: { id: 'a', name: 'echo', arguments: { text: '1' }, rawArguments: '{"text":"1"}', parseError: null } },
        { type: 'tool-call', call: { id: 'b', name: 'echo', arguments: { text: '2' }, rawArguments: '{"text":"2"}', parseError: null } },
        { type: 'stop', reason: 'tool-calls' },
      ],
    ]);
    const loop = new AgentLoop({ provider: many, tools: [echoTool], cwd: dir, maxToolCalls: 1 });
    const { context, entries } = fakeContext();

    await loop.execute(context, new AbortController().signal);
    expect(entries.filter((e) => e.kind === 'tool-result')).toHaveLength(1);
    expect(entries.at(-1)?.content).toMatch(/max-tool-calls/);
  });

  it('surfaces a provider error as a system error entry and fails the run', async () => {
    const failing: ModelProvider = {
      id: 'failing',
      defaultModel: 'x',
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('boom');
      },
    };
    const loop = new AgentLoop({ provider: failing, tools: [], cwd: dir });
    const { context, entries } = fakeContext();

    await expect(loop.execute(context, new AbortController().signal)).rejects.toThrow(/boom/);
    expect(entries.at(-1)?.kind).toBe('error');
  });

  it('carries reasoning into the next turn but not into the transcript', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'reasoning-delta', text: 'I need to echo.' },
        { type: 'tool-call', call: { id: 'c1', name: 'echo', arguments: { text: 'hi' }, rawArguments: '{"text":"hi"}', parseError: null } },
        { type: 'stop', reason: 'tool-calls' },
      ],
      [{ type: 'text-delta', text: 'done' }, { type: 'stop', reason: 'end' }],
    ]);
    const loop = new AgentLoop({ provider, tools: [echoTool], cwd: dir });
    const { context, entries } = fakeContext();

    await loop.execute(context, new AbortController().signal);

    // Handed back to the provider so a reasoning model accepts the follow-up…
    const second = provider.requests[1]!;
    const assistant = second.messages.find((m) => m.role === 'assistant' && m.toolCalls !== undefined);
    expect(assistant?.reasoning).toBe('I need to echo.');

    // …but never shown to the user or persisted.
    expect(entries.every((e) => !e.content.includes('I need to echo'))).toBe(true);
  });

  it('includes agent instructions in the system prompt', async () => {
    const provider = new ScriptedProvider([[{ type: 'stop', reason: 'end' }]]);
    const loop = new AgentLoop({ provider, tools: [], cwd: dir });
    const { context } = fakeContext();
    await loop.execute(context, new AbortController().signal);
    expect(provider.requests[0]?.system).toContain('Be terse.');
  });
});

describe('path jailing', () => {
  it('allows paths inside the root', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    await expect(resolveInside(dir, 'a.txt')).resolves.toBe(join(dir, 'a.txt'));
  });

  it('refuses traversal out of the root', async () => {
    await expect(resolveInside(dir, '../../etc/passwd')).rejects.toThrow(/escapes the working directory/);
    await expect(resolveInside(dir, '../sibling')).rejects.toThrow(/escapes the working directory/);
  });

  it('refuses an absolute path outside the root', async () => {
    await expect(resolveInside(dir, '/etc/passwd')).rejects.toThrow(/escapes the working directory/);
  });

  it('allows a path inside a directory that does not exist yet', async () => {
    // Regression: a working directory that has not been created yet made the
    // canonical walk climb past the jail root and reject a legal path, which
    // broke an agent writing its very first file.
    const nested = join(dir, 'fresh-workspace');
    await expect(resolveInside(nested, 'notes/todo.md')).resolves.toBe(join(nested, 'notes', 'todo.md'));
    await expect(resolveInside(nested, 'a/b/c/d.txt')).resolves.toBe(join(nested, 'a', 'b', 'c', 'd.txt'));
  });

  it('still refuses a symlink that points outside the root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'guhbot-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(dir, 'link'));
    await expect(resolveInside(dir, 'link/secret.txt')).rejects.toThrow(/outside the working directory/);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('builtin tools', () => {
  it('refuses to read outside the working directory', async () => {
    const tools = builtinTools();
    const readTool = tools.find((t) => t.name === 'read_file')!;
    await expect(
      readTool.execute({ path: '../../../etc/passwd' }, { cwd: dir, readSecret: () => null, signal: new AbortController().signal, note: () => {} }),
    ).rejects.toThrow(/escapes the working directory/);
  });

  it('reads a file inside the working directory', async () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'note.txt'), 'content-here');
    const readTool = builtinTools().find((t) => t.name === 'read_file')!;
    const out = await readTool.execute({ path: 'sub/note.txt' }, { cwd: dir, readSecret: () => null, signal: new AbortController().signal, note: () => {} });
    expect(out).toBe('content-here');
  });

  it('truncates a large file and says so', async () => {
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(500));
    const readTool = builtinTools().find((t) => t.name === 'read_file')!;
    const out = await readTool.execute({ path: 'big.txt', max_bytes: 10 }, { cwd: dir, readSecret: () => null, signal: new AbortController().signal, note: () => {} });
    expect(out).toContain('truncated');
    expect(out.startsWith('xxxxxxxxxx')).toBe(true);
  });

  it('denies commands on the deny list', async () => {
    const runTool = builtinTools().find((t) => t.name === 'run_command')!;
    await expect(
      runTool.execute({ program: 'sudo', args: ['rm', '-rf', '/'] }, { cwd: dir, readSecret: () => null, signal: new AbortController().signal, note: () => {} }),
    ).rejects.toThrow(/deny list/);
  });

  it('rejects a program given as a path', async () => {
    const runTool = builtinTools().find((t) => t.name === 'run_command')!;
    await expect(
      runTool.execute({ program: '/bin/sh', args: [] }, { cwd: dir, readSecret: () => null, signal: new AbortController().signal, note: () => {} }),
    ).rejects.toThrow(/bare executable name/);
  });

  it('passes arguments without a shell so metacharacters stay literal', async () => {
    const runTool = builtinTools().find((t) => t.name === 'run_command')!;
    const out = await runTool.execute({ program: 'echo', args: ['a; rm -rf /', '$(whoami)'] }, { cwd: dir, readSecret: () => null, signal: new AbortController().signal, note: () => {} });
    expect(out).toContain('$(whoami)');
    expect(out).toContain('a; rm -rf /');
  });

  it('marks mutating tools as requiring approval and read-only tools as not', () => {
    const tools = builtinTools();
    const byName = new Map(tools.map((t) => [t.name, t.requiresApproval]));
    expect(byName.get('read_file')).toBe(false);
    expect(byName.get('list_dir')).toBe(false);
    expect(byName.get('search_files')).toBe(false);
    expect(byName.get('write_file')).toBe(true);
    expect(byName.get('run_command')).toBe(true);
  });

  it('denies egress to a host not on the allow list', async () => {
    const fetchTool = builtinTools({ allowedHosts: ['example.com'] }).find((t) => t.name === 'http_fetch')!;
    await expect(
      fetchTool.execute({ url: 'https://evil.test/x' }, { cwd: dir, readSecret: () => null, signal: new AbortController().signal, note: () => {} }),
    ).rejects.toThrow(/egress allow list/);
  });

  it('denies all egress when no allow list is configured', async () => {
    const fetchTool = builtinTools().find((t) => t.name === 'http_fetch')!;
    await expect(
      fetchTool.execute({ url: 'https://example.com' }, { cwd: dir, readSecret: () => null, signal: new AbortController().signal, note: () => {} }),
    ).rejects.toThrow(/none are configured/);
  });

  it('rejects non-http schemes', async () => {
    const fetchTool = builtinTools({ allowedHosts: ['example.com'] }).find((t) => t.name === 'http_fetch')!;
    await expect(
      fetchTool.execute({ url: 'file:///etc/passwd' }, { cwd: dir, readSecret: () => null, signal: new AbortController().signal, note: () => {} }),
    ).rejects.toThrow(/only http and https/);
  });
});
