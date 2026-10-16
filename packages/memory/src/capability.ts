import type { Capability } from '@guhbot/agent';
import { createMemoryMethods } from './methods.js';
import { createAgentResolver } from './resolve.js';
import { MEMORY_CAPS, MemoryStore, type MemoryStoreSlice } from './store.js';
import { createMemoryTools } from './tools.js';
import type { Memory, MemoryCounts } from './types.js';

/**
 * Agent memory as a capability.
 *
 * A small, durable, agent-scoped store of facts the agent decided were worth
 * keeping, plus ranked recall. It is deliberately not a vector database, not an
 * embedding search and not a second transcript: the value is in the discipline of
 * what gets written, and a store a human can read and disagree with.
 *
 * ```ts
 * let hostRef: Host | undefined;
 * const memory = createMemoryCapability({ store: () => hostRef!.store });
 * const host = new Host({ dataDir, version, mode, extraMethods: memory.methods, capabilities: memory.flags });
 * hostRef = host;
 * ```
 *
 * ## What it contributes
 *
 *  - tools `memory_remember`, `memory_recall`, `memory_forget`,
 *  - methods `memory.list` (background), `memory.forget` (person),
 *    `memory.status` (background, counts only),
 *  - the flag `memory: true`.
 *
 * ## What it does not contribute, and cannot
 *
 * There is no hook for a capability to add a section to a run's system prompt:
 * `Capability` exposes tools, methods and flags, and `AgentLoop.systemPrompt`
 * reads only the host's own lines plus `agent.instructions`. So today recall
 * reaches the model through the `memory_recall` tool and nothing else. The
 * rendering a prompt hook would need is implemented and tested here
 * (`promptSection`), because the missing piece is one line in the loop, not a
 * design question — see the report accompanying this package.
 */
export interface MemoryCapabilityOptions {
  /**
   * The host's store, resolved per call. The host is constructed with this
   * capability's methods already in hand, so it cannot be read at construction
   * time; the application wires this to `() => host.store`.
   */
  store: () => MemoryStoreSlice;
  /**
   * Bind the tools to one agent.
   *
   * Without it the tools resolve the calling agent from the run in flight, and
   * refuse when that is ambiguous — `resolve.ts` documents the order. Binding is
   * the honest option for a host that mounts one capability per agent.
   */
  agentId?: string;
  /** Facts kept per agent. Default 200. */
  maxMemoriesPerAgent?: number;
  /** Serialized bytes kept per agent. Default 65536. */
  maxBytesPerAgent?: number;
  /** Characters allowed in one fact. Default 2000. */
  maxTextChars?: number;
  /** Facts a recall returns when the caller does not ask for a count. Default 5. */
  recallLimit?: number;
  /** Overridable for tests; every timestamp comes from here. */
  now?: () => number;
}

export interface MemoryCapability extends Capability {
  /** Always present: this capability is disposed during host shutdown, never left dangling. */
  readonly dispose: () => Promise<void>;
  /** The store itself, for a host that wants to read memory outside a run. */
  readonly store: MemoryStore;
  /** Ranked recall with the bookkeeping applied. Used by tests and by a prompt hook. */
  recall: (agentId: string, query: string, limit?: number) => Memory[];
  /** The block a run's system prompt should carry, or null when nothing matches. */
  promptSection: (agentId: string, query: string, limit?: number) => string | null;
  /** Counts only, host-wide. */
  counts: () => MemoryCounts;
  /** True once `dispose()` has run. */
  isDisposed: () => boolean;
}

export function createMemoryCapability(options: MemoryCapabilityOptions): MemoryCapability {
  const store = new MemoryStore({
    store: options.store,
    ...(options.maxMemoriesPerAgent !== undefined ? { maxMemoriesPerAgent: options.maxMemoriesPerAgent } : {}),
    ...(options.maxBytesPerAgent !== undefined ? { maxBytesPerAgent: options.maxBytesPerAgent } : {}),
    ...(options.maxTextChars !== undefined ? { maxTextChars: options.maxTextChars } : {}),
    ...(options.recallLimit !== undefined ? { recallLimit: options.recallLimit } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  let disposed = false;
  // A capability's tools and methods are collected at boot and can outlive
  // `dispose()` during shutdown; touching the store after that would write into a
  // closed or replaced host.
  const assertLive = (): void => {
    if (disposed) throw new Error('the memory capability has been disposed');
  };

  // Built once, eagerly: `Capability.methods` is a record, not a factory, and the
  // handlers only resolve the store when a client actually calls one.
  const methods = createMemoryMethods(store, assertLive);
  const tools = createMemoryTools({
    store,
    resolveAgentId: createAgentResolver(store, options.agentId ?? null),
    recallLimit: options.recallLimit ?? MEMORY_CAPS.recallLimit,
    assertLive,
  });

  return {
    name: 'memory',
    summary: 'Lets an agent keep short durable facts about its work and recall them on later runs.',
    flags: { memory: true },
    tools: () => tools,
    methods,
    dispose: async () => {
      // Idempotent by construction: the flag is the entire state, and setting it
      // twice is the same as setting it once.
      disposed = true;
    },
    store,
    recall: (agentId, query, limit) => {
      assertLive();
      return store.recall(agentId, query, limit);
    },
    promptSection: (agentId, query, limit) => {
      assertLive();
      return store.promptSection(agentId, query, limit);
    },
    counts: () => {
      assertLive();
      return store.counts();
    },
    isDisposed: () => disposed,
  };
}
