/**
 * Server-pushed events.
 *
 * Events are the streaming half of the contract and are strictly advisory:
 * a client that misses one must be able to recover by re-reading the relevant
 * query. That property is what lets a phone drop off the network mid-run and
 * resync, and it means we never have to guarantee at-least-once delivery of a
 * delta. Concretely: `transcript.delta` is lossy, `transcript.appended` is
 * recoverable via `transcript.page` using `afterSeq`.
 */
import { z } from 'zod';
import { AgentSchema, ApprovalSchema, EntrySchema, RunSchema, TaskSchema } from './entities.js';

export const EVENT_NAMES = [
  'transcript.appended',
  'transcript.delta',
  'run.updated',
  'approval.requested',
  'approval.resolved',
  'agent.updated',
  'task.updated',
  'host.shutdown',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export const EventPayloads = {
  /** A finalized entry exists. Recoverable: re-query after `entry.seq - 1`. */
  'transcript.appended': z.object({ entry: EntrySchema }),

  /**
   * Ephemeral streaming text for a not-yet-finalized agent message. Carries the
   * `seq` the entry will eventually occupy so a client can render it in place.
   */
  'transcript.delta': z.object({
    agentId: z.string(),
    runId: z.string(),
    seq: z.number().int().min(0),
    /** Appended to whatever the client already has for this seq. */
    textDelta: z.string(),
  }),

  'run.updated': z.object({ run: RunSchema }),
  'approval.requested': z.object({ approval: ApprovalSchema }),
  'approval.resolved': z.object({ approval: ApprovalSchema }),
  'agent.updated': z.object({ agent: AgentSchema }),
  'task.updated': z.object({ task: TaskSchema }),
  'host.shutdown': z.object({ reason: z.string().max(2000) }),
} as const satisfies Record<EventName, z.ZodTypeAny>;

export type EventPayload<E extends EventName> = z.infer<(typeof EventPayloads)[E]>;

/** Validate an outgoing payload against its event name. */
export function encodeEvent<E extends EventName>(event: E, payload: EventPayload<E>): { event: E; payload: EventPayload<E> } {
  const parsed = EventPayloads[event].safeParse(payload);
  if (!parsed.success) {
    throw new Error(`refusing to emit malformed ${event}: ${parsed.error.message}`);
  }
  return { event, payload: parsed.data as EventPayload<E> };
}
