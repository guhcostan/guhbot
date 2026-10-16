/**
 * Transcript merge.
 *
 * The wire contract splits a message in two: `transcript.delta` carries
 * streaming text for a `seq` that does not exist as an entry yet, and
 * `transcript.appended` announces the finalized entry. Deltas are explicitly
 * lossy and may arrive out of order, so everything here is keyed on `seq` and
 * the merge is idempotent: re-reading a page that overlaps what the phone
 * already holds must not duplicate a single line.
 */
import { EventPayloads, type Entry, type EventName, type EventPayload } from '@guhbot/protocol';

/** Streaming text for a `seq` whose entry has not been finalized yet. */
export interface PendingEntry {
  readonly type: 'pending';
  readonly agentId: string;
  readonly runId: string | null;
  readonly seq: number;
  readonly text: string;
}

export interface FinalEntry {
  readonly type: 'final';
  readonly entry: Entry;
}

export type TranscriptItem = PendingEntry | FinalEntry;

/** The protocol's own delta shape; never redeclared here. */
export type DeltaPayload = EventPayload<'transcript.delta'>;

export function itemSeq(item: TranscriptItem): number {
  return item.type === 'final' ? item.entry.seq : item.seq;
}

function insertSorted(items: readonly TranscriptItem[], item: TranscriptItem): readonly TranscriptItem[] {
  const next = items.filter((existing) => itemSeq(existing) !== itemSeq(item));
  const at = next.findIndex((existing) => itemSeq(existing) > itemSeq(item));
  if (at < 0) next.push(item);
  else next.splice(at, 0, item);
  return next;
}

export function applyAppended(items: readonly TranscriptItem[], entry: Entry): readonly TranscriptItem[] {
  // Finalizing drops any pending text at the same seq: the entry is the
  // authority, and keeping both would render the same message twice.
  return insertSorted(items, { type: 'final', entry });
}

export function applyDelta(items: readonly TranscriptItem[], delta: DeltaPayload): readonly TranscriptItem[] {
  const existing = items.find((item) => itemSeq(item) === delta.seq);
  // A delta for a finalized seq is stale by definition; reopening it would
  // corrupt a message the user may already have read.
  if (existing?.type === 'final') return items;

  const next: PendingEntry =
    existing === undefined
      ? { type: 'pending', agentId: delta.agentId, runId: delta.runId, seq: delta.seq, text: delta.textDelta }
      : { ...existing, text: existing.text + delta.textDelta };

  // Inserting by seq, not appending, is what keeps an out-of-order delta in the
  // right place in a transcript the user reads top to bottom.
  return insertSorted(items, next);
}

export function mergeEntries(items: readonly TranscriptItem[], agentId: string, entries: readonly Entry[]): readonly TranscriptItem[] {
  let next = items;
  for (const entry of entries) {
    if (entry.agentId !== agentId) continue;
    next = applyAppended(next, entry);
  }
  return next;
}

/** Dispatches an event; unknown payloads and other agents' events are ignored. */
export function applyEvent(items: readonly TranscriptItem[], agentId: string, event: EventName, payload: unknown): readonly TranscriptItem[] {
  if (event === 'transcript.appended') {
    const parsed = EventPayloads['transcript.appended'].safeParse(payload);
    if (!parsed.success || parsed.data.entry.agentId !== agentId) return items;
    return applyAppended(items, parsed.data.entry);
  }

  if (event === 'transcript.delta') {
    const parsed = EventPayloads['transcript.delta'].safeParse(payload);
    if (!parsed.success || parsed.data.agentId !== agentId) return items;
    return applyDelta(items, parsed.data);
  }

  return items;
}

export function newestSeq(items: readonly TranscriptItem[]): number | null {
  const last = items.at(-1);
  return last === undefined ? null : itemSeq(last);
}

export function oldestSeq(items: readonly TranscriptItem[]): number | null {
  const first = items[0];
  return first === undefined ? null : itemSeq(first);
}

/** True while a message is still streaming. */
export function isPending(item: TranscriptItem): item is PendingEntry {
  return item.type === 'pending';
}
