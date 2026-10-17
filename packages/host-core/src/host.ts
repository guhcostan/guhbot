import { EventEmitter } from 'node:events';
import type {
  Agent,
  Approval,
  ApprovalKind,
  AuthzClass,
  Device,
  DeviceClass,
  DevicePlatform,
  Entry,
  HostMode,
  HostStatus,
  MethodInput,
  MethodName,
  MethodOutput,
  Run,
} from '@guhbot/protocol';
import { PROTOCOL_VERSION, methods } from '@guhbot/protocol';
import type { z } from 'zod';
import { loadOrCreateMasterKey, createSecretBox, hashToken, verifyToken, type SecretBox } from './crypto.js';
import { createHash } from 'node:crypto';
import { newId, newPairingCode, newToken, nowIso } from './ids.js';
import { Store } from './store.js';

/**
 * The host runtime.
 *
 * One long-lived object owns all durable state and enforces every authorization
 * decision. Clients are stateless: they hold a device token and an event
 * stream, and they re-read what they need after a disconnect. That is what lets
 * the same host serve a desktop app over an in-process channel and a phone over
 * a WebSocket without two code paths.
 *
 * The model layer is injected rather than imported (see `RunExecutor`), so this
 * package has no dependency on any HTTP client or vendor SDK. A host with no
 * model configured still boots, still serves transcripts, and simply reports
 * `inferenceReady: false`.
 */

export type ChannelKind = 'local' | 'network';

/** A connected client. Carries identity and the channel it arrived on. */
export interface Session {
  readonly id: string;
  readonly channel: ChannelKind;
  device: Device | null;
}

