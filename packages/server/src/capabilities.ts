import { createBrowserCapability } from '@guhbot/browser';
import { createCanvasCapability } from '@guhbot/canvas';
import { createCredentialsCapability } from '@guhbot/credentials';
import { createMcpCapability, type McpServerConfig } from '@guhbot/mcp';
import { createMemoryCapability } from '@guhbot/memory';
import { createMessagesCapability } from '@guhbot/messages';
import { createSchedulerCapability } from '@guhbot/scheduler';
import { collectContributions, prepareCapabilities, type Capability, type ToolDefinition } from '@guhbot/agent';
import type { ContributedMethod, Host, RunContext } from '@guhbot/host-core';

/**
 * Capability mounting.
 *
 * The one place that decides which capabilities this host actually has, so that
 * the CLI, the desktop app and the hosted gateway all mount the same set from
 * the same rules. Three principles:
 *
 *  1. **A capability that is not configured is not mounted.** It is better for
 *     `host.status.capabilities` to say `browser: false` than for the agent to
 *     hold tools that can only fail.
 *  2. **Nothing is mounted that reaches the network by default.** The browser and
 *     `http_fetch` share one egress allow list; empty means nothing is reachable.
 *  3. **A capability that fails to start is dropped, not fatal.** One unreachable
 *     MCP server must not stop the host from serving the capabilities that work.
 */

export interface CapabilityMountConfig {
  /** Host data directory. Browser profiles and screenshots live under it. */
  dataDir: string;
  /** Hosts tools may reach. Empty means no egress at all. */
  allowedHosts?: readonly string[];
  /** Search endpoint with `{query}`. No default: there is no approved search API. */
  searchUrlTemplate?: string | undefined;
  browser?: { enabled?: boolean } | undefined;
  mcp?: { allowStdio?: boolean; servers?: McpServerConfig[] } | undefined;
  messages?: { allowed?: readonly string[]; databasePath?: string; platform?: NodeJS.Platform } | undefined;
  canvas?: { enabled?: boolean } | undefined;
  /**
   * The scheduler needs a live `Host` to start runs on, but the host needs the
   * capability's tools at construction. A getter resolves the cycle: the
   * scheduler declares its tools immediately, and only touches the host from its
   * first tick, which runs after construction.
   *
   * When omitted, no scheduler is mounted. That is the right default for a host
   * whose automations table nothing is reading yet.
   */
  scheduler?: { host: () => Host; pollMs?: number } | undefined;
  /**
   * Agent memory: short facts an agent writes down and recalls on a later run.
   *
   * On by default, for the same reason the canvas is: it writes only inside this
   * host's own store, is capped, and every fact is readable and deletable by the
   * human. `agentId` pins the capability to one agent, which is what removes the
   * "which agent is calling?" ambiguity; a host running several agents should set
   * it, or the tools refuse rather than guess whose memory to touch.
   */
  memory?: { enabled?: boolean; host: () => Host; agentId?: string } | undefined;
  /**
   * Per-origin credentials for sites the agent signs in to.
   *
   * Mounted whenever asked for. It reaches nothing on its own: a value only ever
   * enters because a human put it there, and it only ever leaves through an
   * approval that a `person`-class device resolved.
   */
  credentials?: { enabled?: boolean; host: () => Host } | undefined;
}

export interface MountedCapabilities {
  capabilities: Capability[];
  /** Merged into `host.status.capabilities`, so a client can see what is real. */
  flags: Record<string, boolean>;
  /** Handed to the agent loop. */
  tools: ToolDefinition[];
  /** Handed to the agent loop: extra system-prompt text, read once per run. */
  contextSections: Array<(context: RunContext) => string | null>;
  /** Registered alongside the core methods. */
  extraMethods: Record<string, ContributedMethod>;
  /** Names of capabilities that were mounted, for logs and diagnostics. */
  mounted: string[];
  /** Reasons a capability was skipped or failed, for diagnostics. */
  notes: string[];
  dispose: () => Promise<void>;
}

const EMPTY: MountedCapabilities = {
  capabilities: [],
  flags: {},
  tools: [],
  contextSections: [],
  extraMethods: {},
  mounted: [],
  notes: [],
  dispose: async () => undefined,
};

