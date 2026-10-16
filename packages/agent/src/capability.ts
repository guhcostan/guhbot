import type { ContributedMethod } from '@guhbot/host-core';
import type { ToolDefinition } from './types.js';

/**
 * The capability seam.
 *
 * A capability is one self-contained unit of extra function: the browser,
 * MCP, voice, the macOS Messages bridge, remote desktop. Everything a
 * capability contributes arrives through this one interface, which is what lets
 * capabilities live in their own packages without any of them editing the
 * runtime, the protocol registry or each other.
 *
 * ## What a capability may contribute
 *
 *  - **tools** the model can call,
 *  - **RPC methods** clients can call, each carrying its own authorization class
 *    and schemas,
 *  - **status flags** so `host.status` can tell a client which abilities this
 *    host actually has, rather than the client assuming.
 *
 * It may not open a socket, write to the database directly, or add a fifth kind
 * of thing. See `docs/engineering.md`.
 *
 * ## Example
 *
 * ```ts
 * export function createClockCapability(): Capability {
 *   return {
 *     name: 'clock',
 *     summary: 'Lets an agent read the current time.',
 *     flags: { clock: true },
 *     tools: () => [{
 *       name: 'now',
 *       description: 'Return the current ISO-8601 timestamp.',
 *       parameters: { type: 'object', properties: {} },
 *       requiresApproval: false,
 *       execute: async () => new Date().toISOString(),
 *     }],
 *   };
 * }
 * ```
 */
export interface Capability {
  /** Stable identifier, lowercase, used in logs and error messages. */
  readonly name: string;
  /** One line, shown in diagnostics. */
  readonly summary: string;
  /** Merged into `host.status.capabilities`. Keep keys stable; clients read them. */
  readonly flags?: Record<string, boolean>;
  /**
   * Prepare the capability before its contributions are read.
   *
   * Some capabilities cannot declare their tools until they have talked to
   * something: MCP has to connect to each server and ask what it offers. Without
   * this hook the first `tools()` call would return an empty list and the tools
   * would silently only appear later, which reads as "MCP is broken".
   */
  readonly ready?: () => Promise<void>;

  /** Tools contributed to every agent run. Called after `ready` has resolved. */
  readonly tools?: () => ToolDefinition[];
  /**
   * RPC methods contributed to the host. Each entry must also be reachable by
   * name from a client, so give it a descriptive, namespaced name
   * (`browser.screenshot`, not `screenshot`) and an honest `authz` class.
   */
  readonly methods?: Record<string, ContributedMethod>;
  /** Called when the host shuts down. Release browsers, child processes, sockets. */
  readonly dispose?: () => Promise<void>;
}

/**
 * Validate a capability at construction time.
 *
 * Catching a bad capability here rather than at first use means a malformed
 * plugin fails the host start loudly instead of surfacing as a confusing runtime
 * error in the middle of a run.
 */
export function assertCapability(capability: Capability): void {
  if (!/^[a-z][a-z0-9-]*$/.test(capability.name)) {
    throw new Error(`capability name must be lowercase kebab-case, got ${JSON.stringify(capability.name)}`);
  }
  if (capability.summary.trim().length < 10) {
    throw new Error(`capability ${capability.name} needs a longer summary`);
  }
  for (const [method, spec] of Object.entries(capability.methods ?? {})) {
    if (!method.includes('.')) {
      throw new Error(
        `capability ${capability.name} contributes method ${method}; method names must be namespaced, e.g. "${capability.name}.${method}"`,
      );
    }
    if (spec.authz !== 'person' && spec.authz !== 'background') {
      throw new Error(`capability ${capability.name} method ${method} needs an authz class`);
    }
    if (spec.summary.trim().length < 10) {
      throw new Error(`capability ${capability.name} method ${method} needs a longer summary`);
    }
  }
  for (const tool of capability.tools?.() ?? []) {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error(`capability ${capability.name} tool name must be snake_case, got ${JSON.stringify(tool.name)}`);
    }
    if (typeof tool.requiresApproval !== 'boolean') {
      throw new Error(
        `capability ${capability.name} tool ${tool.name} must state requiresApproval explicitly — ` +
          'a tool that mutates anything outside the host needs a human in the loop',
      );
    }
  }
}

/**
 * Resolve every capability's `ready()` before its contributions are read.
 *
 * Sequential rather than concurrent: a capability that spawns child processes
 * (MCP over stdio) is easier to reason about, and to cancel, one at a time.
 * Failures are isolated — one unreachable MCP server must not stop the host from
 * starting with the capabilities that do work.
 */
export async function prepareCapabilities(
  capabilities: Capability[],
  onError?: (capability: string, error: unknown) => void,
): Promise<void> {
  for (const capability of capabilities) {
    if (!capability.ready) continue;
    try {
      await capability.ready();
    } catch (error) {
      onError?.(capability.name, error);
    }
  }
}

/** Merge capability contributions into the option bags the runtime expects. */
export function collectContributions(capabilities: Capability[]): {
  tools: ToolDefinition[];
  extraMethods: Record<string, ContributedMethod>;
  flags: Record<string, boolean>;
} {
  const tools: ToolDefinition[] = [];
  const extraMethods: Record<string, ContributedMethod> = {};
  const flags: Record<string, boolean> = {};
  const seenTools = new Set<string>();

  for (const capability of capabilities) {
    assertCapability(capability);
    for (const tool of capability.tools?.() ?? []) {
      if (seenTools.has(tool.name)) {
        throw new Error(`two capabilities both contribute a tool named ${tool.name}`);
      }
      seenTools.add(tool.name);
      tools.push(tool);
    }
    for (const [name, spec] of Object.entries(capability.methods ?? {})) {
      if (extraMethods[name]) {
        throw new Error(`two capabilities both contribute the method ${name}`);
      }
      extraMethods[name] = spec;
    }
    Object.assign(flags, capability.flags ?? {});
  }

  return { tools, extraMethods, flags };
}
