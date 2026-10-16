import type { Entry, EventName } from '@guhbot/protocol';
import { describe, expect, it } from 'vitest';

import {
  applyAppended,
  applyDelta,
  applyEvent,
  isPending,
  itemSeq,
  mergeEntries,
  newestSeq,
  oldestSeq,
  type TranscriptItem,
} from '../src/core/transcript';

const AGENT = 'ag_1';
const RUN = 'run_1';

function entry(seq: number, content = `line ${seq}`, agentId = AGENT): Entry {
  return {
    id: `en_${agentId}_${seq}`,
    agentId,
    seq,
    runId: RUN,
    role: 'agent',
    kind: 'message',
    content,
    toolName: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function appended(seq: number, content?: string, agentId = AGENT): { event: EventName; payload: unknown } {
  return { event: 'transcript.appended', payload: { entry: entry(seq, content ?? `line ${seq}`, agentId) } };
}

function delta(seq: number, textDelta: string, agentId = AGENT): { event: EventName; payload: unknown } {
  return { event: 'transcript.delta', payload: { agentId, runId: RUN, seq, textDelta } };
}

function apply(items: readonly TranscriptItem[], event: { event: EventName; payload: unknown }, agentId = AGENT): readonly TranscriptItem[] {
  return applyEvent(items, agentId, event.event, event.payload);
}

function seqs(items: readonly TranscriptItem[]): number[] {
  return items.map(itemSeq);
}

function textAt(items: readonly TranscriptItem[], seq: number): string | null {
  const item = items.find((candidate) => itemSeq(candidate) === seq);
  if (item === undefined) return null;
  return item.type === 'final' ? item.entry.content : item.text;
}

describe('transcript merge', () => {
  it('keeps appended entries in seq order even when they arrive out of order', () => {
    let items: readonly TranscriptItem[] = [];
    items = apply(items, appended(5));
    items = apply(items, appended(3));
    items = apply(items, appended(4));

    expect(seqs(items)).toEqual([3, 4, 5]);
    expect(items.every((item) => item.type === 'final')).toBe(true);
  });

  it('does not duplicate an entry that arrives twice', () => {
    // Two sources append the same seq: the live event and a page read after a
    // reconnect. Rendering it twice would be a visible bug.
    let items: readonly TranscriptItem[] = [];
    items = apply(items, appended(7, 'once'));
    items = apply(items, appended(7, 'once'));

    expect(seqs(items)).toEqual([7]);
    expect(textAt(items, 7)).toBe('once');
  });

  it('ignores an entry belonging to another agent', () => {
    const items = apply([], appended(1, 'other', 'ag_2'));
    expect(items).toEqual([]);
  });

  it('ignores a payload that does not match the event schema', () => {
    const items = apply([], appended(1));
    expect(apply(items, { event: 'transcript.appended', payload: { entry: { seq: 'nope' } } })).toBe(items);
    expect(apply(items, { event: 'transcript.delta', payload: { seq: 2 } })).toBe(items);
  });

  it('ignores events that are not part of the transcript', () => {
    const items = apply([], appended(1));
    expect(apply(items, { event: 'run.updated', payload: { run: { id: 'r1' } } })).toBe(items);
  });

  it('opens a pending item for a delta whose seq is unknown', () => {
    const items = apply([], delta(4, 'Hel'));

    expect(seqs(items)).toEqual([4]);
    const [first] = items;
    expect(first !== undefined && isPending(first)).toBe(true);
    expect(textAt(items, 4)).toBe('Hel');
  });

  it('appends successive deltas into the same pending item', () => {
    let items = applyDelta([], { agentId: AGENT, runId: RUN, seq: 4, textDelta: 'Hel' });
    items = applyDelta(items, { agentId: AGENT, runId: RUN, seq: 4, textDelta: 'lo' });

    expect(seqs(items)).toEqual([4]);
    expect(textAt(items, 4)).toBe('Hello');
  });

  it('places an out-of-order delta in seq order without touching the other stream', () => {
    let items = applyDelta([], { agentId: AGENT, runId: RUN, seq: 9, textDelta: 'second' });
    items = applyDelta(items, { agentId: AGENT, runId: RUN, seq: 7, textDelta: 'first' });

    expect(seqs(items)).toEqual([7, 9]);
    expect(textAt(items, 7)).toBe('first');
    expect(textAt(items, 9)).toBe('second');
  });

  it('drops a delta for a seq that is already final', () => {
    const items = applyAppended([], entry(3, 'final text'));
    const afterLateDelta = applyDelta(items, { agentId: AGENT, runId: RUN, seq: 3, textDelta: 'late' });

    expect(afterLateDelta).toBe(items);
    expect(textAt(afterLateDelta, 3)).toBe('final text');
  });

  it('replaces the pending text with the finalized entry', () => {
    let items = applyDelta([], { agentId: AGENT, runId: RUN, seq: 3, textDelta: 'hel' });
    items = apply(items, appended(3, 'hello'));

    expect(seqs(items)).toEqual([3]);
    expect(items[0]?.type).toBe('final');
    expect(textAt(items, 3)).toBe('hello');
  });

  it('re-syncs a page from afterSeq without duplicating what is already held', () => {
    // What the tail gave us on open.
    let items = mergeEntries([], AGENT, [entry(5), entry(6), entry(7)]);
    // The resync after a reconnect: the host returns everything after seq 4.
    items = mergeEntries(items, AGENT, [entry(5), entry(6), entry(7), entry(8)]);

    expect(seqs(items)).toEqual([5, 6, 7, 8]);
  });

  it('keeps a stream that a page did not cover, and finalizes the one it did', () => {
    let items = applyDelta([], { agentId: AGENT, runId: RUN, seq: 2, textDelta: 'partial' });
    items = applyDelta(items, { agentId: AGENT, runId: RUN, seq: 4, textDelta: 'still streaming' });
    items = mergeEntries(items, AGENT, [entry(1), entry(2, 'finished')]);

    expect(seqs(items)).toEqual([1, 2, 4]);
    expect(textAt(items, 2)).toBe('finished');
    expect(textAt(items, 4)).toBe('still streaming');
    expect(items.at(-1)?.type).toBe('pending');
  });

  it('ignores page entries that belong to another agent', () => {
    const items = mergeEntries([], AGENT, [entry(1), entry(2, 'other', 'ag_2')]);
    expect(seqs(items)).toEqual([1]);
  });

  it('reports the oldest and newest seq, and nothing for an empty transcript', () => {
    expect(oldestSeq([])).toBeNull();
    expect(newestSeq([])).toBeNull();

    let items = applyDelta([], { agentId: AGENT, runId: RUN, seq: 6, textDelta: 'x' });
    items = apply(items, appended(8));
    items = apply(items, appended(2));

    expect(oldestSeq(items)).toBe(2);
    expect(newestSeq(items)).toBe(8);
  });
});