export async function mountCapabilities(config: CapabilityMountConfig): Promise<MountedCapabilities> {
  const capabilities: Capability[] = [];
  const notes: string[] = [];
  const allowedHosts = config.allowedHosts ?? [];

  // -- Browser --------------------------------------------------------------
  if (config.browser?.enabled === true) {
    if (allowedHosts.length === 0) {
      // Mounting it with no reachable hosts would hand the model seven tools that
      // can only return a refusal. Better to be honest and leave it out.
      notes.push('browser capability not mounted: no allowed hosts configured, so it could not navigate anywhere');
    } else {
      capabilities.push(
        createBrowserCapability({
          dataDir: config.dataDir,
          allowedHosts,
          ...(config.searchUrlTemplate !== undefined ? { searchUrlTemplate: config.searchUrlTemplate } : {}),
        }),
      );
    }
  }

  // -- MCP ------------------------------------------------------------------
  if (config.mcp !== undefined && (config.mcp.servers?.length ?? 0) > 0) {
    try {
      capabilities.push(
        createMcpCapability({
          servers: config.mcp.servers,
          // Defaults to false inside the capability too. Passing it explicitly
          // here keeps the decision visible at the point of configuration.
          allowStdio: config.mcp.allowStdio === true,
        }),
      );
    } catch (error) {
      notes.push(`mcp capability rejected its configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // -- Canvas ---------------------------------------------------------------
  if (config.canvas?.enabled !== false && config.canvas !== undefined) {
    // The canvas sandbox is the point of the capability, so it is mounted
    // unconditionally once asked for: its frames reach nothing unless a document
    // declares a host that is already on the egress list. No egress list means
    // every document is confined to `connect-src 'none'`, which is the safe case.
    capabilities.push(createCanvasCapability({ dataDir: config.dataDir, allowedHosts }));
  }

  // -- Scheduler ------------------------------------------------------------
  if (config.scheduler !== undefined) {
    capabilities.push(
      createSchedulerCapability({
        host: config.scheduler.host,
        ...(config.scheduler.pollMs !== undefined ? { pollMs: config.scheduler.pollMs } : {}),
      }),
    );
  }

  // -- Memory ---------------------------------------------------------------
  const memoryConfig = config.memory;
  if (memoryConfig !== undefined && memoryConfig.enabled !== false) {
    // Late-bound like the scheduler's: the store lives on a host that does not
    // exist yet when this capability declares its tools and methods.
    capabilities.push(
      createMemoryCapability({
        store: () => memoryConfig.host().store,
        ...(memoryConfig.agentId !== undefined ? { agentId: memoryConfig.agentId } : {}),
      }),
    );
  }

  // -- Credentials ----------------------------------------------------------
  const credentialsConfig = config.credentials;
  if (credentialsConfig !== undefined && credentialsConfig.enabled !== false) {
    capabilities.push(createCredentialsCapability({ host: credentialsConfig.host }));
  }

  // -- macOS Messages -------------------------------------------------------
  if (config.messages !== undefined && (config.messages.allowed?.length ?? 0) > 0) {
    const platform = config.messages.platform ?? process.platform;
    if (platform !== 'darwin') {
      notes.push(`messages capability not mounted: it requires macOS and this host is ${platform}`);
    } else {
      // Narrowed once, above, so the spread below cannot carry `undefined`.
      const allowed = config.messages.allowed ?? [];
      capabilities.push(
        createMessagesCapability({
          allowed,
          ...(config.messages.databasePath !== undefined ? { databasePath: config.messages.databasePath } : {}),
          platform,
        }),
      );
    }
  }

  if (capabilities.length === 0) {
    return { ...EMPTY, notes };
  }

  // MCP has to talk to its servers before it can say what tools it offers.
  await prepareCapabilities(capabilities, (name, error) => {
    notes.push(`capability ${name} failed to prepare: ${error instanceof Error ? error.message : String(error)}`);
  });

  const { tools, extraMethods, flags, contextSections } = collectContributions(capabilities);

  return {
    capabilities,
    flags,
    tools,
    contextSections,
    extraMethods,
    mounted: capabilities.map((c) => c.name),
    notes,
    dispose: async () => {
      // Reverse order, and isolated: one capability failing to clean up must not
      // strand the others' child processes or browser instances.
      for (const capability of [...capabilities].reverse()) {
        await capability.dispose?.().catch(() => undefined);
      }
    },
  };
}