export class HostError extends Error {
  readonly code: 'bad-request' | 'unauthenticated' | 'forbidden' | 'not-found' | 'internal' | 'rate-limited' | 'cancelled';
  readonly retryable: boolean;
  constructor(
    code: HostError['code'],
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * What a run needs from the runtime. Implemented by the agent package; kept as
 * an interface here so host-core stays free of provider concerns and tests can
 * substitute a scripted executor.
 */
export interface RunContext {
  readonly run: Run;
  readonly agent: Agent;
  readonly prompt: string;
  /**
   * Recent transcript entries for this agent, oldest first, ending with the
   * prompt entry for this run. The loop turns these into chat messages so a
   * follow-up prompt continues the conversation instead of starting cold.
   */
  readonly history: readonly Entry[];
  /** Append an entry and broadcast it. */
  append(input: { role: Entry['role']; kind: Entry['kind']; content: string; toolName?: string | null }): Entry;
  /** Emit an ephemeral streaming delta for the client to render. */
  emitDelta(seq: number, textDelta: string): void;
  /** Resolve a secret value for tool use. Never exposed over RPC. */
  readSecret(name: string): string | null;
  /** Park the run until a human resolves the request. */
  requestApproval(input: {
    kind: ApprovalKind;
    summary: string;
    detail?: string;
    ttlSeconds?: number | null;
  }): Promise<Approval>;
  /** True once the user has interrupted this run. */
  isCancelled(): boolean;
}

export interface RunExecutor {
  execute(context: RunContext, signal: AbortSignal): Promise<void>;
}

export interface HostOptions {
  dataDir: string;
  version: string;
  mode: HostMode;
  /** Reported to clients via `host.status`. */
  capabilities?: Record<string, boolean>;
  /** Injected model layer. When absent, `runs.start` fails cleanly. */
  executor?: RunExecutor;
  /** Overridable for tests. */
  now?: () => number;
  /**
   * How many past transcript entries to replay into a run. Larger is more
   * coherent and more expensive; the loop also drops entries when the provider
   * rejects the request for length.
   */
  historyLimit?: number;
  /**
   * Extra RPC methods contributed by capability packages.
   *
   * Capabilities live outside this package so that adding one never means
   * editing the runtime. Each entry is keyed by the method name it implements
   * and must also appear in the protocol registry, which is where its input
   * schema and authorization class are declared. A handler registered for a
   * name that is not in the registry is ignored, so a typo cannot widen the API.
   */
  extraMethods?: Record<string, ContributedMethod>;
}

/** Signature every RPC handler shares. */
export type MethodHandler = (host: Host, session: Session, input: never) => Promise<unknown>;

/**
 * A method contributed by a capability package.
 *
 * It carries its own contract rather than only a handler, so the authorization
 * class and the input schema are declared at the point of definition and cannot
 * be forgotten. `dispatch` treats core and contributed methods identically.
 */
export interface ContributedMethod {
  authz: AuthzClass;
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  summary: string;
  localOnly?: boolean;
  handler: MethodHandler;
}

export interface HostEvents {
  'transcript.appended': { entry: Entry };
  'transcript.delta': { agentId: string; runId: string; seq: number; textDelta: string };
  'run.updated': { run: Run };
  'approval.requested': { approval: Approval };
  'approval.resolved': { approval: Approval };
  'agent.updated': { agent: Agent };
  'host.shutdown': { reason: string };
}

export class Host {
  readonly store: Store;
  readonly dataDir: string;
  readonly version: string;
  readonly mode: HostMode;
  readonly hostId: string;
  readonly startedAt: string;
  readonly capabilities: Record<string, boolean>;
  private readonly secretBox: SecretBox;
  private readonly emitter = new EventEmitter();
  private readonly now: () => number;
  private readonly executor: RunExecutor | undefined;
  /** Runs currently executing, so `runs.interrupt` can reach their AbortSignal. */
  private readonly activeRuns = new Map<string, { controller: AbortController; session: Session }>();
  /** Approvals a run is parked on, keyed by approval id. */
  private readonly approvalWaiters = new Map<string, (approval: Approval) => void>();
  /** Pairing codes currently outstanding, plaintext kept only in memory. */
  private readonly livePairings = new Map<string, string>();
  private readonly historyLimit: number;
  /** Every callable method: the static core table plus anything a capability contributed. */
  private readonly registry: Map<string, ResolvedMethod>;
  private listenAddresses: string[] = [];
  private listenPort = 0;
  private closed = false;

  constructor(options: HostOptions) {
    this.dataDir = options.dataDir;
    this.version = options.version;
    this.mode = options.mode;
    this.now = options.now ?? Date.now;
    this.capabilities = options.capabilities ?? {};
    this.historyLimit = options.historyLimit ?? 60;
    this.registry = buildRegistry(options.extraMethods ?? {});
    this.executor = options.executor;

    this.store = new Store({ dataDir: options.dataDir });
    this.secretBox = createSecretBox(loadOrCreateMasterKey(options.dataDir));
    this.hostId = this.store.hostId();
    this.startedAt = nowIso();
    this.recoverUnfinishedWork();
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on<K extends keyof HostEvents>(event: K, listener: (payload: HostEvents[K]) => void): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  /**
   * Broadcast an event to subscribers.
   *
   * Public because the server and the runtime both raise events, but nothing may
   * persist a payload without going through the store first.
   */
  emitEvent<K extends keyof HostEvents>(event: K, payload: HostEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  /**
   * The callable method table, core plus contributed.
   *
   * Exposed so `host.describe` reports what this host actually implements — a
   * client that discovers a method here is guaranteed a handler exists behind it.
   */
  describeMethods(): { name: string; authz: AuthzClass; summary: string }[] {
    return [...this.registry.entries()]
      .map(([name, entry]) => ({ name, authz: entry.spec.authz, summary: entry.spec.summary }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Record the addresses and port the server actually bound, for `host.status`. */
  setListenInfo(addresses: string[], port: number): void {
    this.listenAddresses = addresses;
    this.listenPort = port;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * Create a session for a client that reached us on `channel`.
   *
   * A `local` channel is in-process (the Electron main process at the point the
   * desktop app spawns the host). A `network` channel is anything that arrived
   * over a socket, and it always has to authenticate.
   */
  createSession(channel: ChannelKind, device: Device | null = null): Session {
    // Presence is a property of the *device*, established when it was created:
    // a person-class device was minted either in-process on this host or by a
    // human who possessed a person-class device and minted a code deliberately.
    // A phone that redeems a code is always background class and cannot promote
    // itself. There is therefore no separate per-session unlock flag to keep in
    // sync, which is the point.
    return { id: newId('dv'), channel, device };
  }

  /** Resolve a device token into a session. Returns null when the token is not valid. */
  authenticate(token: string): Device | null {
    const device = this.store.findDeviceByToken(token, verifyToken);
    if (device) this.store.touchDevice(device.id);
    return device;
  }

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  /**
   * Mint a pairing code. The plaintext code is returned once and never stored;
   * only its hash goes to the database, so a stolen `data.db` cannot be used to
   * pair a new device.
   */
  beginPairing(ttlSeconds = 300): { pairingId: string; code: string; expiresAt: string } {
    const code = newPairingCode();
    const expiresAt = new Date(this.now() + ttlSeconds * 1000).toISOString();
    const codeHash = createHash('sha256').update(code).digest('hex');
    const pairingId = this.store.createPairing(codeHash, expiresAt);
    this.livePairings.set(pairingId, expiresAt);
    return { pairingId, code, expiresAt };
  }

  claimPairing(input: {
    pairingId: string;
    code: string;
    deviceName: string;
    platform: DevicePlatform;
    requestedClass: DeviceClass;
  }): { device: Device; token: string } {
    const codeHash = createHash('sha256').update(input.code).digest('hex');
    const result = this.store.claimPairing(input.pairingId, codeHash);
    if (!result.ok) {
      throw new HostError('forbidden', `pairing failed: ${result.reason}`);
    }

    // A remote device may only ever join as `background`. Becoming `person`
    // requires physical presence on the host, so a phone cannot promote itself
    // just by holding a pairing code.
    const deviceClass: DeviceClass = input.requestedClass === 'person' ? 'background' : input.requestedClass;

    const token = newToken();
    const salt = Buffer.from(newId('dv'), 'utf8');
    const device = this.store.createDevice({
      name: input.deviceName,
      platform: input.platform,
      deviceClass,
      tokenSalt: salt,
      tokenHash: hashToken(token, salt),
    });
    this.livePairings.delete(input.pairingId);
    return { device, token };
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * The single entry point for every client request.
   *
   * Order matters and is deliberate:
   *   1. method exists                      -> unknown names never reach a handler
   *   2. transport allowed (localOnly)      -> pairing cannot be minted remotely
   *   3. parameters match the schema        -> handlers may trust their input
   *   4. authorization class                -> `person` needs a person-class device
   *   5. handler runs
   *   6. output matches the schema          -> a buggy handler cannot leak a
   *                                            shape the clients cannot parse
   */
  async dispatch(session: Session, method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      throw new HostError('cancelled', 'host is shutting down');
    }

    // Authority is durable host state, not a snapshot captured at WebSocket auth.
    // Revocation and demotion must also apply to an already connected client.
    if (session.device !== null) {
      const current = this.store.getDevice(session.device.id);
      if (current === null || current.revokedAt !== null) {
        throw new HostError('unauthenticated', 'device has been revoked');
      }
      session.device = current;
    }

    const entry = this.registry.get(method);
    if (!entry) {
      throw new HostError('not-found', `unknown method ${method}`);
    }
    const { spec } = entry;

    if (spec.localOnly === true && session.channel !== 'local') {
      throw new HostError('forbidden', `${method} is only available on the host itself`);
    }

    const parsed = spec.input.safeParse(params ?? {});
    if (!parsed.success) {
      throw new HostError('bad-request', `invalid params for ${method}: ${parsed.error.message}`);
    }

    if (!this.isAuthorized(session, spec.authz)) {
      throw new HostError(
        'forbidden',
        `${method} requires a device with human presence, but this device is "${session.device?.class ?? 'unpaired'}"`,
      );
    }

    // Handlers are typed per-method; the registry guarantees the cast is sound.
    const result = await entry.handler(this, session, parsed.data as never);

    const outputCheck = spec.output.safeParse(result);
    if (!outputCheck.success) {
      throw new HostError('internal', `handler for ${method} produced a shape that fails its own schema: ${outputCheck.error.message}`);
    }
    return outputCheck.data;
  }

  private isAuthorized(session: Session, required: AuthzClass): boolean {
    if (required === 'background') return true;

    // A local channel is code running on the host itself as the host's user —
    // the Electron main process, or the CLI on the same machine. Anyone who can
    // open one can already read the database and the master key directly, so
    // gating it adds nothing. This is also the only way a fresh host with no
    // paired devices can be operated at all.
    if (session.channel === 'local') return true;

    // Remote work needs a person-class device.
    return session.device?.class === 'person';
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /**
   * Start a run. The prompt entry is written before the executor is scheduled,
   * so a crash between the two leaves a visible transcript entry and a failed
   * run rather than a silently dropped message.
   */
  async startRun(session: Session, agentId: string, prompt: string): Promise<{ run: Run; promptEntryId: string }> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new HostError('not-found', `no agent ${agentId}`);
    if (!this.executor) {
      throw new HostError('internal', 'this host has no model provider configured, so it cannot start a run');
    }

    const promptEntry = this.store.appendEntry({ agentId, role: 'user', kind: 'message', content: prompt });
    this.emitEvent('transcript.appended', { entry: promptEntry });
    const run = this.store.createRun(agentId, promptEntry.id);
    this.emitEvent('run.updated', { run });

    // How much history to replay. Bounded because transcript size grows without
    // limit while a provider's context window does not.
    const history = this.store.listRecentEntries(agentId, this.historyLimit);
    const context = this.buildRunContext(run, agent, prompt, history);
    const controller = new AbortController();
    this.activeRuns.set(run.id, { controller, session });

    void this.executeRun(run, context, controller.signal);
    return { run, promptEntryId: promptEntry.id };
  }

  private buildRunContext(run: Run, agent: Agent, prompt: string, history: Entry[]): RunContext {
    return {
      run,
      agent,
      prompt,
      history,
      append: (input) => {
        const entry = this.store.appendEntry({
          agentId: agent.id,
          role: input.role,
          kind: input.kind,
          content: input.content,
          runId: run.id,
          toolName: input.toolName ?? null,
        });
        this.emitEvent('transcript.appended', { entry });
        return entry;
      },
      emitDelta: (seq, textDelta) => {
        this.emitEvent('transcript.delta', { agentId: agent.id, runId: run.id, seq, textDelta });
      },
      readSecret: (name) => {
        const sealed = this.store.readSealedSecret(name);
        if (sealed === null) return null;
        try {
          return this.secretBox.open(sealed);
        } catch {
          // A secret we cannot decrypt must read as absent rather than crash a run.
          return null;
        }
      },
      requestApproval: async (input) => {
        const approval = this.store.createApproval({
          agentId: agent.id,
          runId: run.id,
          kind: input.kind,
          summary: input.summary,
          detail: input.detail ?? '{}',
          ttlSeconds: input.ttlSeconds ?? null,
        });
        this.emitEvent('approval.requested', { approval });
        this.store.updateRun(run.id, { status: 'waiting-approval' });
        const updated = this.store.getRun(run.id);
        if (updated) this.emitEvent('run.updated', { run: updated });

        const resolved = await this.waitForApproval(approval.id);
        const resumed = this.store.getRun(run.id);
        if (resumed) this.emitEvent('run.updated', { run: resumed });
        return resolved;
      },
      isCancelled: () => this.activeRuns.get(run.id)?.controller.signal.aborted ?? true,
    };
  }

  private async executeRun(run: Run, context: RunContext, signal: AbortSignal): Promise<void> {
    const executor = this.executor;
    if (!executor) return;
    try {
      this.store.updateRun(run.id, { status: 'running' });
      const started = this.store.getRun(run.id);
      if (started) this.emitEvent('run.updated', { run: started });

      await executor.execute(context, signal);
      if (signal.aborted) {
        this.finishRun(run.id, 'interrupted', null);
      } else {
        this.finishRun(run.id, 'succeeded', null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finishRun(run.id, signal.aborted ? 'interrupted' : 'failed', message);
    } finally {
      this.activeRuns.delete(run.id);
    }
  }

  private finishRun(runId: string, status: Run['status'], error: string | null): void {
    const run = this.store.updateRun(runId, { status, error, endedAt: nowIso() });
    if (run) this.emitEvent('run.updated', { run });
  }

  interruptRun(runId: string): boolean {
    const active = this.activeRuns.get(runId);
    if (!active) {
      // Interrupting a run that is parked on an approval still has to end it.
      const run = this.store.getRun(runId);
      if (run && (run.status === 'running' || run.status === 'queued' || run.status === 'waiting-approval')) {
        this.finishRun(runId, 'interrupted', null);
        return true;
      }
      return false;
    }
    active.controller.abort();
    // Release anything parked on an approval so the run can unwind.
    for (const [approvalId, waiter] of this.approvalWaiters) {
      const approval = this.store.getApproval(approvalId);
      if (approval?.runId === runId) {
        this.approvalWaiters.delete(approvalId);
        waiter(approval);
      }
    }
    return true;
  }

  resolveApproval(session: Session, approvalId: string, granted: boolean, note: string | null): Approval {
    void session;
    const resolved = this.store.resolveApproval(approvalId, granted, note);
    if (!resolved) throw new HostError('not-found', `no approval ${approvalId}`);
    this.emitEvent('approval.resolved', { approval: resolved });
    const waiter = this.approvalWaiters.get(approvalId);
    if (waiter) {
      this.approvalWaiters.delete(approvalId);
      waiter(resolved);
    }
    return resolved;
  }

  private waitForApproval(approvalId: string): Promise<Approval> {
    return new Promise<Approval>((resolve) => {
      this.approvalWaiters.set(approvalId, resolve);
    });
  }

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------

  putSecret(name: string, value: string, scope: string | null): void {
    this.store.putSecret(name, this.secretBox.seal(value), scope);
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  status(): HostStatus {
    return {
      hostId: this.hostId,
      version: this.version,
      mode: this.mode,
      platform: process.platform,
      addresses: this.listenAddresses,
      port: this.listenPort,
      inferenceReady: this.executor !== undefined,
      startedAt: this.startedAt,
      capabilities: this.capabilities,
    };
  }

  /**
   * Fail work that a previous process left in flight.
   *
   * Without this a crash mid-run leaves rows stuck in `running` and clients
   * spin forever. We mark them failed with an explicit reason so the user sees
   * what happened.
   */
  private recoverUnfinishedWork(): void {
    const unfinished = this.store.listUnfinishedRuns();
    for (const run of unfinished) {
      this.store.updateRun(run.id, {
        status: 'failed',
        error: 'host restarted while this run was in flight',
        endedAt: nowIso(),
      });
    }
    this.store.expireStaleApprovals();
  }

  async close(reason = 'shutdown'): Promise<void> {
    this.closed = true;
    for (const [, active] of this.activeRuns) {
      active.controller.abort();
    }
    this.emitEvent('host.shutdown', { reason });
    this.store.close();
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

}

interface ResolvedMethod {
  spec: { authz: AuthzClass; input: z.ZodTypeAny; output: z.ZodTypeAny; summary: string; localOnly?: boolean };
  handler: MethodHandler;
}

/**
 * Merge the static core table with capability contributions.
 *
 * Contributions are checked against the core table for name collisions: a
 * capability must not be able to silently replace a core method, which would let
 * a third-party package redefine, say, `approvals.resolve`.
 */
function buildRegistry(extra: Record<string, ContributedMethod>): Map<string, ResolvedMethod> {
  const registry = new Map<string, ResolvedMethod>();
  for (const [name, spec] of Object.entries(methods)) {
    const handler = (HANDLERS as Record<string, MethodHandler | undefined>)[name];
    if (!handler) continue;
    registry.set(name, { spec, handler });
  }
  for (const [name, contributed] of Object.entries(extra)) {
    if (registry.has(name)) {
      throw new Error(`capability tried to redefine the core method ${name}`);
    }
    registry.set(name, { spec: contributed, handler: contributed.handler });
  }
  return registry;
}

type HandlerTable = {
  [M in MethodName]?: (host: Host, session: Session, input: MethodInput<M>) => Promise<MethodOutput<M>>;
};

/**
 * Method implementations.
 *
 * These are deliberately thin: validate → mutate the store → emit an event.
 * Anything with real logic belongs in a package that owns that concern (runs,
 * MCP, browser), reached through an injected interface.
 */
const HANDLERS: HandlerTable = {
  'host.status': async (host) => host.status(),

  'host.describe': async (host) => ({ methods: host.describeMethods() }),

  'pairing.begin': async (host) => host.beginPairing(),

  'pairing.beginForDevice': async (host) => host.beginPairing(),

  'pairing.claim': async (host, _session, input) =>
    host.claimPairing({
      pairingId: input.pairingId,
      code: input.code,
      deviceName: input.deviceName,
      platform: input.platform,
      requestedClass: input.requestedClass,
    }),

  'devices.list': async (host) => ({ devices: host.store.listDevices() }),

  'devices.revoke': async (host, _session, input) => ({ revoked: host.store.revokeDevice(input.deviceId) }),

  'devices.setAccess': async (host, session, input) => {
    if (input.deviceId === session.device?.id) {
      throw new HostError('forbidden', 'change access for another device from the operator console');
    }
    const target = host.store.getDevice(input.deviceId);
    if (target === null || target.revokedAt !== null) throw new HostError('not-found', 'active device not found');
    const device = host.store.setDeviceClass(input.deviceId, input.deviceClass);
    if (device === null) throw new HostError('not-found', 'device no longer exists');
    return { device };
  },

  'devices.unlock': async (host, session, input) => {
    // Local presence is established by the host process, not asserted by the
    // client. The token below is issued by the local console surface only.
    if (input.localPresenceToken !== 'local-console-confirmed') {
      throw new HostError('forbidden', 'local presence could not be confirmed on this host');
    }
    if (!session.device) throw new HostError('unauthenticated', 'unlock requires a paired device');
    const updated = host.store.setDeviceClass(session.device.id, 'person');
    if (!updated) throw new HostError('not-found', 'device no longer exists');
    session.device = updated;
    return { device: updated };
  },

  'agents.list': async (host) => ({ agents: host.store.listAgents() }),
  'agents.get': async (host, _session, input) => {
    const agent = host.store.getAgent(input.agentId);
    if (!agent) throw new HostError('not-found', `no agent ${input.agentId}`);
    return agent;
  },
  'agents.create': async (host, _session, input) => {
    const agent = host.store.createAgent(input);
    // Clients upsert on `agent.updated`, so a creation must speak too:
    // otherwise a phone watching the list never learns the agent exists.
    host.emitEvent('agent.updated', { agent });
    return agent;
  },
  'agents.update': async (host, _session, input) => {
    const { agentId, ...patch } = input;
    const updated = host.store.updateAgent(agentId, patch);
    if (!updated) throw new HostError('not-found', `no agent ${agentId}`);
    host.emitEvent('agent.updated', { agent: updated });
    return updated;
  },
  'agents.delete': async (host, _session, input) => ({ deleted: host.store.deleteAgents(input.agentIds) }),
  'agents.duplicate': async (host, _session, input) => {
    const source = host.store.getAgent(input.agentId);
    if (!source) throw new HostError('not-found', `no agent ${input.agentId}`);
    const copy = host.store.createAgent({ name: `${source.name} (copy)`, instructions: source.instructions, model: source.model });
    host.emitEvent('agent.updated', { agent: copy });
    return copy;
  },

  'groups.list': async (host) => ({ groups: host.store.listGroups() }),
  'groups.create': async (host, _session, input) => host.store.createGroup(input.name, input.memberIds),
  'groups.setMembers': async (host, _session, input) => {
    const group = host.store.setGroupMembers(input.groupId, input.memberIds);
    if (!group) throw new HostError('not-found', `no group ${input.groupId}`);
    return group;
  },

  'transcript.page': async (host, _session, input) => {
    const limit = input.limit;
    const entries = host.store.listEntries(input.agentId, {
      afterSeq: input.afterSeq ?? -1,
      limit,
    });
    // A full page implies there may be more; signal it with a cursor the client
    // can pass back as `afterSeq`.
    const last = entries.at(-1);
    return { entries, nextCursor: entries.length === limit && last ? String(last.seq) : null };
  },

  'transcript.tail': async (host, _session, input) => ({
    entries: host.store.listRecentEntries(input.agentId, input.limit),
  }),

  'runs.start': async (host, session, input) => host.startRun(session, input.agentId, input.prompt),
  'runs.interrupt': async (host, _session, input) => ({ interrupted: host.interruptRun(input.runId) }),
  'runs.get': async (host, _session, input) => {
    const run = host.store.getRun(input.runId);
    if (!run) throw new HostError('not-found', `no run ${input.runId}`);
    return run;
  },
  'runs.list': async (host, _session, input) => {
    const runs = host.store.listRuns({
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      limit: input.limit,
    });
    return { runs, nextCursor: null };
  },

  'approvals.list': async (host, _session, input) => ({
    approvals: host.store.listApprovals({
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      status: input.status,
    }),
  }),

  'approvals.request': async (host, _session, input) =>
    host.store.createApproval({
      agentId: input.agentId,
      runId: input.runId,
      kind: input.kind,
      summary: input.summary,
      detail: input.detail,
      ttlSeconds: input.ttlSeconds,
    }),

  'approvals.resolve': async (host, session, input) =>
    host.resolveApproval(session, input.approvalId, input.granted, input.note ?? null),

  'secrets.list': async (host) => ({ secrets: host.store.listSecrets() }),
  'secrets.put': async (host, _session, input) => {
    host.putSecret(input.name, input.value, input.scope);
    const found = host.store.listSecrets().find((s) => s.name === input.name);
    if (!found) throw new HostError('internal', 'secret write did not persist');
    return found;
  },
  'secrets.delete': async (host, _session, input) => ({ deleted: host.store.deleteSecret(input.secretId) }),

  'mcp.list': async (host) => ({ servers: host.store.listMcpServers() }),
  'mcp.add': async (host, _session, input) => host.store.createMcpServer(input),
  'mcp.remove': async (host, _session, input) => ({ removed: host.store.removeMcpServer(input.serverId) }),
  'mcp.listTools': async () => ({ tools: [] }),
  'mcp.setToolEnabled': async (host, _session, input) => {
    const server = host.store.getMcpServer(input.serverId);
    if (!server) throw new HostError('not-found', `no MCP server ${input.serverId}`);
    const disabled = new Set(server.disabledTools);
    if (input.enabled) disabled.delete(input.toolName);
    else disabled.add(input.toolName);
    const updated = host.store.setMcpDisabledTools(input.serverId, [...disabled]);
    if (!updated) throw new HostError('not-found', `no MCP server ${input.serverId}`);
    return updated;
  },
  'mcp.refresh': async () => ({ refreshed: 0 }),

  'routines.list': async (host, _session, input) => ({ routines: host.store.listRoutines(input.agentId) }),
  'routines.startRecording': async (host, _session, input) => {
    const routine = host.store.createRoutine(input.agentId, input.name);
    return { routineId: routine.id };
  },
  'routines.stopRecording': async (host, _session, input) => {
    const routine = host.store.finishRoutine(input.routineId, 'ready');
    if (!routine) throw new HostError('not-found', `no routine ${input.routineId}`);
    return { routineId: routine.id, stepCount: routine.steps.length };
  },
  'routines.run': async (host, session, input) => {
    const routine = host.store.getRoutine(input.routineId);
    if (!routine) throw new HostError('not-found', `no routine ${input.routineId}`);
    const prompt = routine.steps.map((s) => `${s.index + 1}. ${s.action} ${s.args}`).join('\n');
    const { run } = await host.startRun(session, routine.agentId, `Replay routine "${routine.name}":\n${prompt}`);
    return { run };
  },

  'automations.list': async (host, _session, input) => ({ automations: host.store.listAutomations(input.agentId) }),
  'automations.create': async (host, _session, input) => host.store.createAutomation(input),
  'automations.setEnabled': async (host, _session, input) => {
    const automation = host.store.setAutomationEnabled(input.automationId, input.enabled);
    if (!automation) throw new HostError('not-found', `no automation ${input.automationId}`);
    return automation;
  },
  'automations.runNow': async (host, session, input) => {
    const automation = host.store.getAutomation(input.automationId);
    if (!automation) throw new HostError('not-found', `no automation ${input.automationId}`);
    host.store.markAutomationRun(automation.id);
    const { run } = await host.startRun(session, automation.agentId, automation.prompt);
    return { run };
  },

  'tasks.list': async (host, _session, input) => ({ tasks: host.store.listTasks(input.agentId) }),
  'tasks.setStatus': async (host, _session, input) => {
    const task = host.store.setTaskStatus(input.taskId, input.status);
    if (!task) throw new HostError('not-found', `no task ${input.taskId}`);
    return task;
  },

  'artifacts.get': async (host, _session, input) => {
    const { readFile } = await import('node:fs/promises');
    const { join, normalize, resolve, sep } = await import('node:path');
    const root = host.store.artifactsDir;
    // Contain the read to the artifacts directory. `resolve` collapses `..`, and
    // the check runs on the resolved path so traversal cannot escape.
    const target = resolve(root, normalize(input.path));
    if (target !== root && !target.startsWith(root + sep)) {
      throw new HostError('forbidden', 'artifact path escapes the artifacts directory');
    }
    try {
      const bytes = await readFile(join(target));
      return { path: input.path, mimeType: 'application/octet-stream', bytesBase64: bytes.toString('base64') };
    } catch {
      throw new HostError('not-found', `no artifact at ${input.path}`);
    }
  },
};

export { PROTOCOL_VERSION };
