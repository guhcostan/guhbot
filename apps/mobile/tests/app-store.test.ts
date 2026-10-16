import type { Agent, Approval, EventName, MethodInput, MethodName, MethodOutput, RpcError } from '@guhbot/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { Connection, ConnectionSnapshot, HostConnectionOptions } from '../src/host/connection';
import { createSessionStore, HOST_KEY, TOKEN_KEY, type SessionStore, type StringStore } from '../src/host/storage';
import { createAppStore } from '../src/state/app-store';

const TOKEN = 't'.repeat(43);
const ISO = '2026-03-04T12:00:00.000Z';

const AGENT: Agent = {
  id: 'ag_1',
  name: 'Inbox triage',
  status: 'active',
  instructions: '',
  model: null,
  avatarUrl: null,
  hidden: false,
  draftingDisabled: false,
  notifyOnUpdates: true,
  unreadCount: 2,
  createdAt: ISO,
  updatedAt: ISO,
};

const APPROVAL: Approval = {
  id: 'ap_1',
  agentId: AGENT.id,
  runId: 'run_1',
  kind: 'tool-permission',
  status: 'pending',
  summary: 'Send an email to the landlord',
  detail: '{}',
  createdAt: ISO,
  expiresAt: null,
  resolvedAt: null,
  resolutionNote: null,
};

type Handler = (params: unknown) => unknown;

function memoryStore(initial: Record<string, string> = {}): StringStore & { readonly values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
  };
}

class FakeConnection implements Connection {
  readonly calls: Array<{ readonly method: string; readonly params: unknown }> = [];
  readonly options: HostConnectionOptions;
  readonly presence: { deviceClass: 'person' | 'background' };
  snapshot: ConnectionSnapshot;
  stops = 0;

  private readonly handlers: Readonly<Record<string, Handler>>;

  constructor(options: HostConnectionOptions, handlers: Readonly<Record<string, Handler>>, deviceClass: 'person' | 'background') {
    this.options = options;
    this.handlers = handlers;
    this.presence = { deviceClass };
    this.snapshot = {
      clientState: 'ready',
      hasBeenReady: true,
      deviceId: 'dv_1',
      deviceClass,
      detail: null,
    };
  }

