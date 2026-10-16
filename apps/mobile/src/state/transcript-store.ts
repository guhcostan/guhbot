/**
 * One open transcript.
 *
 * `open` tails the newest entries; `loadOlder` walks `transcript.page` forward
 * from the start of the history (the host's `afterSeq` is an exclusive lower
 * bound, which is the only paging direction the contract offers) until the
 * page overlaps the tail window. Everything merges by `seq`, so the overlap is
 * a no-op instead of a duplicate, and a reconnect resyncs by asking for
 * everything after the newest seq held.
 */
import type { Entry, EventName, MethodInput, MethodName, MethodOutput } from '@guhbot/protocol';

import { describeError, type Problem } from '../core/errors';
import { applyEvent, mergeEntries, newestSeq, oldestSeq, type TranscriptItem } from '../core/transcript';
import { createStore, type Readable } from './store';

const TAIL_SIZE = 60;
const PAGE_SIZE = 200;

export type TranscriptStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface TranscriptSnapshot {
  readonly agentId: string | null;
  readonly items: readonly TranscriptItem[];
  readonly status: TranscriptStatus;
  readonly loadingOlder: boolean;
  readonly resyncing: boolean;
  /** Highest seq held contiguously from the start of the agent's history. */
  readonly coveredThrough: number;
  /** Oldest seq in the tail window; null while nothing is loaded. */
  readonly windowStart: number | null;
  /** True when entries exist between the start of history and the tail window. */
  readonly canLoadOlder: boolean;
  readonly problem: Problem | null;
}

export interface TranscriptStore extends Readable<TranscriptSnapshot> {
  open(agentId: string): Promise<void>;
  close(): void;
  loadOlder(): Promise<void>;
  /** Re-reads what was missed. Called after the client reconnects. */
  resync(): Promise<void>;
  applyLive(event: EventName, payload: unknown): void;
}

export interface TranscriptStoreDeps {
  readonly request: <M extends MethodName>(method: M, params: MethodInput<M>) => Promise<MethodOutput<M>>;
}

const EMPTY: TranscriptSnapshot = {
  agentId: null,
  items: [],
  status: 'idle',
  loadingOlder: false,
  resyncing: false,
  coveredThrough: -1,
  windowStart: null,
  canLoadOlder: false,
  problem: null,
};

function hasGap(snapshot: TranscriptSnapshot): boolean {
  const start = snapshot.windowStart;
  if (start === null || start <= 0) return false;
  return snapshot.coveredThrough + 1 < start;
}

export function createTranscriptStore(deps: TranscriptStoreDeps): TranscriptStore {
  const store = createStore<TranscriptSnapshot>(EMPTY);

  const patch = (changes: Partial<TranscriptSnapshot>): void => {
    store.update((current) => {
      const next = { ...current, ...changes };
      return { ...next, canLoadOlder: hasGap(next) };
    });
  };

  const open = async (agentId: string): Promise<void> => {
    const current = store.get();
    // Returning to the thread already on screen keeps what has streamed in.
    if (current.agentId === agentId && current.status !== 'idle' && current.status !== 'failed') return;

    store.set({ ...EMPTY, agentId, status: 'loading' });
    try {
      const tail = await deps.request('transcript.tail', { agentId, limit: TAIL_SIZE });
      const items = mergeEntries([], agentId, tail.entries);
      patch({ items, status: 'ready', windowStart: oldestSeq(items), problem: null });
    } catch (error) {
      patch({ status: 'failed', problem: describeError(error) });
    }
  };

  const loadOlder = async (): Promise<void> => {
    const current = store.get();
    const agentId = current.agentId;
    if (agentId === null || current.loadingOlder || !current.canLoadOlder) return;

    patch({ loadingOlder: true });
    try {
      const page = await deps.request('transcript.page', {
        agentId,
        limit: PAGE_SIZE,
        ...(current.coveredThrough < 0 ? {} : { afterSeq: current.coveredThrough }),
      });
      const last = page.entries.at(-1);
      patch({
        items: mergeEntries(store.get().items, agentId, page.entries),
        // `nextCursor` is null on the final page, where `last` is the newest
        // entry of history: that is exactly the highest seq held contiguously
        // from the start, so the cursor advances to it and paging can stop.
        coveredThrough: last === undefined ? current.coveredThrough : Math.max(current.coveredThrough, last.seq),
        loadingOlder: false,
        problem: null,
      });
    } catch (error) {
      patch({ loadingOlder: false, problem: describeError(error) });
    }
  };

  const resync = async (): Promise<void> => {
    const current = store.get();
    const agentId = current.agentId;
    if (agentId === null) return;

    patch({ resyncing: true });
    try {
      const newest = newestSeq(current.items);
      const collected: Entry[] = [];
      if (newest === null) {
        collected.push(...(await deps.request('transcript.tail', { agentId, limit: TAIL_SIZE })).entries);
      } else {
        let cursor: number | undefined = newest;
        // The host only hands out a cursor while the page is full, so this loop
        // ends exactly when the last page has been sent: a gap bigger than one
        // page is recovered by asking again, not by stopping after the first.
        while (cursor !== undefined) {
          const page: MethodOutput<'transcript.page'> = await deps.request('transcript.page', { agentId, afterSeq: cursor, limit: PAGE_SIZE });
          collected.push(...page.entries);
          cursor = page.nextCursor === null ? undefined : Number(page.nextCursor);
        }
      }
      patch({ items: mergeEntries(store.get().items, agentId, collected), resyncing: false, status: 'ready', problem: null });
    } catch (error) {
      patch({ resyncing: false, problem: describeError(error) });
    }
  };

  return {
    get: store.get,
    subscribe: store.subscribe,
    open,
    loadOlder,
    resync,

    close(): void {
      store.set(EMPTY);
    },

    applyLive(event: EventName, payload: unknown): void {
      const current = store.get();
      const agentId = current.agentId;
      if (agentId === null) return;
      const items = applyEvent(current.items, agentId, event, payload);
      // The merge returns the same array when nothing changed, so a foreign or
      // unparsable event costs no render.
      if (items !== current.items) patch({ items });
    },
  };
}
