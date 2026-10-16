import type { ContributedMethod, Host, Session } from '@guhbot/host-core';
import type { AuthzClass } from '@guhbot/protocol';
import { z } from 'zod';
import { McpServerConfigSchema } from './config.js';
import type { McpManager } from './manager.js';

/**
 * The client-facing surface.
 *
 * ## Why these names differ from the ones in `packages/protocol`
 *
 * The protocol registry already declares `mcp.list`, `mcp.add`, `mcp.remove`,
 * `mcp.listTools`, `mcp.setToolEnabled` and `mcp.refresh`, and `host-core`
 * already ships stub handlers for them. `buildRegistry` refuses a capability
 * contribution that would redefine a core method, so a capability contributing
 * those exact names would fail the host start. This package therefore
 * contributes the same capabilities under distinct, still-namespaced names:
 *
 *   mcp.servers       <- mcp.list          (background)
 *   mcp.tools         <- mcp.listTools     (background)
 *   mcp.connect       <- mcp.add           (person)
 *   mcp.disconnect    <- mcp.remove        (person)
 *   mcp.setToolState  <- mcp.setToolEnabled(person)
 *   mcp.reload        <- mcp.refresh       (background)
 *   mcp.callTool      <- (new)             (person)
 *
 * Wiring `@guhbot/protocol`'s `mcp.*` names to this manager would need a change
 * outside this package (host-core resolves those names to its own stubs), and
 * `mcp.refresh` is declared `background` there while reconnecting a stdio
 * server spawns a process; that decision belongs to the host, not here.
 */

const StateSchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http', 'sse']),
  enabled: z.boolean(),
  status: z.enum(['disabled', 'disconnected', 'connecting', 'connected', 'error']),
  error: z.string().nullable(),
  toolCount: z.number().int().min(0),
  pid: z.number().int().nullable(),
});

const ToolInfoSchema = z.object({
  server: z.string(),
  name: z.string(),
  exposedName: z.string(),
  description: z.string().max(20_000),
  enabled: z.boolean(),
});

interface MethodSpec<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  authz: AuthzClass;
  summary: string;
  input: I;
  output: O;
  handler: (input: z.infer<I>, host: Host, session: Session) => Promise<z.infer<O>>;
}

/**
 * Declare the contract next to the handler.
 *
 * `host.dispatch` validates the input schema before the handler runs, so the
 * cast inside is the runtime's own guarantee rather than an assumption.
 */
function defineMethod<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(spec: MethodSpec<I, O>): ContributedMethod {
  return {
    authz: spec.authz,
    summary: spec.summary,
    input: spec.input,
    output: spec.output,
    handler: (host, session, input) => spec.handler(input as z.infer<I>, host, session),
  };
}

export function buildMcpMethods(manager: McpManager): Record<string, ContributedMethod> {
  return {
    'mcp.servers': defineMethod({
      authz: 'background',
      summary: 'Configured MCP servers, their connection state and tool counts.',
      input: z.object({}),
      output: z.object({ servers: z.array(StateSchema) }),
      handler: async () => ({ servers: manager.states() }),
    }),

    'mcp.tools': defineMethod({
      authz: 'background',
      summary: 'Tools discovered from connected MCP servers, with the name the model sees.',
      input: z.object({ serverName: z.string().min(1).max(200).optional() }),
      output: z.object({ tools: z.array(ToolInfoSchema) }),
      handler: async (input) => ({ tools: manager.toolsFor(input.serverName) }),
    }),

    'mcp.connect': defineMethod({
      authz: 'person',
      summary: 'Register an MCP server and connect to it. A stdio server runs a local command.',
      input: McpServerConfigSchema,
      output: StateSchema,
      handler: async (input) => manager.addServer(input),
    }),

    'mcp.disconnect': defineMethod({
      authz: 'person',
      summary: 'Unregister an MCP server and stop its process or stream.',
      input: z.object({ serverName: z.string().min(1).max(200) }),
      output: z.object({ removed: z.boolean() }),
      handler: async (input) => ({ removed: await manager.removeServer(input.serverName) }),
    }),

    'mcp.reload': defineMethod({
      authz: 'background',
      summary: 'Reconnect MCP servers and re-read their tool lists.',
      input: z.object({ serverName: z.string().min(1).max(200).optional() }),
      output: z.object({ refreshed: z.number().int().min(0) }),
      handler: async (input) => ({ refreshed: await manager.reload(input.serverName) }),
    }),

    'mcp.setToolState': defineMethod({
      authz: 'person',
      summary: 'Enable or disable one MCP tool for future runs.',
      input: z.object({
        serverName: z.string().min(1).max(200),
        toolName: z.string().min(1).max(256),
        enabled: z.boolean(),
      }),
      output: ToolInfoSchema,
      handler: async (input) => manager.setToolEnabled(input.serverName, input.toolName, input.enabled),
    }),

    'mcp.callTool': defineMethod({
      authz: 'person',
      summary: 'Invoke one MCP tool on one server, outside a run.',
      input: z.object({
        serverName: z.string().min(1).max(200),
        toolName: z.string().min(1).max(256),
        args: z.record(z.unknown()).optional(),
      }),
      output: z.object({ text: z.string(), isError: z.boolean() }),
      handler: async (input) => manager.callTool(input.serverName, input.toolName, input.args),
    }),
  };
}
