import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentLoop } from '@guhbot/agent';
import type { ModelEvent, ModelProvider, ModelRequest } from '@guhbot/agent';
import { createMemoryCapability } from '../src/index.js';
import type { MemoryCapability } from '../src/index.js';
import { Clock, FakeSlice, fakeRunContext } from './harness.js';

/**
 * The approval decision, driven through the real agent loop.
 *
 * `memory_remember` must not park an unattended run on a human — "noted for next
 * time" is the whole point and there is nobody there to approve it — while
 * `memory_forget` must. Asserting the flags alone would not prove that: what
 * matters is that the loop, given these tools, actually behaves that way.
 */

const A = 'ag_alpha';
const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guhbot-memory-loop-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A provider that replays a scripted list of turns, like the agent package's own. */
class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted';
  readonly defaultModel = 'scripted-1';
  private turn = 0;

  constructor(private readonly turns: ModelEvent[][]) {}

  async *stream(_request: ModelRequest): AsyncIterable<ModelEvent> {
    const script = this.turns[this.turn] ?? [{ type: 'stop', reason: 'end' } as ModelEvent];
    this.turn += 1;
    for (const event of script) yield event;
  }
}

function callTurn(name: string, callArguments: unknown): ModelEvent[] {
  return [
    {
      type: 'tool-call',
      call: {
        id: `call_${name}`,
        name,
        arguments: callArguments,
        rawArguments: JSON.stringify(callArguments),
        parseError: null,
      },
    },
    { type: 'stop', reason: 'tool-calls' },
  ];
}

function setup(): {
  capability: MemoryCapability;
  slice: FakeSlice;
  loop: (turns: ModelEvent[][]) => AgentLoop;
} {
  const slice = new FakeSlice();
  slice.agents.add(A);
  const clock = new Clock('2026-01-01T00:00:00.000Z');
  const capability = createMemoryCapability({ store: () => slice, agentId: A, now: clock.now });

  return {
    capability,
    slice,
    loop: (turns) =>
      new AgentLoop({
        provider: new ScriptedProvider(turns),
        tools: capability.tools?.() ?? [],
        cwd: freshDir(),
      }),
  };
}

describe('memory tools inside a run', () => {
  it('remembers without asking anyone, and lands the fact in the store', async () => {
    const { capability, loop } = setup();
    const run = fakeRunContext(A);
    const agentLoop = loop([
      callTurn('memory_remember', { text: 'they only sign annual contracts', source: 'user' }),
      [{ type: 'text-delta', text: 'Noted.' }, { type: 'stop', reason: 'end' }],
    ]);

    await agentLoop.execute(run.context, new AbortController().signal);

    expect(run.approvals).toEqual([]);
    expect(run.entries.some((entry) => entry.kind === 'tool-call' && entry.toolName === 'memory_remember')).toBe(true);
    const stored = capability.store.list(A, { limit: 5 }).memories;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ text: 'they only sign annual contracts', source: 'user' });
  });

  it('recalls without asking anyone and returns only this agent\'s facts', async () => {
    const { capability, loop } = setup();
    capability.store.remember(A, { text: 'they only sign annual contracts', source: 'user' });
    capability.store.remember('ag_beta', { text: 'beta kubernetes cluster', source: 'agent' });
    const run = fakeRunContext(A);
    const agentLoop = loop([
      callTurn('memory_recall', { query: 'annual contracts kubernetes' }),
      [{ type: 'text-delta', text: 'Recalled.' }, { type: 'stop', reason: 'end' }],
    ]);

    await agentLoop.execute(run.context, new AbortController().signal);

    expect(run.approvals).toEqual([]);
    const toolResult = run.entries.find((entry) => entry.kind === 'tool-result');
    // The query mentions beta's word ("kubernetes"); alpha's recall must not
    // answer with beta's fact, nor count it.
    const parsed = JSON.parse(toolResult?.content ?? '{}') as { count: number; memories: { text: string }[] };
    expect(parsed.count).toBe(1);
    expect(parsed.memories.map((row) => row.text)).toEqual(['they only sign annual contracts']);
  });

  it('parks on a human before forgetting, and leaves the fact alone when refused', async () => {
    const { capability, loop } = setup();
    const stored = capability.store.remember(A, { text: 'they only sign annual contracts', source: 'user' });
    const run = fakeRunContext(A, { grantApprovals: false });
    const agentLoop = loop([
      callTurn('memory_forget', { memoryId: stored.memory.id }),
      [{ type: 'text-delta', text: 'Understood.' }, { type: 'stop', reason: 'end' }],
    ]);

    await agentLoop.execute(run.context, new AbortController().signal);

    expect(run.approvals).toEqual([{ summary: 'Run memory_forget?', granted: false }]);
    const toolResult = run.entries.find((entry) => entry.kind === 'tool-result');
    expect(toolResult?.content).toContain('did not approve');
    expect(capability.store.list(A, { limit: 5 }).memories).toHaveLength(1);
  });

  it('deletes the fact once a human grants the approval', async () => {
    const { capability, loop } = setup();
    const stored = capability.store.remember(A, { text: 'they only sign annual contracts', source: 'user' });
    const run = fakeRunContext(A, { grantApprovals: true });
    const agentLoop = loop([
      callTurn('memory_forget', { memoryId: stored.memory.id }),
      [{ type: 'text-delta', text: 'Done.' }, { type: 'stop', reason: 'end' }],
    ]);

    await agentLoop.execute(run.context, new AbortController().signal);

    expect(run.approvals).toEqual([{ summary: 'Run memory_forget?', granted: true }]);
    expect(capability.store.list(A, { limit: 5 }).memories).toEqual([]);
  });

  it('reports a tool failure to the model instead of failing the run', async () => {
    const { capability, loop } = setup();
    const run = fakeRunContext(A);
    const agentLoop = loop([
      callTurn('memory_recall', { query: 'annual', limit: 99 }),
      [{ type: 'text-delta', text: 'Retrying is pointless.' }, { type: 'stop', reason: 'end' }],
    ]);

    await agentLoop.execute(run.context, new AbortController().signal);

    const toolResult = run.entries.find((entry) => entry.kind === 'tool-result');
    expect(toolResult?.content).toContain('Error: memory_recall failed');
    expect(toolResult?.content).toContain('"limit" must be an integer');
    // The run kept going: a bad tool call is data for the model, not a failure.
    expect(run.entries.some((entry) => entry.kind === 'message' && entry.content === 'Retrying is pointless.')).toBe(true);
    expect(capability.store.list(A, { limit: 5 }).memories).toEqual([]);
  });
});
