/**
 * @guhbot/memory — what an agent decided was worth remembering.
 *
 * A small, durable, agent-scoped store of short facts plus ranked recall. No
 * embeddings, no network, no second transcript: a fact is one sentence a human
 * can read and disagree with, attributed to whoever established it.
 *
 * ```ts
 * let hostRef: Host | undefined;
 * const memory = createMemoryCapability({
 *   // The host is built with this capability's methods already in hand, so the
 *   // store is resolved lazily.
 *   store: () => hostRef!.store,
 * });
 * ```
 *
 * Tools: `memory_remember`, `memory_recall`, `memory_forget`.
 * Methods: `memory.list` (background), `memory.forget` (person), `memory.status`
 * (background, counts only). Flag: `memory: true`.
 *
 * Two things worth knowing before wiring it:
 *
 *  - **The tools cannot see which agent is calling them.** `ToolExecutionContext`
 *    has no agent identity, so `resolve.ts` documents a resolution ladder that
 *    refuses rather than guesses; pass `agentId` to bind it exactly.
 *  - **No capability can add a system-prompt section yet.** Recall therefore
 *    reaches the model through the `memory_recall` tool. `promptSection()` is the
 *    rendering a future prompt hook needs, implemented and tested.
 */

export { createMemoryCapability } from './capability.js';
export type { MemoryCapability, MemoryCapabilityOptions } from './capability.js';
export { MEMORY_CAPS, MemoryStore, newMemoryId } from './store.js';
export type { MemoryStoreOptions, MemoryStoreSlice } from './store.js';
export { createMemoryMethods } from './methods.js';
export { createAgentResolver } from './resolve.js';
export { createMemoryTools } from './tools.js';
export type { MemoryToolOptions } from './tools.js';
export { contentTokens, isSubsumedBy, normalizeForCompare, overlapScore, rankMemories } from './rank.js';
export { MAX_MEMORY_TEXT_CHARS, MemorySchema, MemorySourceSchema } from './types.js';
export type { Memory, MemoryCounts, MemorySource, RememberResult } from './types.js';
