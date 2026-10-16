/**
 * Domain entities for the guhbot host.
 *
 * These are the durable nouns the host owns. Clients (desktop, mobile, cloud
 * console) never hold authoritative state; they render what the host tells them
 * and send intents. That is what lets the same runtime be mounted self-hosted on
 * a laptop or in a hosted multi-tenant service.
 */
import { z } from 'zod';

export const IdSchema = z.string().min(1).max(128);

/** ISO-8601 timestamp with millisecond precision, always UTC. */
export const TimestampSchema = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const AgentStatusSchema = z.enum(['active', 'paused', 'archived']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * An agent is a long-lived worker identity: it keeps instructions, a model
 * preference and its own transcript across runs. Many agents can share one
 * thread through a Group.
 */
export const AgentSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  status: AgentStatusSchema,
  /** Free-form operating instructions, prepended to every run. */
  instructions: z.string().max(100_000).default(''),
  model: z.string().min(1).max(200).nullable(),
  avatarUrl: z.string().max(2048).nullable(),
  /** Hidden agents stay reachable by id but do not appear in the sidebar. */
  hidden: z.boolean().default(false),
  /** When true the agent will not start composing replies on its own. */
  draftingDisabled: z.boolean().default(false),
  notifyOnUpdates: z.boolean().default(true),
  unreadCount: z.number().int().min(0).default(0),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Agent = z.infer<typeof AgentSchema>;

export const CreateAgentInputSchema = z.object({
  name: z.string().min(1).max(120),
  instructions: z.string().max(100_000).optional(),
  model: z.string().min(1).max(200).nullable().optional(),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

export const UpdateAgentInputSchema = z.object({
  agentId: IdSchema,
  name: z.string().min(1).max(120).optional(),
  instructions: z.string().max(100_000).optional(),
  model: z.string().min(1).max(200).nullable().optional(),
  status: AgentStatusSchema.optional(),
  hidden: z.boolean().optional(),
  draftingDisabled: z.boolean().optional(),
  notifyOnUpdates: z.boolean().optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentInputSchema>;

// ---------------------------------------------------------------------------
// Groups: several agents collaborating in one thread
// ---------------------------------------------------------------------------

export const GroupSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  memberIds: z.array(IdSchema).max(64),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Group = z.infer<typeof GroupSchema>;

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export const EntryRoleSchema = z.enum(['user', 'agent', 'tool', 'system']);
export type EntryRole = z.infer<typeof EntryRoleSchema>;

export const EntryKindSchema = z.enum([
  'message',
  'tool-call',
  'tool-result',
  'approval-request',
  'approval-resolution',
  'status',
  'artifact',
  'error',
]);
export type EntryKind = z.infer<typeof EntryKindSchema>;

/**
 * Transcript entries are append-only. `seq` is a per-agent monotonic counter, so
 * a client that reconnects can ask for "everything after seq N" and resume
 * without gaps. Streaming text is carried by separate ephemeral events and only
 * ever lands here once final.
 */
export const EntrySchema = z.object({
  id: IdSchema,
  agentId: IdSchema,
  seq: z.number().int().min(0),
  /** Set when this entry belongs to an agent run. */
  runId: IdSchema.nullable(),
  role: EntryRoleSchema,
  kind: EntryKindSchema,
  /** Plain text or JSON-encoded structured payload, depending on `kind`. */
  content: z.string(),
  /** Tool name for `tool-call` / `tool-result` entries. */
  toolName: z.string().max(200).nullable().default(null),
  createdAt: TimestampSchema,
});
export type Entry = z.infer<typeof EntrySchema>;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  /** Blocked on a human decision; see Approval. */
  'waiting-approval',
  'succeeded',
  'failed',
  'interrupted',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: IdSchema,
  agentId: IdSchema,
  status: RunStatusSchema,
  /** Prompt that started the run. */
  promptEntryId: IdSchema.nullable(),
  error: z.string().max(20_000).nullable(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.nullable(),
});
export type Run = z.infer<typeof RunSchema>;

// ---------------------------------------------------------------------------
// Approvals: the human-in-the-loop primitive
// ---------------------------------------------------------------------------

/**
 * Approvals are how an unattended agent escalates. A run parks in
 * `waiting-approval` and the client shows a request; resolving it lets the run
 * continue. This is the mechanism that makes `background`-class work safe.
 */
export const ApprovalKindSchema = z.enum([
  'tool-permission',
  'cookie-origin',
  'passkey-ceremony',
  'messages-grant',
  'virtual-card',
  'secret-submission',
  'user-form',
  'auto-review',
]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'granted', 'denied', 'expired', 'cancelled']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalSchema = z.object({
  id: IdSchema,
  agentId: IdSchema,
  runId: IdSchema.nullable(),
  kind: ApprovalKindSchema,
  status: ApprovalStatusSchema,
  /** Human-readable explanation shown by the client. */
  summary: z.string().max(20_000),
  /** Arbitrary structured detail the client renders (JSON-encoded). */
  detail: z.string().default('{}'),
  createdAt: TimestampSchema,
  /** Deadline after which the request expires; null means no deadline. */
  expiresAt: TimestampSchema.nullable(),
  resolvedAt: TimestampSchema.nullable(),
  /** Free-form note attached by whoever resolved it. */
  resolutionNote: z.string().max(20_000).nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

// ---------------------------------------------------------------------------
// Devices: pairing and per-device authorization class
// ---------------------------------------------------------------------------

export const DevicePlatformSchema = z.enum(['desktop', 'ios', 'android', 'web', 'cli', 'cloud']);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

/**
 * Every connected client is a Device. A device's `class` decides which methods
 * it may call: `person` devices have been unlocked by a human and may resolve
 * approvals; `background` devices may only drive work that needs no presence.
 */
export const DeviceClassSchema = z.enum(['person', 'background']);
export type DeviceClass = z.infer<typeof DeviceClassSchema>;

export const DeviceSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  platform: DevicePlatformSchema,
  class: DeviceClassSchema,
  pairedAt: TimestampSchema,
  lastSeenAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;

// ---------------------------------------------------------------------------
// Secrets: write-only from the client's point of view
// ---------------------------------------------------------------------------

/**
 * Secret *values* are never returned over the wire, not even to `person`
 * devices. Clients can store, list metadata for, and delete secrets; only tool
 * execution inside the host can read a value.
 */
export const SecretMetaSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(200),
  /** Optional scope, e.g. an origin the secret is bound to. */
  scope: z.string().max(2048).nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type SecretMeta = z.infer<typeof SecretMetaSchema>;

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export const McpTransportSchema = z.enum(['stdio', 'http', 'sse']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpAuthStateSchema = z.enum(['none', 'authenticated', 'expired', 'required']);
export type McpAuthState = z.infer<typeof McpAuthStateSchema>;

export const McpServerSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(200),
  transport: McpTransportSchema,
  /** URL for http/sse, command line for stdio. */
  target: z.string().min(1).max(4096),
  authState: McpAuthStateSchema.default('none'),
  enabled: z.boolean().default(true),
  /** Names of tools the user has switched off for this server. */
  disabledTools: z.array(z.string().max(200)).max(2000).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type McpServer = z.infer<typeof McpServerSchema>;

export const McpToolSchema = z.object({
  serverId: IdSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(20_000).default(''),
  /** JSON Schema for the tool input, JSON-encoded. */
  inputSchema: z.string().default('{}'),
  enabled: z.boolean().default(true),
});
export type McpTool = z.infer<typeof McpToolSchema>;

// ---------------------------------------------------------------------------
// Routines (teach-once, replay) and automations
// ---------------------------------------------------------------------------

export const RoutineStepSchema = z.object({
  index: z.number().int().min(0),
  /** What the host observed the user (or agent) do. */
  action: z.string().min(1).max(200),
  /** JSON-encoded arguments. */
  args: z.string().default('{}'),
  note: z.string().max(20_000).default(''),
});
export type RoutineStep = z.infer<typeof RoutineStepSchema>;

export const RoutineStatusSchema = z.enum(['recording', 'draft', 'ready', 'failed']);
export type RoutineStatus = z.infer<typeof RoutineStatusSchema>;

export const RoutineSchema = z.object({
  id: IdSchema,
  agentId: IdSchema,
  name: z.string().min(1).max(200),
  status: RoutineStatusSchema,
  steps: z.array(RoutineStepSchema).max(10_000).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Routine = z.infer<typeof RoutineSchema>;

export const AutomationTriggerSchema = z.enum(['schedule', 'webhook', 'manual']);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

export const AutomationSchema = z.object({
  id: IdSchema,
  agentId: IdSchema,
  name: z.string().min(1).max(200),
  trigger: AutomationTriggerSchema,
  /** Cron expression for `schedule` triggers. */
  cron: z.string().max(200).nullable(),
  /** Prompt dispatched when the automation fires. */
  prompt: z.string().max(100_000),
  enabled: z.boolean().default(true),
  nextRunAt: TimestampSchema.nullable(),
  lastRunAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Automation = z.infer<typeof AutomationSchema>;

// ---------------------------------------------------------------------------
// Tasks: the agent's own todo list, surfaced to clients
// ---------------------------------------------------------------------------

export const TaskStatusSchema = z.enum(['open', 'in-progress', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: IdSchema,
  agentId: IdSchema,
  title: z.string().min(1).max(1_000),
  status: TaskStatusSchema,
  pinned: z.boolean().default(false),
  read: z.boolean().default(false),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Task = z.infer<typeof TaskSchema>;

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export const HostModeSchema = z.enum(['self-hosted', 'hosted']);
export type HostMode = z.infer<typeof HostModeSchema>;

export const HostStatusSchema = z.object({
  hostId: IdSchema,
  version: z.string().min(1).max(64),
  mode: HostModeSchema,
  platform: z.string().min(1).max(64),
  /** Addresses a client on the same network can reach, for pairing hints. */
  addresses: z.array(z.string().max(255)).max(32),
  port: z.number().int().min(0).max(65535),
  /** True when the host has at least one usable model provider configured. */
  inferenceReady: z.boolean(),
  startedAt: TimestampSchema,
  /** Free-form capability flags, e.g. { exec: true, browser: false }. */
  capabilities: z.record(z.string(), z.boolean()).default({}),
});
export type HostStatus = z.infer<typeof HostStatusSchema>;