  async start(): Promise<void> {
    this.options.onChange(this.snapshot);
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  request<M extends MethodName>(method: M, params: MethodInput<M>): Promise<MethodOutput<M>> {
    this.calls.push({ method, params });
    const handler = this.handlers[method];
    if (handler === undefined) {
      return Promise.reject({ code: 'not-found', message: `the fake host has no ${method}`, retryable: false } satisfies RpcError);
    }
    try {
      // The fixture table is typed per method by the test that builds it; the
      // fake only has to hand back what that method's handler returned.
      return Promise.resolve(handler(params) as MethodOutput<M>);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  methodsCalled(): string[] {
    return this.calls.map((call) => call.method);
  }
}

function hostHandlers(overrides: Readonly<Record<string, Handler>> = {}): Readonly<Record<string, Handler>> {
  return {
    'pairing.claim': (params) => {
      const input = params as { deviceName: string; platform: string };
      return {
        device: { id: 'dv_1', name: input.deviceName, platform: input.platform, class: 'background', pairedAt: ISO, lastSeenAt: null, revokedAt: null },
        token: TOKEN,
      };
    },
    'host.status': () => ({
      hostId: 'host_1',
      version: '0.1.0',
      mode: 'self-hosted',
      platform: 'darwin',
      addresses: ['192.168.1.20'],
      port: 8787,
      inferenceReady: true,
      startedAt: ISO,
      capabilities: { exec: true },
    }),
    'agents.list': () => ({ agents: [AGENT] }),
    'approvals.list': () => ({ approvals: [APPROVAL] }),
    ...overrides,
  };
}

function setup(options: {
  readonly handlers?: Readonly<Record<string, Handler>>;
  readonly deviceClass?: 'person' | 'background';
  readonly stored?: boolean;
  readonly onTranscriptEvent?: (event: EventName, payload: unknown) => void;
} = {}) {
  const created: FakeConnection[] = [];
  let reconnected = 0;
  const values = memoryStore(options.stored === true ? { [HOST_KEY]: JSON.stringify({ host: '192.168.1.20', port: 8787, deviceId: 'dv_1', deviceName: 'Old phone' }) } : {});
  const secrets = memoryStore(options.stored === true ? { [TOKEN_KEY]: TOKEN } : {});
  const session = createSessionStore(values, secrets);

  const app = createAppStore({
    session,
    createConnection: (connectionOptions) => {
      const connection = new FakeConnection(connectionOptions, options.handlers ?? hostHandlers(), options.deviceClass ?? 'background');
      created.push(connection);
      return connection;
    },
    platform: 'ios',
    deviceName: () => 'Test iPhone',
    onTranscriptEvent: options.onTranscriptEvent ?? (() => undefined),
    onHostReconnected: () => {
      reconnected += 1;
    },
  });

  return { app, created, values, secrets, session, reconnected: () => reconnected };
}

describe('app store: pairing', () => {
  it('starts on the pairing screen when nothing is stored', async () => {
    const { app } = setup();
    await app.bootstrap();
    expect(app.get().status).toBe('unpaired');
    expect(app.get().host).toBeNull();
  });

  it('claims a background device, keeps the token in the secret store, and dials again with it', async () => {
    const { app, created, values, secrets } = setup();
    await app.bootstrap();
    await app.pair({ host: '192.168.1.20', port: 8787 }, 'pr_1', '12345678');

    expect(created).toHaveLength(2);
    const [anonymous, authenticated] = created;
    expect(anonymous?.options.token).toBeNull();
    expect(anonymous?.calls[0]).toEqual({
      method: 'pairing.claim',
      params: { pairingId: 'pr_1', code: '12345678', deviceName: 'Test iPhone', platform: 'ios', requestedClass: 'background' },
    });
    // The anonymous socket cannot re-authenticate, so it is closed and reopened.
    expect(anonymous?.stops).toBe(1);
    expect(authenticated?.options.token).toBe(TOKEN);

    expect(secrets.values.get(TOKEN_KEY)).toBe(TOKEN);
    expect(values.values.get(HOST_KEY)).toContain('192.168.1.20');
    expect(values.values.get(HOST_KEY)).not.toContain(TOKEN);

    const state = app.get();
    expect(state.status).toBe('paired');
    expect(state.deviceClass).toBe('background');
    expect(state.pairing).toEqual({ busy: false, error: null });
    expect(state.agents.map((agent) => agent.id)).toEqual(['ag_1']);
    expect(state.approvals.map((approval) => approval.id)).toEqual(['ap_1']);
    expect(state.loadedAt).not.toBeNull();
    expect(state.connection.state).toBe('ready');
  });

  it('keeps a refused pairing on screen as a sentence, not a thrown error', async () => {
    const { app, created } = setup({
      handlers: hostHandlers({
        'pairing.claim': () => {
          throw { code: 'forbidden', message: 'pairing failed: expired', retryable: false } satisfies RpcError;
        },
      }),
    });
    await app.bootstrap();
    await app.pair({ host: '192.168.1.20', port: 8787 }, 'pr_1', '12345678');

    const state = app.get();
    expect(state.status).toBe('unpaired');
    expect(state.pairing.busy).toBe(false);
    expect(state.pairing.error).toContain('expired');
    expect(created[0]?.stops).toBe(1);
    expect(created).toHaveLength(1);
  });

  it('reconnects with the stored token on bootstrap and re-queries after a drop', async () => {
    const { app, created, reconnected } = setup({ stored: true });
    await app.bootstrap();

    expect(created).toHaveLength(1);
    expect(created[0]?.options.token).toBe(TOKEN);
    expect(created[0]?.methodsCalled()).toContain('agents.list');

    created[0]?.options.onReconnected();
    expect(reconnected()).toBe(1);
    await Promise.resolve();
    expect(created[0]?.methodsCalled().filter((method) => method === 'agents.list')).toHaveLength(2);
  });

  it('unpairs by deleting the token and keeping the address', async () => {
    const { app, secrets, values } = setup({ stored: true });
    await app.bootstrap();
    await app.unpair();

    const state = app.get();
    expect(state.status).toBe('unpaired');
    expect(state.deviceClass).toBeNull();
    expect(state.agents).toEqual([]);
    expect(state.host?.host).toBe('192.168.1.20');
    expect(secrets.values.has(TOKEN_KEY)).toBe(false);
    expect(values.values.has(HOST_KEY)).toBe(true);
  });
});

describe('app store: refusals the device cannot perform', () => {
  it('does not even ask the host to create an agent from a background phone', async () => {
    const { app, created } = setup();
    await app.bootstrap();
    await app.pair({ host: '192.168.1.20', port: 8787 }, 'pr_1', '12345678');
    const callsBefore = created[1]?.calls.length ?? 0;

    const created_ = await app.createAgent('Something new');

    expect(created_).toBe(false);
    expect(created[1]?.calls.length).toBe(callsBefore);
    const problem = app.get().problem;
    expect(problem?.code).toBe('forbidden');
    expect(problem?.needsHostMachine).toBe(true);
    expect(problem?.detail).toContain('machine that runs the host');
    expect(app.get().creatingAgent).toBe(false);
  });

  it('does not even ask the host to resolve an approval from a background phone', async () => {
    const { app, created } = setup();
    await app.bootstrap();
    await app.pair({ host: '192.168.1.20', port: 8787 }, 'pr_1', '12345678');

    await app.resolveApproval('ap_1', true);

    expect(created[1]?.methodsCalled()).not.toContain('approvals.resolve');
    expect(app.get().problem?.needsHostMachine).toBe(true);
    expect(app.get().resolvingApprovalId).toBeNull();
    // The approval is still listed: nothing changed on the host.
    expect(app.get().approvals.map((approval) => approval.id)).toEqual(['ap_1']);
  });

  it('turns a forbidden answer from the host into the same explained state', async () => {
    const { app } = setup({
      deviceClass: 'person',
      handlers: hostHandlers({
        'agents.create': () => {
          throw { code: 'forbidden', message: 'agents.create requires a device with human presence', retryable: false } satisfies RpcError;
        },
      }),
    });
    await app.bootstrap();
    await app.pair({ host: '192.168.1.20', port: 8787 }, 'pr_1', '12345678');
    expect(app.get().deviceClass).toBe('person');

    const result = await app.createAgent('Allowed locally, refused by the host');

    expect(result).toBe(false);
    const problem = app.get().problem;
    expect(problem?.code).toBe('forbidden');
    expect(problem?.detail).toContain('human presence');
    expect(problem?.detail).toContain('machine that runs the host');
  });

  it('reports a failed refresh and does not leave a spinner running', async () => {
    const { app } = setup({
      stored: true,
      handlers: hostHandlers({
        'agents.list': () => {
          throw { code: 'internal', message: 'store is locked', retryable: true } satisfies RpcError;
        },
      }),
    });
    await app.bootstrap();

    const state = app.get();
    expect(state.refreshing).toBe(false);
    expect(state.problem?.code).toBe('internal');
    expect(state.loadedAt).toBeNull();
    // Host status and approvals still landed: one bad call does not blank the app.
    expect(state.hostStatus?.hostId).toBe('host_1');
    expect(state.approvals).toHaveLength(1);
  });
});

describe('app store: host event fan-in', () => {
  it('forwards streamed transcript deltas to the transcript handler', async () => {
    const onTranscriptEvent = vi.fn();
    const { app, created } = setup({ onTranscriptEvent });
    await app.bootstrap();
    await app.pair({ host: '192.168.1.20', port: 8787 }, 'pr_1', '12345678');

    created[1]?.options.onEvent('transcript.delta', { agentId: 'ag_1', runId: 'run_1', seq: 3, textDelta: 'Wor' });

    expect(onTranscriptEvent).toHaveBeenCalledWith('transcript.delta', expect.objectContaining({ seq: 3 }));
  });

  it('upserts agents when the host reports an update', async () => {
    const { app, created } = setup();
    await app.bootstrap();
    await app.pair({ host: '192.168.1.20', port: 8787 }, 'pr_1', '12345678');

    created[1]?.options.onEvent('agent.updated', { agent: { ...AGENT, unreadCount: 5 } });

    expect(app.get().agents).toHaveLength(1);
    expect(app.get().agents[0]?.unreadCount).toBe(5);
  });

  it('adds a pending approval when it is requested and drops it when resolved', async () => {
    const { app, created } = setup();
    await app.bootstrap();
    await app.pair({ host: '192.168.1.20', port: 8787 }, 'pr_1', '12345678');

    created[1]?.options.onEvent('approval.requested', { approval: APPROVAL });
    expect(app.get().approvals).toHaveLength(1);

    created[1]?.options.onEvent('approval.resolved', { approval: { ...APPROVAL, status: 'granted' } });
    expect(app.get().approvals).toHaveLength(0);
  });

  it('reports a shutdown as a problem the user can act on', async () => {
    const { app, created } = setup();
    await app.bootstrap();
    await app.pair({ host: '192.168.1.20', port: 8787 }, 'pr_1', '12345678');

    created[1]?.options.onEvent('host.shutdown', { reason: 'operator stopped the host' });

    const problem = app.get().problem;
    expect(problem?.code).toBe('cancelled');
    expect(problem?.title).toBe('The host is shutting down');
    expect(problem?.detail).toBe('operator stopped the host');
  });
});

describe('app store: host mutations the device may perform', () => {
  it('creates an agent and lands it in the list', async () => {
    const { app } = setup({ deviceClass: 'person', handlers: hostHandlers({ 'agents.create': () => AGENT }) });
    await app.bootstrap();
    await app.pair({ host: '192.168.1.20', port: 8787 }, 'pr_1', '12345678');

    const created = await app.createAgent('Inbox triage');

    expect(created).toBe(true);
    expect(app.get().creatingAgent).toBe(false);
    expect(app.get().agents.map((agent) => agent.id)).toEqual(['ag_1']);
    expect(app.get().problem).toBeNull();
  });

  it('resolves a pending approval and clears the busy flag', async () => {
    const { app } = setup({
      deviceClass: 'person',
      handlers: hostHandlers({ 'approvals.resolve': () => ({ approval: { ...APPROVAL, status: 'granted' } }) }),
    });
    await app.bootstrap();
    await app.pair({ host: '192.168.1.20', port: 8787 }, 'pr_1', '12345678');

    await app.resolveApproval('ap_1', true);

    expect(app.get().resolvingApprovalId).toBeNull();
    expect(app.get().approvals).toHaveLength(0);
    expect(app.get().problem).toBeNull();
  });

  it('clears an in-flight create flag when the phone unpairs', async () => {
    const never = new Promise<Agent>(() => undefined);
    const { app } = setup({ deviceClass: 'person', handlers: hostHandlers({ 'agents.create': () => never }) });
    await app.bootstrap();
    await app.pair({ host: '192.168.1.20', port: 8787 }, 'pr_1', '12345678');

    void app.createAgent('Slow host');
    expect(app.get().creatingAgent).toBe(true);

    await app.unpair();

    expect(app.get().creatingAgent).toBe(false);
    expect(app.get().status).toBe('unpaired');
  });
});

describe('app store: bootstrap', () => {
  it('lands on the pairing screen when stored state cannot be read', async () => {
    const failingSession: SessionStore = {
      loadHost: () => Promise.reject(new Error('storage is locked')),
      saveHost: () => Promise.resolve(),
      loadToken: () => Promise.resolve(null),
      saveToken: () => Promise.resolve(),
      clearToken: () => Promise.resolve(),
    };
    const app = createAppStore({
      session: failingSession,
      createConnection: () => {
        throw new Error('the connection factory must not be reached');
      },
      platform: 'ios',
      deviceName: () => 'Test iPhone',
      onTranscriptEvent: () => undefined,
      onHostReconnected: () => undefined,
    });

    await app.bootstrap();

    expect(app.get().status).toBe('unpaired');
    expect(app.get().problem).not.toBeNull();
  });
});
