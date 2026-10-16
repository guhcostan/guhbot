import type { ContributedMethod } from '@guhbot/host-core';
import { z } from 'zod';
import type { AllowList } from './allow-list.js';
import type { ChatDatabase } from './chat-db.js';

/**
 * Client-facing configuration and diagnostics.
 *
 * Reads and sends belong to the model, through tools; these methods exist so a
 * client can answer "can this host message people, who is it allowed to talk to,
 * and why is it not working". The allow list is the security boundary, so
 * changing it is `person`: a background device must not be able to widen who the
 * agent may message, or read back who the user talks to.
 */

export interface MessagesMethodsDeps {
  readonly allowList: AllowList;
  readonly database: ChatDatabase;
  readonly supported: boolean;
  readonly platform: NodeJS.Platform;
  readonly enabled: () => boolean;
  readonly reason: () => string | null;
  readonly lastError: () => string | null;
  /** Hand the new list to whoever persists it; never writes from here. */
  readonly persist: (entries: readonly string[]) => void;
}

const StatusInput = z.object({
  /** Read the schema and permission state from disk. Returns no message content. */
  probe: z.boolean().default(false),
});

const SchemaReport = z.object({
  ok: z.boolean(),
  requiredMissing: z.array(z.string()),
  missingTables: z.array(z.string()),
  missingColumns: z.array(z.string()),
  effects: z.array(z.string()),
});

const StatusOutput = z.object({
  supported: z.boolean(),
  enabled: z.boolean(),
  reason: z.string().nullable(),
  allowedCount: z.number().int().min(0),
  databasePath: z.string(),
  readOnly: z.boolean(),
  fullDiskAccessRequired: z.boolean(),
  lastError: z.string().nullable(),
  schema: SchemaReport.nullable(),
});

const ListOutput = z.object({ allowed: z.array(z.string()) });
const MutateInput = z.object({ entry: z.string().min(1).max(256) });
const AddOutput = z.object({ allowed: z.array(z.string()), added: z.boolean() });
const RemoveOutput = z.object({ allowed: z.array(z.string()), removed: z.boolean() });

export function buildMessagesMethods(deps: MessagesMethodsDeps): Record<string, ContributedMethod> {
  return {
    'messages.status': {
      authz: 'background',
      input: StatusInput,
      output: StatusOutput,
      summary: 'Whether this host can read or send Messages, what it is allowed to touch, and why not.',
      handler: async (_host, _session, input: z.infer<typeof StatusInput>) => {
        const schema = input.probe && deps.supported ? probeSchema(deps) : null;
        return {
          supported: deps.supported,
          enabled: deps.enabled(),
          reason: deps.reason(),
          allowedCount: deps.allowList.size(),
          // Collapsed to `~`: a client does not need the user's home directory
          // to render a diagnostic.
          databasePath: deps.database.pathLabel(),
          readOnly: true,
          fullDiskAccessRequired: true,
          lastError: deps.lastError(),
          schema,
        };
      },
    },

    'messages.listAllowed': {
      authz: 'background',
      input: z.object({}),
      output: ListOutput,
      summary: 'Conversations this host is allowed to read from and send to.',
      handler: async () => ({ allowed: deps.allowList.entries() }),
    },

    'messages.addAllowed': {
      authz: 'person',
      input: MutateInput,
      output: AddOutput,
      summary: 'Allow this host to read and send in one conversation. Requires human presence.',
      handler: async (_host, _session, input: z.infer<typeof MutateInput>) => {
        const added = deps.allowList.add(input.entry);
        if (added) deps.persist(deps.allowList.entries());
        return { allowed: deps.allowList.entries(), added };
      },
    },

    'messages.removeAllowed': {
      authz: 'person',
      input: MutateInput,
      output: RemoveOutput,
      summary: 'Stop this host reading from and sending in one conversation. Requires human presence.',
      handler: async (_host, _session, input: z.infer<typeof MutateInput>) => {
        const removed = deps.allowList.remove(input.entry);
        if (removed) deps.persist(deps.allowList.entries());
        return { allowed: deps.allowList.entries(), removed };
      },
    },
  };
}

function probeSchema(deps: MessagesMethodsDeps): z.infer<typeof SchemaReport> {
  try {
    const schema = deps.database.schema;
    return {
      ok: schema.ok,
      requiredMissing: schema.requiredMissing,
      missingTables: schema.missingTables,
      missingColumns: schema.missingColumns,
      effects: schema.effects,
    };
  } catch (error) {
    // On this path the failure *is* the answer: "Full Disk Access is missing"
    // is far more useful than a method that throws.
    return {
      ok: false,
      requiredMissing: [],
      missingTables: [],
      missingColumns: [],
      effects: [error instanceof Error ? error.message : String(error)],
    };
  }
}
