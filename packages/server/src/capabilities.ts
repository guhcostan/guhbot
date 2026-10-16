import { createBrowserCapability } from '@guhbot/browser';
import { createMcpCapability, type McpServerConfig } from '@guhbot/mcp';
import { createMessagesCapability } from '@guhbot/messages';
import { collectContributions, prepareCapabilities, type Capability, type ToolDefinition } from '@guhbot/agent';
import type { ContributedMethod } from '@guhbot/host-core';

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
}

export interface MountedCapabilities {
  capabilities: Capability[];
  /** Merged into `host.status.capabilities`, so a client can see what is real. */
  flags: Record<string, boolean>;
  /** Handed to the agent loop. */
  tools: ToolDefinition[];
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

  const { tools, extraMethods, flags } = collectContributions(capabilities);

  return {
    capabilities,
    flags,
    tools,
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
