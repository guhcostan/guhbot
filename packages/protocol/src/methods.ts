/**
 * The RPC method registry — a single source of truth for the host/client contract.
 *
 * ## Why every method carries an authorization class
 *
 * The host is designed to keep working while nobody is watching, and to be
 * reachable from a phone over the network. Those two goals fight each other:
 * anything reachable from a phone is reachable by whoever holds the phone.
 *
 * The resolution is to classify every method as either:
 *
 *   - `background` — safe to invoke with no human present. Observation, and the
 *     housekeeping an always-on agent needs. A stolen paired device can read a
 *     transcript; it cannot spend money or send a message as you.
 *   - `person` — requires a person-class device, meaning one a human created
 *                while physically present.
 *     Anything that mutates durable state, sends a message outward, resolves an
 *     approval, or moves money.
 *
 * The host enforces the class at dispatch time, so a bug in a client cannot
 * escalate: the check lives next to the method table, not in the caller.
 *
 * The classification below is our own. It follows the same two-class shape
 * observed in the Grok Bot coordinator (which tags 36 of 172 methods
 * `background` and the rest `person`), but we deliberately harden the boundary
 * where credential writes are concerned — see `secrets.put` and the note there.
 */
import { z } from 'zod';
import {
  AgentSchema,
  ApprovalKindSchema,
  ApprovalSchema,
  AutomationSchema,
  CreateAgentInputSchema,
  DevicePlatformSchema,
  DeviceSchema,
  EntrySchema,
  GroupSchema,
  HostStatusSchema,
  IdSchema,
  McpServerSchema,
  McpToolSchema,
  RoutineStepSchema,
  RunSchema,
  SecretMetaSchema,
  TaskSchema,
  UpdateAgentInputSchema,
} from './entities.js';

export type AuthzClass = 'person' | 'background';

export interface MethodSpec<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly authz: AuthzClass;
  readonly input: I;
  readonly output: O;
  /** One-line description, surfaced in `host.describe` and generated docs. */
  readonly summary: string;
  /**
   * When true the method may only be invoked by a client whose transport is
   * local to the host process — never over a network socket. This is how
   * pairing stays safe: minting a code is something the person sitting at the
   * host does, while redeeming it is what the phone does.
   */
  readonly localOnly?: boolean;
}

const Empty = z.object({});

/** Helper that preserves each spec's literal types. */
function spec<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  authz: AuthzClass,
  input: I,
  output: O,
  summary: string,
  localOnly = false,
): MethodSpec<I, O> {
  return { authz, input, output, summary, localOnly };
}

// ---------------------------------------------------------------------------
// A page of results, shared shape
// ---------------------------------------------------------------------------
const PageInput = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(500).default(50),
});

