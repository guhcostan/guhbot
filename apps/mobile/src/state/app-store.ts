/**
 * The app's state layer: host, agents, approvals, connection.
 *
 * Screens read a snapshot and call methods here; nothing in this file touches
 * React or a screen. Two rules it enforces rather than hopes for:
 *
 *   - an action the current device class cannot perform is refused *before* it
 *     is sent, with the refusal kept as a value the UI can render;
 *   - a `forbidden` that still comes back from the host is turned into the same
 *     kind of value, never into a crash.
 */
import {
  EventPayloads,
  type Agent,
  type Approval,
  type DeviceClass,
  type DevicePlatform,
  type EventName,
  type HostStatus,
  type MethodInput,
  type MethodName,
  type MethodOutput,
  type RpcError,
} from '@guhbot/protocol';

import { capabilityFor } from '../core/capabilities.js';
import { connectionView, type ConnectionView } from '../core/device.js';
import type { HostEndpoint } from '../core/endpoint.js';
import { describeError, type Problem } from '../core/errors.js';
import type { Connection, ConnectionSnapshot, HostConnectionOptions } from '../host/connection.js';
import { pairingMessage } from '../host/pairing.js';
import type { PersistedHost, SessionStore } from '../host/storage.js';
import { createStore, type Readable } from './store.js';

export type AppStatus = 'starting' | 'unpaired' | 'paired';

export interface PairingProgress {
  readonly busy: boolean;
  readonly error: string | null;
}

export interface AppSnapshot {
  readonly status: AppStatus;
  /** The paired address. Kept across an unpair so the form stays prefilled. */
  readonly host: PersistedHost | null;
  readonly connection: ConnectionView;
  readonly deviceClass: DeviceClass | null;
  readonly deviceId: string | null;
  readonly hostStatus: HostStatus | null;
  readonly agents: readonly Agent[];
  readonly approvals: readonly Approval[];
  /** Set once a refresh has landed, so "empty" and "not loaded" differ. */
  readonly loadedAt: string | null;
  readonly refreshing: boolean;
  readonly problem: Problem | null;
  readonly pairing: PairingProgress;
  readonly resolvingApprovalId: string | null;
  readonly creatingAgent: boolean;
}

export interface AppStore extends Readable<AppSnapshot> {
  bootstrap(): Promise<void>;
  /** Redeems a scanned or pasted pairing link. */
  pair(endpoint: HostEndpoint, pairingId: string, code: string): Promise<void>;
  /** Re-reads host status, agents and approvals. */
  refresh(): Promise<void>;
  /** Tears the link down and dials again with the stored token. */
  reconnect(): Promise<void>;
  createAgent(name: string): Promise<boolean>;
  resolveApproval(approvalId: string, granted: boolean): Promise<void>;
  unpair(): Promise<void>;
  dismissProblem(): void;
  request<M extends MethodName>(method: M, params: MethodInput<M>): Promise<MethodOutput<M>>;
}

export interface AppStoreDeps {
  readonly session: SessionStore;
  readonly createConnection: (options: HostConnectionOptions) => Connection;
  readonly platform: DevicePlatform;
  readonly deviceName: () => string;
  /** Live transcript events are handed to the transcript store. */
  readonly onTranscriptEvent: (event: EventName, payload: unknown) => void;
  /** Called when the client recovered a dropped link, before the re-query. */
  readonly onHostReconnected: () => void;
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

async function attempt<T>(work: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error };
  }
}

function upsert<T extends { id: string }>(items: readonly T[], item: T): readonly T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function offlineProblem(): Problem {
  return {
    code: 'cancelled',
    title: 'No host connection',
    detail: 'The phone is not connected to the host right now, so this was not sent. Reconnect and try again.',
    retryable: true,
    needsHostMachine: false,
  };
}

