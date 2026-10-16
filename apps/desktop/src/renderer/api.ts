/**
 * Host connection for the renderer.
 *
 * The renderer holds no host logic. It owns one `GuhbotClient` and mirrors the
 * events it receives into React state, re-querying on reconnect. Everything it
 * displays is either an event it just received or the result of an explicit
 * request made moments ago.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Approval, Entry, HostStatus, Run } from '@guhbot/protocol';
import { GuhbotClient } from '@guhbot/server/client';

export interface DesktopBridge {
  hostUrl: string;
  token: string;
  platform: string;
  appVersion: string;
  openExternal: (url: string) => Promise<void>;
  quit: () => void;
}

declare global {
  interface Window {
    guhbotDesktop?: DesktopBridge;
  }
}

export interface HostState {
  status: 'connecting' | 'ready' | 'offline';
  deviceClass: 'person' | 'background' | null;
  host: HostStatus | null;
  agents: Agent[];
  activeAgentId: string | null;
  entries: Entry[];
  runs: Record<string, Run>;
  approvals: Approval[];
  error: string | null;
  /** The approval a human is answering right now, so buttons can stay honest. */
  resolvingApprovalId: string | null;
}

const EMPTY: HostState = {
  status: 'connecting',
  deviceClass: null,
  host: null,
  agents: [],
  activeAgentId: null,
  entries: [],
  runs: {},
  approvals: [],
  error: null,
  resolvingApprovalId: null,
};

export interface HostApi {
  state: HostState;
  selectAgent: (agentId: string) => void;
  sendPrompt: (text: string) => Promise<void>;
  resolveApproval: (approvalId: string, granted: boolean) => Promise<void>;
}

/**
 * Fold a `ready` frame into the state that describes this device.
 *
 * The `ready` frame is the only place a device ever learns its own authority
 * class, and losing it is not cosmetic: the Keeper mascot exists to show the
 * human what this device may do, so a dropped class makes the app describe
 * itself as a passive viewer even when it holds the operator token. An
 * unrecognised class leaves the previous value alone rather than guessing.
 */
export function applyReady(prev: HostState, payload: unknown): HostState {
  const { deviceClass } = (payload ?? {}) as { deviceClass?: unknown };
  if (deviceClass !== 'person' && deviceClass !== 'background') return prev;
  return { ...prev, deviceClass };
}

/**
 * The message half of an error. RPC failures arrive as plain `RpcError`
 * objects (a `{ code, message }` bag from the wire), not as `Error` instances,
 * so every surface that renders a failure has to read the message off that
 * union rather than assume one shape.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/**
 * Id under which a streamed delta is shown before its durable entry exists.
 * Sequence numbers address one row of the thread, so the placeholder has to be
 * recognisable as one — otherwise the durable entry lands beside it and the
 * human reads the same sentence twice.
 */
function placeholderId(seq: number): string {
  return `pending:${seq}`;
}

/**
 * Fold a durable transcript entry into the thread.
 *
 * An entry can arrive either way round: deltas usually stream first, but a
 * reconnect or a fast run can deliver the durable entry first. Either way the
 * thread ends up with exactly one row per sequence, and the durable entry is the
 * one that survives because it is the source of truth.
 */
export function applyAppended(prev: HostState, payload: unknown): HostState {
  const { entry } = payload as { entry: Entry };
  if (entry.agentId !== prev.activeAgentId) return prev;
  if (prev.entries.some((e) => e.id === entry.id)) return prev;
  const settled = prev.entries.filter((e) => e.id !== placeholderId(entry.seq));
  return { ...prev, entries: [...settled, entry].sort((a, b) => a.seq - b.seq) };
}

/** Fold one streamed text delta into the thread, creating a placeholder if needed. */
export function applyDelta(prev: HostState, payload: unknown): HostState {
  const delta = payload as { agentId: string; seq: number; textDelta: string };
  if (delta.agentId !== prev.activeAgentId) return prev;
  const existing = prev.entries.find((e) => e.seq === delta.seq);
  if (existing !== undefined) {
    // The durable entry already contains this text, so replaying the delta onto
    // it would double the run-on. Only a placeholder still needs the delta.
    if (existing.id !== placeholderId(delta.seq)) return prev;
    return {
      ...prev,
      entries: prev.entries.map((e) => (e.seq === delta.seq ? { ...e, content: e.content + delta.textDelta } : e)),
    };
  }
  const provisional: Entry = {
    id: placeholderId(delta.seq),
    agentId: delta.agentId,
    seq: delta.seq,
    runId: null,
    role: 'agent',
    kind: 'message',
    content: delta.textDelta,
    toolName: null,
    createdAt: new Date().toISOString(),
  };
  return { ...prev, entries: [...prev.entries, provisional].sort((a, b) => a.seq - b.seq) };
}

