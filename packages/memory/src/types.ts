import { IdSchema, TimestampSchema } from '@guhbot/protocol';
import { z } from 'zod';

/**
 * The memory vocabulary.
 *
 * A memory is one short fact the agent decided was worth keeping: "they only
 * sign annual contracts", "the staging deploy needs a VPN". It is not a
 * transcript entry, not a document and not an embedding — the whole value is
 * that a human can read the list and disagree with it.
 */

/**
 * Where a fact came from.
 *
 * The distinction is the point of the field: a fact the user stated is
 * authoritative, a fact the agent inferred is a hypothesis, and a fact a run
 * produced is an observation. `agent` is the default because it is the weakest
 * claim — a caller that does not say "the user said this" must not be recorded
 * as if it did.
 */
export const MemorySourceSchema = z.enum(['agent', 'user', 'run']);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

/**
 * The hard bound one fact may reach, enforced by `MemorySchema`. The capability's
 * default is lower (`MEMORY_CAPS.maxTextChars`); this is the ceiling a
 * configuration may raise it to before the method output schema would reject it.
 */
export const MAX_MEMORY_TEXT_CHARS = 4_000;

export const MemorySchema = z.object({
  id: z.string().min(1).max(128),
  /** Owner. Stored inside the row as well as in the key so a leaked row is self-describing. */
  agentId: IdSchema,
  text: z.string().min(1).max(MAX_MEMORY_TEXT_CHARS),
  source: MemorySourceSchema,
  createdAt: TimestampSchema,
  /** Null until the fact has reached a model, through recall or a prompt section. */
  lastUsedAt: TimestampSchema.nullable(),
  useCount: z.number().int().min(0),
});

export type Memory = z.infer<typeof MemorySchema>;

/** What one write did, so the caller can see what it replaced instead of guessing. */
export interface RememberResult {
  memory: Memory;
  /** Facts this write removed: named by `supersedes`, or subsumed by a user correction. */
  superseded: Memory[];
  /** Facts pushed out by the caps. Never includes the memory just written. */
  evicted: Memory[];
}

export interface MemoryCounts {
  /** Agents with at least one stored fact. */
  agents: number;
  memories: number;
  /**
   * UTF-8 bytes of stored fact text, the unit `maxBytesPerAgent` is stated in.
   * The stored row also carries a fixed envelope (id, timestamps, counters),
   * which the count cap bounds at roughly 250 bytes per fact.
   */
  bytes: number;
  caps: {
    maxMemoriesPerAgent: number;
    maxBytesPerAgent: number;
    maxTextChars: number;
  };
}
