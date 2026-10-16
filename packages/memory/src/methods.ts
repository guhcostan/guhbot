import type { ContributedMethod } from '@guhbot/host-core';
import { HostError } from '@guhbot/host-core';
import { IdSchema } from '@guhbot/protocol';
import { z } from 'zod';
import type { MemoryStore } from './store.js';
import { MemorySchema } from './types.js';

/**
 * The client-facing half of the capability.
 *
 * Authorization classes, and why:
 *
 *  - `memory.list` is **background**. Reading is what a client does on reconnect,
 *    and the transcript — already `background` — holds more than the memory store
 *    does. A stolen phone can read what the agent noted; it cannot delete it.
 *  - `memory.forget` is **person**. It is the irreversible destruction of durable
 *    state the user accumulated, so it needs a device a human created while
 *    physically present. `memory_forget` (the tool) is the in-run mirror of this
 *    and asks for approval for the same reason.
 *  - `memory.status` is **background** and returns counts only: no fact text ever
 *    crosses the wire on it, so a client can show "42 facts, 12 KiB" unattended.
 */

const ListInput = z.object({
  agentId: IdSchema,
  limit: z.number().int().min(1).max(200).default(50),
  /** Id of the last fact of the previous page. Unknown ids restart from the top. */
  cursor: z.string().min(1).max(128).optional(),
});

const ListOutput = z.object({
  memories: z.array(MemorySchema),
  nextCursor: z.string().nullable(),
});

const ForgetInput = z.object({
  agentId: IdSchema,
  memoryId: z.string().min(1).max(128),
});

const ForgetOutput = z.object({ forgotten: z.boolean() });

const StatusOutput = z.object({
  agents: z.number().int().min(0),
  memories: z.number().int().min(0),
  bytes: z.number().int().min(0),
  caps: z.object({
    maxMemoriesPerAgent: z.number().int().min(1),
    maxBytesPerAgent: z.number().int().min(1),
    maxTextChars: z.number().int().min(1),
  }),
});

export function createMemoryMethods(store: MemoryStore, assertLive: () => void): Record<string, ContributedMethod> {
  return {
    'memory.list': {
      authz: 'background',
      input: ListInput,
      output: ListOutput,
      summary: 'Stored facts for one agent, newest first, with a cursor. Never another agent\'s.',
      handler: async (_host, _session, input) => {
        assertLive();
        const parsed = ListInput.parse(input);
        requireAgent(store, parsed.agentId);
        return store.list(parsed.agentId, {
          limit: parsed.limit,
          cursor: parsed.cursor ?? null,
        });
      },
    },

    'memory.forget': {
      authz: 'person',
      input: ForgetInput,
      output: ForgetOutput,
      summary: 'Delete one stored fact for one agent. Permanent, so it needs human presence.',
      handler: async (_host, _session, input) => {
        assertLive();
        const parsed = ForgetInput.parse(input);
        requireAgent(store, parsed.agentId);
        // An id that belongs to another agent, or to nothing, reports false
        // rather than erroring: the caller cannot tell the two apart, and neither
        // can it delete across agents.
        return { forgotten: store.forget(parsed.agentId, parsed.memoryId) };
      },
    },

    'memory.status': {
      authz: 'background',
      input: z.object({}),
      output: StatusOutput,
      summary: 'How many facts this host holds, in how many bytes, against which caps. No fact text.',
      handler: async () => {
        assertLive();
        return store.counts();
      },
    },
  };
}

function requireAgent(store: MemoryStore, agentId: string): void {
  if (!store.hasAgent(agentId)) throw new HostError('not-found', `no agent ${agentId}`);
}
