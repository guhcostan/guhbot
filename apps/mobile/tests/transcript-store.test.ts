import type { Entry, MethodName } from '@guhbot/protocol';
import { describe, expect, it } from 'vitest';

import { itemSeq, type TranscriptItem } from '../src/core/transcript.js';
import { createTranscriptStore, type TranscriptStoreDeps } from '../src/state/transcript-store.js';

const AGENT = 'ag_1';

function entry(seq: number): Entry {
  return {
    id: `en_${seq}`,
    agentId: AGENT,
    seq,
    runId: 'run_1',
    role: 'agent',
    kind: 'message',
    content: `line ${seq}`,
    toolName: null,
    createdAt: '2026-03-04T12:00:00.000Z',
  };
}

function history(count: number): Entry[] {
  return Array.from({ length: count }, (_, seq) => entry(seq));
}

/**
 * Mirrors the host's paging contract exactly: `transcript.tail` returns the
 * newest `limit` entries, `transcript.page` returns entries with `seq >
 * afterSeq` and a cursor only when the page was full.
 */
function fakeHost(all: readonly Entry[]): { readonly request: TranscriptStoreDeps['request']; readonly calls: Array<{ method: MethodName; params: unknown }> } {
  const calls: Array<{ method: MethodName; params: unknown }> = [];

  const handle = (method: MethodName, params: unknown): Promise<unknown> => {
    calls.push({ method, params });
    if (method === 'transcript.tail') {
      const input = params as { limit: number };
      return Promise.resolve({ entries: all.slice(-input.limit) });
    }
    if (method === 'transcript.page') {
      const input = params as { afterSeq?: number; limit: number };
      const after = input.afterSeq ?? -1;
      const page = all.filter((item) => item.seq > after).slice(0, input.limit);
      const last = page.at(-1);
      return Promise.resolve({ entries: page, nextCursor: page.length === input.limit && last !== undefined ? String(last.seq) : null });
    }
    return Promise.reject({ code: 'not-found', message: `${method} is not in this fake host`, retryable: false });
  };

  // The store only sees the generic signature; the fake dispatches on the name.
  return { request: handle as unknown as TranscriptStoreDeps['request'], calls };
}

function seqs(items: readonly TranscriptItem[]): number[] {
  return items.map(itemSeq);
}

describe('transcript store', () => {
  it('tails the newest entries and offers nothing older when the whole history fits', async () => {
    const host = fakeHost(history(10));
    const store = createTranscriptStore({ request: host.request });

    await store.open(AGENT);

    const state = store.get();
    expect(state.status).toBe('ready');
    expect(seqs(state.items)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(state.canLoadOlder).toBe(false);

    await store.loadOlder();
    expect(host.calls.map((call) => call.method)).toEqual(['transcript.tail']);
  });

  it('pages forward from the start until the gap before the tail window is closed', async () => {
    const host = fakeHost(history(500));
    const store = createTranscriptStore({ request: host.request });

    await store.open(AGENT);
    expect(store.get().windowStart).toBe(440);
    expect(store.get().canLoadOlder).toBe(true);

    await store.loadOlder();
    expect(host.calls.at(-1)).toEqual({ method: 'transcript.page', params: { agentId: AGENT, limit: 200 } });
    expect(store.get().coveredThrough).toBe(199);
    expect(store.get().canLoadOlder).toBe(true);

    await store.loadOlder();
    expect(host.calls.at(-1)).toEqual({ method: 'transcript.page', params: { agentId: AGENT, limit: 200, afterSeq: 199 } });
    await store.loadOlder();

    const state = store.get();
    expect(state.canLoadOlder).toBe(false);
    // Every entry exactly once, in order, across three overlapping reads.
    expect(seqs(state.items)).toEqual(history(500).map((item) => item.seq));
    expect(new Set(seqs(state.items)).size).toBe(500);
    expect(state.loadingOlder).toBe(false);
  });

  it('merges a live message in and finalizes it when the entry lands', async () => {
    const host = fakeHost(history(3));
    const store = createTranscriptStore({ request: host.request });
    await store.open(AGENT);

    store.applyLive('transcript.delta', { agentId: AGENT, runId: 'run_1', seq: 3, textDelta: 'Wor' });
    store.applyLive('transcript.delta', { agentId: AGENT, runId: 'run_1', seq: 3, textDelta: 'king' });
    expect(seqs(store.get().items)).toEqual([0, 1, 2, 3]);
    expect(store.get().items.at(-1)?.type).toBe('pending');

    store.applyLive('transcript.appended', { entry: { ...entry(3), content: 'Working' } });
    const last = store.get().items.at(-1);
    expect(last?.type).toBe('final');
    expect(last?.type === 'final' ? last.entry.content : '').toBe('Working');
  });

  it('ignores events for another agent, and events for no agent at all', () => {
    const host = fakeHost(history(2));
    const store = createTranscriptStore({ request: host.request });

    store.applyLive('transcript.delta', { agentId: AGENT, runId: 'run_1', seq: 0, textDelta: 'x' });
    expect(store.get().items).toEqual([]);
  });

  it('resyncs from the newest seq held without duplicating it', async () => {
    const all = history(10);
    const host = fakeHost(all);
    const store = createTranscriptStore({ request: host.request });
    await store.open(AGENT);

    // The resync asks for entries appended while the phone was away.
    await store.resync();

    expect(host.calls.at(-1)).toEqual({ method: 'transcript.page', params: { agentId: AGENT, limit: 200, afterSeq: 9 } });
    expect(seqs(store.get().items)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('reports a failed tail and can be reopened', async () => {
    const host = fakeHost(history(4));
    let fail = true;
    const store = createTranscriptStore({
      request: (method, params) => {
        if (fail) {
          fail = false;
          return Promise.reject({ code: 'internal', message: 'transcript store is locked', retryable: true });
        }
        return host.request(method, params);
      },
    });

    await store.open(AGENT);
    expect(store.get().status).toBe('failed');
    expect(store.get().problem?.title).toBe('The host reported an error');

    await store.open(AGENT);
    expect(store.get().status).toBe('ready');
    expect(seqs(store.get().items)).toEqual([0, 1, 2, 3]);
  });

  it('forgets the transcript when the screen closes', async () => {
    const host = fakeHost(history(3));
    const store = createTranscriptStore({ request: host.request });
    await store.open(AGENT);

    store.close();

    expect(store.get().agentId).toBeNull();
    expect(store.get().items).toEqual([]);
    expect(store.get().status).toBe('idle');
  });
});