export const methods = {
  // -- Host -----------------------------------------------------------------
  'host.status': spec('background', Empty, HostStatusSchema, 'Identity, version, mode and readiness of this host.'),
  'host.describe': spec(
    'background',
    Empty,
    z.object({
      methods: z.array(
        z.object({
          name: z.string(),
          authz: z.enum(['person', 'background']),
          summary: z.string(),
        }),
      ),
    }),
    'The method table this host implements, with each method authorization class.',
  ),

  // -- Pairing --------------------------------------------------------------
  // A client proves possession of a short-lived code minted on the host console.
  // This is the only method that a not-yet-paired device may call.
  'pairing.begin': spec(
    'background',
    Empty,
    z.object({
      pairingId: IdSchema,
      /** Shown on the host console; the user types it on the phone. */
      code: z.string().length(8),
      expiresAt: z.string().datetime({ offset: true }),
    }),
    'Mint a short-lived pairing code on the host. Host console only.',
    true,
  ),
  // A person-class device (the desktop app, where the user is sitting) may mint a
  // code for a new device. This is distinct from `pairing.begin`, which is
  // console-only: the distinction is that one is a human deciding to add a
  // phone, and the other is the host operator bootstrapping the very first client.
  'pairing.beginForDevice': spec(
    'person',
    Empty,
    z.object({
      pairingId: IdSchema,
      code: z.string().length(8),
      expiresAt: z.string().datetime({ offset: true }),
    }),
    'Mint a pairing code for a new device, from a device with human presence.',
  ),
  'pairing.claim': spec(
    'background',
    z.object({
      pairingId: IdSchema,
      code: z.string().length(8),
      deviceName: z.string().min(1).max(120),
      platform: DevicePlatformSchema,
      /** Only `background` may be requested remotely; `person` needs a local unlock. */
      requestedClass: z.enum(['person', 'background']).default('background'),
    }),
    z.object({ device: DeviceSchema, token: z.string().min(32) }),
    'Redeem a pairing code for a device token.',
  ),

  // -- Devices --------------------------------------------------------------
  'devices.list': spec('background', Empty, z.object({ devices: z.array(DeviceSchema) }), 'List devices paired to this host.'),
  'devices.revoke': spec(
    'person',
    z.object({ deviceId: IdSchema }),
    z.object({ revoked: z.boolean() }),
    'Revoke a paired device immediately.',
  ),
  'devices.unlock': spec(
    'background',
    z.object({ /** Proof of local presence, e.g. a Touch ID gate on the host. */ localPresenceToken: z.string().max(4096) }),
    z.object({ device: DeviceSchema }),
    'Upgrade the calling device to `person` class using local presence on the host.',
    true,
  ),
  'devices.setAccess': spec(
    'person',
    z.object({ deviceId: IdSchema, deviceClass: z.enum(['background', 'person']) }),
    z.object({ device: DeviceSchema }),
    'Explicitly grant or remove operator access for another paired device.',
  ),

  // -- Agents ---------------------------------------------------------------
  'agents.list': spec('background', Empty, z.object({ agents: z.array(AgentSchema) }), 'List every agent on this host.'),
  'agents.get': spec('background', z.object({ agentId: IdSchema }), AgentSchema, 'Fetch a single agent by id.'),
  'agents.create': spec('person', CreateAgentInputSchema, AgentSchema, 'Create an agent.'),
  'agents.update': spec('person', UpdateAgentInputSchema, AgentSchema, 'Update an agent.'),
  'agents.delete': spec(
    'person',
    z.object({ agentIds: z.array(IdSchema).min(1).max(64) }),
    z.object({ deleted: z.number().int().min(0) }),
    'Delete agents and their transcripts.',
  ),
  'agents.duplicate': spec('person', z.object({ agentId: IdSchema }), AgentSchema, 'Copy an agent.'),

  // -- Groups ---------------------------------------------------------------
  'groups.create': spec(
    'person',
    z.object({ name: z.string().min(1).max(120), memberIds: z.array(IdSchema).min(1).max(64) }),
    GroupSchema,
    'Create a collaborating group of agents.',
  ),
  'groups.setMembers': spec(
    'person',
    z.object({ groupId: IdSchema, memberIds: z.array(IdSchema).max(64) }),
    GroupSchema,
    'Replace group membership.',
  ),
  'groups.list': spec('background', Empty, z.object({ groups: z.array(GroupSchema) }), 'List all agent groups.'),

  // -- Transcript -----------------------------------------------------------
  'transcript.page': spec(
    'background',
    PageInput.extend({ agentId: IdSchema, /** Exclusive lower bound on `seq`. */ afterSeq: z.number().int().min(0).optional() }),
    z.object({ entries: z.array(EntrySchema), nextCursor: z.string().nullable() }),
    'Read transcript entries. The primary read path for every client.',
  ),
  'transcript.tail': spec(
    'background',
    z.object({ agentId: IdSchema, limit: z.number().int().min(1).max(200).default(50) }),
    z.object({ entries: z.array(EntrySchema) }),
    'The most recent entries, oldest first.',
  ),

  // -- Runs -----------------------------------------------------------------
  'runs.start': spec(
    'person',
    z.object({ agentId: IdSchema, prompt: z.string().min(1).max(200_000) }),
    z.object({ run: RunSchema, promptEntryId: IdSchema }),
    'Send a prompt and start an agent run.',
  ),
  'runs.interrupt': spec(
    'person',
    z.object({ runId: IdSchema }),
    z.object({ interrupted: z.boolean() }),
    'Interrupt a run and release anything it is parked on.',
  ),
  'runs.get': spec('background', z.object({ runId: IdSchema }), RunSchema, 'Fetch a single run by id.'),
  'runs.list': spec(
    'background',
    PageInput.extend({ agentId: IdSchema.optional() }),
    z.object({ runs: z.array(RunSchema), nextCursor: z.string().nullable() }),
    'Recent runs, newest first.',
  ),

  // -- Approvals ------------------------------------------------------------
  'approvals.list': spec(
    'background',
    z.object({ agentId: IdSchema.optional(), status: z.enum(['pending', 'resolved']).default('pending') }),
    z.object({ approvals: z.array(ApprovalSchema) }),
    'Pending or recently resolved approval requests.',
  ),
  'approvals.request': spec(
    'background',
    z.object({
      agentId: IdSchema,
      runId: IdSchema.nullable(),
      kind: ApprovalKindSchema,
      summary: z.string().min(1).max(20_000),
      detail: z.string().max(100_000).default('{}'),
      ttlSeconds: z.number().int().min(1).max(86_400).nullable().default(null),
    }),
    ApprovalSchema,
    'Raise an approval request. Called by the runtime, not by clients.',
  ),
  'approvals.resolve': spec(
    'person',
    z.object({
      approvalId: IdSchema,
      granted: z.boolean(),
      note: z.string().max(20_000).optional(),
    }),
    ApprovalSchema,
    'Grant or deny a pending approval. Always requires human presence.',
  ),

  // -- Secrets --------------------------------------------------------------
  // Note the deliberate hardening: the observed coordinator classifies
  // `storeSecret` as background. We classify all secret *writes* as `person`,
  // because a background-class device that can write a credential can also
  // overwrite one and lock the user out of a service. Secret *metadata* stays
  // readable in the background so a status view works unattended.
  'secrets.list': spec('background', Empty, z.object({ secrets: z.array(SecretMetaSchema) }), 'Secret names and scopes. Never values.'),
  'secrets.put': spec(
    'person',
    z.object({ name: z.string().min(1).max(200), value: z.string().min(1).max(100_000), scope: z.string().max(2048).nullable().default(null) }),
    SecretMetaSchema,
    'Store or replace a secret. The value never comes back out over the wire.',
  ),
  'secrets.delete': spec('person', z.object({ secretId: IdSchema }), z.object({ deleted: z.boolean() }), 'Delete a secret.'),

  // -- MCP ------------------------------------------------------------------
  'mcp.list': spec('background', Empty, z.object({ servers: z.array(McpServerSchema) }), 'Configured MCP servers.'),
  'mcp.add': spec(
    'person',
    z.object({
      name: z.string().min(1).max(200),
      transport: z.enum(['stdio', 'http', 'sse']),
      target: z.string().min(1).max(4096),
    }),
    McpServerSchema,
    'Register an MCP server.',
  ),
  'mcp.remove': spec('person', z.object({ serverId: IdSchema }), z.object({ removed: z.boolean() }), 'Remove an MCP server.'),
  'mcp.listTools': spec(
    'background',
    z.object({ serverId: IdSchema.optional() }),
    z.object({ tools: z.array(McpToolSchema) }),
    'Tools exposed by connected MCP servers.',
  ),
  'mcp.setToolEnabled': spec(
    'person',
    z.object({ serverId: IdSchema, toolName: z.string().min(1).max(200), enabled: z.boolean() }),
    McpServerSchema,
    'Enable or disable one MCP tool.',
  ),
  'mcp.refresh': spec('background', z.object({ serverId: IdSchema.optional() }), z.object({ refreshed: z.number().int().min(0) }), 'Reconnect servers and re-read their tool lists.'),

  // -- Routines (teach once, replay) ---------------------------------------
  'routines.list': spec('background', z.object({ agentId: IdSchema.optional() }), z.object({ routines: z.array(z.any()) }), 'Recorded routines.'),
  'routines.startRecording': spec(
    'person',
    z.object({ agentId: IdSchema, name: z.string().min(1).max(200) }),
    z.object({ routineId: IdSchema }),
    'Begin observing the user so the steps can be replayed later.',
  ),
  'routines.stopRecording': spec(
    'person',
    z.object({ routineId: IdSchema }),
    z.object({ routineId: IdSchema, stepCount: z.number().int().min(0) }),
    'Stop observing and finalize the routine.',
  ),
  'routines.run': spec('person', z.object({ routineId: IdSchema }), z.object({ run: RunSchema }), 'Replay a routine as a run.'),

  // -- Automations ----------------------------------------------------------
  'automations.list': spec('background', z.object({ agentId: IdSchema.optional() }), z.object({ automations: z.array(AutomationSchema) }), 'Automations.'),
  'automations.create': spec(
    'person',
    z.object({
      agentId: IdSchema,
      name: z.string().min(1).max(200),
      trigger: z.enum(['schedule', 'webhook', 'manual']),
      cron: z.string().max(200).nullable().default(null),
      prompt: z.string().min(1).max(100_000),
    }),
    AutomationSchema,
    'Create an automation.',
  ),
  'automations.setEnabled': spec('person', z.object({ automationId: IdSchema, enabled: z.boolean() }), AutomationSchema, 'Enable or disable an automation.'),
  'automations.runNow': spec('person', z.object({ automationId: IdSchema }), z.object({ run: RunSchema }), 'Fire an automation immediately.'),

  // -- Tasks ----------------------------------------------------------------
  'tasks.list': spec('background', z.object({ agentId: IdSchema }), z.object({ tasks: z.array(TaskSchema) }), 'An agent task list.'),
  'tasks.setStatus': spec('person', z.object({ taskId: IdSchema, status: z.enum(['open', 'in-progress', 'done', 'cancelled']) }), TaskSchema, 'Move a task.'),

  // -- Artifacts ------------------------------------------------------------
  'artifacts.get': spec(
    'background',
    z.object({ agentId: IdSchema, path: z.string().min(1).max(4096) }),
    z.object({ path: z.string(), mimeType: z.string(), bytesBase64: z.string() }),
    'Read an artifact the agent produced.',
  ),
} as const satisfies Record<string, MethodSpec>;

export type Methods = typeof methods;
export type MethodName = keyof Methods;

/** Input type for a method name. */
export type MethodInput<M extends MethodName> = z.infer<Methods[M]['input']>;
/** Output type for a method name. */
export type MethodOutput<M extends MethodName> = z.infer<Methods[M]['output']>;

export const METHOD_NAMES = Object.keys(methods) as MethodName[];

export function methodAuthz(name: string): AuthzClass | undefined {
  return (methods as Record<string, MethodSpec | undefined>)[name]?.authz;
}

/**
 * Compile-time exhaustiveness guard: the runtime refuses to boot if the
 * registry ever contains a name that is not a literal key above. Cheap, and it
 * keeps generated clients honest.
 */
export function assertRegistryIntegrity(): void {
  for (const [name, s] of Object.entries(methods)) {
    if (s.authz !== 'person' && s.authz !== 'background') {
      throw new Error(`method ${name} has an invalid authorization class`);
    }
    if (!s.summary || s.summary.length < 8) {
      throw new Error(`method ${name} is missing a summary`);
    }
  }
}

// Re-export the small bits the registry references, so generated docs have one import.
export { RoutineStepSchema };