export function useHost(): HostApi {
  const [state, setState] = useState<HostState>(EMPTY);
  const clientRef = useRef<GuhbotClient | null>(null);
  const activeAgentRef = useRef<string | null>(null);

  const refresh = useCallback(async (client: GuhbotClient, agentId: string | null) => {
    try {
      const [status, agents, approvals] = await Promise.all([
        client.request('host.status', {}),
        client.request('agents.list', {}),
        client.request('approvals.list', { status: 'pending' }),
      ]);
      const target = agentId ?? agents.agents[0]?.id ?? null;
      const entries = target ? (await client.request('transcript.tail', { agentId: target, limit: 80 })).entries : [];
      activeAgentRef.current = target;
      setState((prev) => ({
        ...prev,
        status: 'ready',
        host: status,
        agents: agents.agents,
        approvals: approvals.approvals,
        activeAgentId: target,
        entries,
        error: null,
      }));
    } catch (error) {
      // A failed re-read is a renderable state, never an unhandled rejection:
      // the error bar shows what happened and the next reconnect retries.
      setState((prev) => ({ ...prev, error: errorMessage(error) }));
    }
  }, []);

  useEffect(() => {
    const bridge = window.guhbotDesktop;
    if (!bridge || bridge.hostUrl.length === 0) {
      setState((prev) => ({ ...prev, status: 'offline', error: 'The preload bridge did not provide a host URL.' }));
      return;
    }

    const client = new GuhbotClient({
      url: bridge.hostUrl,
      token: bridge.token,
      onError: (error) => {
        // A `forbidden` response is an expected state, not a failure: this device
        // simply is not allowed to do that. Surface it without tearing down.
        setState((prev) => ({ ...prev, error: errorMessage(error) }));
      },
    });
    clientRef.current = client;

    client.on('ready', (payload) => {
      setState((prev) => applyReady(prev, payload));
      void refresh(client, activeAgentRef.current);
    });
    client.on('reconnected', () => {
      // Deltas are lossy by design, so on reconnect we re-read rather than replay.
      void refresh(client, activeAgentRef.current);
    });
    client.on('transcript.appended', (payload) => {
      setState((prev) => applyAppended(prev, payload));
    });
    client.on('transcript.delta', (payload) => {
      setState((prev) => applyDelta(prev, payload));
    });
    client.on('run.updated', (payload) => {
      const { run } = payload as { run: Run };
      setState((prev) => ({ ...prev, runs: { ...prev.runs, [run.id]: run } }));
    });
    client.on('approval.requested', (payload) => {
      const { approval } = payload as { approval: Approval };
      setState((prev) => ({ ...prev, approvals: [approval, ...prev.approvals] }));
    });
    client.on('approval.resolved', (payload) => {
      const { approval } = payload as { approval: Approval };
      setState((prev) => ({ ...prev, approvals: prev.approvals.filter((a) => a.id !== approval.id) }));
    });
    client.on('agent.updated', (payload) => {
      const { agent } = payload as { agent: Agent };
      // Upsert, not replace: the host emits this for creations too, so a new
      // agent appears in the sidebar without a reconnect.
      setState((prev) => ({
        ...prev,
        agents: prev.agents.some((a) => a.id === agent.id)
          ? prev.agents.map((a) => (a.id === agent.id ? agent : a))
          : [...prev.agents, agent],
      }));
    });

    void client.connect().catch((error: unknown) => {
      setState((prev) => ({
        ...prev,
        status: 'offline',
        error: errorMessage(error),
      }));
    });

    return () => {
      void client.close();
      clientRef.current = null;
    };
  }, [refresh]);

  const selectAgent = useCallback(
    (agentId: string) => {
      activeAgentRef.current = agentId;
      setState((prev) => ({ ...prev, activeAgentId: agentId, entries: [] }));
      const client = clientRef.current;
      if (client) {
        void client
          .request('transcript.tail', { agentId, limit: 80 })
          .then((page) => setState((prev) => (prev.activeAgentId === agentId ? { ...prev, entries: page.entries } : prev)))
          .catch((error: unknown) => {
            // A failed switch is a renderable state, not a silent swallow: the
            // thread keeps its empty state honest and the error bar explains why.
            setState((prev) => ({ ...prev, error: errorMessage(error) }));
          });
      }
    },
    [],
  );

  const sendPrompt = useCallback(async (text: string) => {
    const client = clientRef.current;
    const agentId = activeAgentRef.current;
    if (!client || !agentId) return;
    try {
      await client.request('runs.start', { agentId, prompt: text });
    } catch (error) {
      setState((prev) => ({ ...prev, error: errorMessage(error) }));
    }
  }, []);

  const resolveApproval = useCallback(async (approvalId: string, granted: boolean) => {
    const client = clientRef.current;
    if (!client) return;
    setState((prev) => ({ ...prev, resolvingApprovalId: approvalId }));
    try {
      await client.request('approvals.resolve', { approvalId, granted });
    } catch (error) {
      setState((prev) => ({ ...prev, error: errorMessage(error) }));
    } finally {
      setState((prev) => ({ ...prev, resolvingApprovalId: null }));
    }
  }, []);

  return useMemo(
    () => ({ state, selectAgent, sendPrompt, resolveApproval }),
    [state, selectAgent, sendPrompt, resolveApproval],
  );
}
