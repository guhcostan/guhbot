import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition, ToolExecutionContext } from '@guhbot/agent';
import { Host } from '@guhbot/host-core';
import type { RunContext, RunExecutor, Session } from '@guhbot/host-core';
import type { Entry } from '@guhbot/protocol';
import { createMemoryCapability, type MemoryCapability, type MemoryStoreSlice } from '../src/index.js';

/**
 * Test harness.
 *
 * Two levels, because the capability has two halves that fail differently:
 *
 *  - `FakeSlice` drives the store directly. It is a plain object — the store's
 *    only dependency is `getMeta`/`setMeta`/`getAgent`/`listAgents`/
 *    `listUnfinishedRuns` — so cap and correction behaviour is testable without a
 *    database, a socket or a clock.
 *  - `mountMemory` builds a **real** `Host` with the capability mounted exactly
 *    the way the application does it, for the properties that only exist at the
 *    authorization and serialization boundary.
 */

/** A clock the test owns, so every timestamp in a suite is chosen, not observed. */
export class Clock {
  private ms: number;

  constructor(start: string) {
    this.ms = Date.parse(start);
  }

  readonly now = (): number => this.ms;

  advance(ms: number): string {
    this.ms += ms;
    return new Date(this.ms).toISOString();
  }
}

/** An in-memory stand-in for the slice of `host-core`'s `Store` the capability uses. */
export class FakeSlice implements MemoryStoreSlice {
  readonly meta = new Map<string, string>();
  readonly agents = new Set<string>();
  /** Agent ids with a run that has not finished. */
  runsInFlight: string[] = [];

  getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }

  getAgent(id: string): { id: string } | null {
    return this.agents.has(id) ? { id } : null;
  }

  listAgents(): { id: string }[] {
    return [...this.agents].map((id) => ({ id }));
  }

  listUnfinishedRuns(): { agentId: string }[] {
    return this.runsInFlight.map((agentId) => ({ agentId }));
  }

  /** The raw stored payload for an agent, or null when nothing was ever written. */
  payload(agentId: string): string | null {
    return this.getMeta(`memory.agent.${agentId}`);
  }
}

export interface MountOptions {
  dataDir?: string;
  agentId?: string;
  maxMemoriesPerAgent?: number;
  maxBytesPerAgent?: number;
  maxTextChars?: number;
  recallLimit?: number;
  now?: () => number;
  /** Replaces the capability's default executor with one the test drives. */
  executor?: RunExecutor;
}

export interface Mounted {
  host: Host;
  capability: MemoryCapability;
  dataDir: string;
}

/**
 * Build a real Host with the memory capability mounted the way the application
 * does it: the capability is created first and reaches the store through a
 * getter, because the host needs the capability's methods at construction time.
 */
export function mountMemory(options: MountOptions = {}): Mounted {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'guhbot-memory-'));
  const holder: { host: Host | null } = { host: null };

  const capability = createMemoryCapability({
    store: () => {
      if (holder.host === null) throw new Error('the host has not been constructed yet');
      return holder.host.store;
    },
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    ...(options.maxMemoriesPerAgent !== undefined ? { maxMemoriesPerAgent: options.maxMemoriesPerAgent } : {}),
    ...(options.maxBytesPerAgent !== undefined ? { maxBytesPerAgent: options.maxBytesPerAgent } : {}),
    ...(options.maxTextChars !== undefined ? { maxTextChars: options.maxTextChars } : {}),
    ...(options.recallLimit !== undefined ? { recallLimit: options.recallLimit } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const host = new Host({
    dataDir,
    version: '0.0.0-test',
    mode: 'self-hosted',
    capabilities: capability.flags ?? {},
    extraMethods: capability.methods ?? {},
    ...(options.executor !== undefined ? { executor: options.executor } : {}),
  });
  holder.host = host;

  return { host, capability, dataDir };
}

/** A paired device, authenticated the way a client is. */
export function deviceSession(host: Host, deviceClass: 'person' | 'background'): Session {
  const device = host.store.createDevice({
    name: `${deviceClass} device`,
    platform: 'ios',
    deviceClass,
    tokenSalt: Buffer.from('test-salt'),
    tokenHash: Buffer.from('test-hash'),
  });
  return host.createSession('network', device);
}

/** The tool a capability contributed, by name. */
export function toolNamed(capability: MemoryCapability, name: string): ToolDefinition {
  const tool = (capability.tools?.() ?? []).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool;
}

/** A `ToolExecutionContext` stand-in; the memory tools touch none of it but the signal. */
export function toolContext(cwd = process.cwd()): ToolExecutionContext {
  return {
    readSecret: () => null,
    cwd,
    signal: new AbortController().signal,
    note: () => undefined,
  };
}

/** Run a tool and parse its JSON result, which is the only shape these tools return. */
export async function runTool(
  tool: ToolDefinition,
  args: unknown,
  context: ToolExecutionContext = toolContext(),
): Promise<Record<string, unknown>> {
  const output = await tool.execute(args, context);
  const parsed: unknown = JSON.parse(output);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`tool ${tool.name} did not return a JSON object: ${output}`);
  }
  return parsed as Record<string, unknown>;
}

/** The full `Agent` row a `RunContext` carries; tests never vary it. */
export function agentRow(id: string): RunContext['agent'] {
  return {
    id,
    name: `Agent ${id}`,
    status: 'active',
    instructions: '',
    model: null,
    avatarUrl: null,
    hidden: false,
    draftingDisabled: false,
    notifyOnUpdates: true,
    unreadCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

export interface FakeRunContext {
  context: RunContext;
  entries: { role: Entry['role']; kind: Entry['kind']; content: string; toolName: string | null }[];
  /** Every approval the run asked for, in order. */
  approvals: { summary: string; granted: boolean }[];
}

/**
 * A `RunContext` without a database.
 *
 * Copied in shape from the agent package's loop tests: the loop is driven by the
 * same interface the host implements, so an approval decision can be asserted
 * without parking a real run.
 */
export function fakeRunContext(
  agentId: string,
  options: { grantApprovals?: boolean; prompt?: string } = {},
): FakeRunContext {
  const entries: FakeRunContext['entries'] = [];
  const approvals: FakeRunContext['approvals'] = [];
  const grant = options.grantApprovals ?? false;

  const context: RunContext = {
    run: {
      id: 'rn_test',
      agentId,
      status: 'running',
      promptEntryId: null,
      error: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
    },
    agent: agentRow(agentId),
    prompt: options.prompt ?? 'do the thing',
    history: [],
    append: (input) => {
      entries.push({ role: input.role, kind: input.kind, content: input.content, toolName: input.toolName ?? null });
      return {
        id: `en_${entries.length}`,
        agentId,
        seq: entries.length - 1,
        runId: 'rn_test',
        role: input.role,
        kind: input.kind,
        content: input.content,
        toolName: input.toolName ?? null,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
    },
    emitDelta: () => undefined,
    readSecret: () => null,
    requestApproval: async (input) => {
      approvals.push({ summary: input.summary, granted: grant });
      return {
        id: `ap_${approvals.length}`,
        agentId,
        runId: 'rn_test',
        kind: 'tool-permission',
        status: grant ? 'granted' : 'denied',
        summary: input.summary,
        detail: '{}',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        resolvedAt: null,
        resolutionNote: null,
      };
    },
    isCancelled: () => false,
  };

  return { context, entries, approvals };
}