export function createAppStore(deps: AppStoreDeps): AppStore {
  const store = createStore<AppSnapshot>({
    status: 'starting',
    host: null,
    connection: connectionView({ clientState: 'idle', paired: false, hasBeenReady: false, detail: null }),
    deviceClass: null,
    deviceId: null,
    hostStatus: null,
    agents: [],
    approvals: [],
    loadedAt: null,
    refreshing: false,
    problem: null,
    pairing: { busy: false, error: null },
    resolvingApprovalId: null,
    creatingAgent: false,
  });

  let active: Connection | null = null;
  let link: ConnectionSnapshot | null = null;
  let paired = false;
  let booted = false;

  const view = (): ConnectionView =>
    connectionView({
      clientState: link?.clientState ?? 'idle',
      paired,
      hasBeenReady: link?.hasBeenReady ?? false,
      detail: link?.detail ?? null,
    });

  const patch = (changes: Partial<AppSnapshot>): void => {
    store.update((current) => ({ ...current, ...changes, connection: view() }));
  };

  const handleEvent = (event: EventName, payload: unknown): void => {
    if (event === 'transcript.appended' || event === 'transcript.delta') {
      deps.onTranscriptEvent(event, payload);
      return;
    }

    if (event === 'agent.updated') {
      const parsed = EventPayloads['agent.updated'].safeParse(payload);
      if (parsed.success) patch({ agents: upsert(store.get().agents, parsed.data.agent) });
      return;
    }

    if (event === 'approval.requested') {
      const parsed = EventPayloads['approval.requested'].safeParse(payload);
      if (!parsed.success) return;
      const approval = parsed.data.approval;
      patch({
        approvals:
          approval.status === 'pending'
            ? upsert(store.get().approvals, approval)
            : store.get().approvals.filter((candidate) => candidate.id !== approval.id),
      });
      return;
    }

    if (event === 'approval.resolved') {
      const parsed = EventPayloads['approval.resolved'].safeParse(payload);
      if (!parsed.success) return;
      const resolvedId = parsed.data.approval.id;
      patch({ approvals: store.get().approvals.filter((candidate) => candidate.id !== resolvedId) });
      return;
    }

    if (event === 'host.shutdown') {
      const parsed = EventPayloads['host.shutdown'].safeParse(payload);
      patch({
        problem: {
          code: 'cancelled',
          title: 'The host is shutting down',
          detail: parsed.success ? parsed.data.reason : 'The host stopped.',
          retryable: true,
          needsHostMachine: true,
        },
      });
    }
  };

  const connect = async (endpoint: HostEndpoint, token: string, host: PersistedHost): Promise<void> => {
    const previous = active;
    active = null;
    link = null;
    paired = true;
    if (previous !== null) await previous.stop().catch(() => undefined);
    patch({ status: 'paired', host, deviceClass: null, deviceId: null, problem: null });

    const next = deps.createConnection({
      endpoint,
      token,
      onEvent: handleEvent,
      onChange: (snapshot) => {
        link = snapshot;
        patch({ deviceClass: snapshot.deviceClass, deviceId: snapshot.deviceId });
      },
      onReconnected: () => {
        deps.onHostReconnected();
        void refresh();
      },
    });
    active = next;

    try {
      await next.start();
    } catch (error) {
      // The client keeps retrying in the background; the banner says so and
      // offers a manual retry, so this is a state and not a dead end.
      patch({ problem: describeError(error) });
      return;
    }
    await refresh();
  };

  const refresh = async (): Promise<void> => {
    const connection = active;
    if (connection === null || store.get().status !== 'paired') return;

    patch({ refreshing: true });
    const [status, agents, approvals] = await Promise.all([
      attempt(connection.request('host.status', {})),
      attempt(connection.request('agents.list', {})),
      attempt(connection.request('approvals.list', { status: 'pending' })),
    ]);

    const failed = [status, agents, approvals].find((result) => !result.ok);
    patch({
      refreshing: false,
      ...(status.ok ? { hostStatus: status.value } : {}),
      ...(agents.ok ? { agents: agents.value.agents, loadedAt: new Date().toISOString() } : {}),
      ...(approvals.ok ? { approvals: approvals.value.approvals } : {}),
      problem: failed === undefined ? null : describeError(failed.error),
    });
  };

  return {
    get: store.get,
    subscribe: store.subscribe,

    async bootstrap(): Promise<void> {
      if (booted) return;
      booted = true;

      let host: PersistedHost | null = null;
      let token: string | null = null;
      try {
        host = await deps.session.loadHost();
        token = await deps.session.loadToken();
      } catch (error) {
        // A storage failure must land on the pairing screen, not on a blank one.
        patch({ status: 'unpaired', problem: describeError(error) });
        return;
      }

      if (host === null || token === null) {
        patch({ status: 'unpaired', host });
        return;
      }
      await connect({ host: host.host, port: host.port }, token, host);
    },

    async pair(endpoint: HostEndpoint, pairingId: string, code: string): Promise<void> {
      patch({ pairing: { busy: true, error: null } });

      // A separate, anonymous link: the host only lets an unauthenticated
      // session call `pairing.claim`.
      const candidate = deps.createConnection({
        endpoint,
        token: null,
        onEvent: () => undefined,
        onChange: () => undefined,
        onReconnected: () => undefined,
      });

      try {
        await candidate.start();
        const claimed = await candidate.request('pairing.claim', {
          pairingId,
          code,
          deviceName: deps.deviceName(),
          platform: deps.platform,
          // A remote device is only ever granted `background`; asking for
          // anything else would be refused, and the host would downgrade it.
          requestedClass: 'background',
        });

        const host: PersistedHost = {
          host: endpoint.host,
          port: endpoint.port,
          deviceId: claimed.device.id,
          deviceName: claimed.device.name,
        };
        await deps.session.saveToken(claimed.token);
        await deps.session.saveHost(host);
        await candidate.stop().catch(() => undefined);

        patch({ host, pairing: { busy: false, error: null }, problem: null });
        // The anonymous socket cannot re-authenticate after a drop, so the app
        // keeps the token and dials again with it.
        await connect(endpoint, claimed.token, host);
      } catch (error) {
        await candidate.stop().catch(() => undefined);
        patch({ pairing: { busy: false, error: pairingMessage(error, endpoint) } });
      }
    },

    refresh,

    async reconnect(): Promise<void> {
      const host = store.get().host;
      const token = host === null ? null : await deps.session.loadToken().catch(() => null);
      if (host === null || token === null) {
        patch({ status: 'unpaired', deviceId: null, deviceClass: null });
        return;
      }
      await connect({ host: host.host, port: host.port }, token, host);
    },

    async createAgent(name: string): Promise<boolean> {
      const current = store.get();
      const capability = capabilityFor(current.deviceClass, 'agents.create');
      if (!capability.allowed) {
        // Sending this would guarantee a `forbidden`; explain it instead.
        patch({
          problem: {
            code: 'forbidden',
            title: capability.title,
            detail: capability.detail,
            retryable: false,
            needsHostMachine: true,
          },
        });
        return false;
      }

      const connection = active;
      if (connection === null) {
        patch({ problem: offlineProblem() });
        return false;
      }

      patch({ creatingAgent: true });
      try {
        const agent = await connection.request('agents.create', { name });
        patch({ agents: upsert(store.get().agents, agent), creatingAgent: false, problem: null });
        return true;
      } catch (error) {
        patch({ creatingAgent: false, problem: describeError(error) });
        return false;
      }
    },

    async resolveApproval(approvalId: string, granted: boolean): Promise<void> {
      const capability = capabilityFor(store.get().deviceClass, 'approvals.resolve');
      if (!capability.allowed) {
        patch({
          problem: {
            code: 'forbidden',
            title: capability.title,
            detail: capability.detail,
            retryable: false,
            needsHostMachine: true,
          },
        });
        return;
      }

      const connection = active;
      if (connection === null) {
        patch({ problem: offlineProblem() });
        return;
      }

      patch({ resolvingApprovalId: approvalId });
      try {
        await connection.request('approvals.resolve', { approvalId, granted });
        patch({
          approvals: store.get().approvals.filter((candidate) => candidate.id !== approvalId),
          resolvingApprovalId: null,
          problem: null,
        });
      } catch (error) {
        patch({ resolvingApprovalId: null, problem: describeError(error) });
      }
    },

    async unpair(): Promise<void> {
      const previous = active;
      active = null;
      link = null;
      paired = false;
      if (previous !== null) await previous.stop().catch(() => undefined);
      await deps.session.clearToken().catch(() => undefined);
      patch({
        status: 'unpaired',
        deviceClass: null,
        deviceId: null,
        hostStatus: null,
        agents: [],
        approvals: [],
        loadedAt: null,
        refreshing: false,
        problem: null,
        pairing: { busy: false, error: null },
      });
    },

    dismissProblem(): void {
      patch({ problem: null });
    },

    request<M extends MethodName>(method: M, params: MethodInput<M>): Promise<MethodOutput<M>> {
      const connection = active;
      if (connection === null) {
        return Promise.reject({ code: 'cancelled', message: 'not connected to a host', retryable: true } satisfies RpcError);
      }
      return connection.request(method, params);
    },
  };
}
