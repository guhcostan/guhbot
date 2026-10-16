import type { Capability } from '@guhbot/agent';
import { McpManager, type McpManagerOptions, type McpServerState } from './manager.js';
import { buildMcpMethods } from './rpc.js';

/**
 * MCP capability: how this host borrows other people's tools.
 *
 * Three transports, one client. A stdio server is a child process speaking
 * JSON-RPC on stdin/stdout, a streamable HTTP server is a POST per message, and
 * a legacy SSE server is an event stream plus a POST endpoint. All three end up
 * as `ToolDefinition`s the model can call, namespaced `<server>__<tool>`.
 *
 * ## Using it
 *
 * ```ts
 * const mcp = createMcpCapability({
 *   allowStdio: true,                       // explicit: this spawns local code
 *   servers: [{ name: 'files', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] }],
 * });
 * await mcp.ready();                        // discovery is asynchronous
 * const tools = mcp.tools();                // one per discovered tool
 * ```
 *
 * `tools()` is synchronous and returns whatever has been discovered so far, so
 * a host that wants MCP tools in the first run must `await ready()` before it
 * collects contributions. `tools()` also starts the connection on first call,
 * which keeps a host that never awaits from silently doing nothing.
 */

export interface McpCapabilityOptions extends McpManagerOptions {}

export interface McpCapability extends Capability {
  readonly name: 'mcp';
  /** Resolves when the initial connect/discovery pass has finished. Never rejects. */
  ready: () => Promise<void>;
  /** Live connection state, for status surfaces. */
  states: () => McpServerState[];
  /** The manager, for a host that wants to drive connect/reload directly. */
  readonly manager: McpManager;
}

export function createMcpCapability(options: McpCapabilityOptions = {}): McpCapability {
  const manager = new McpManager(options);

  // Kick the connection off at construction: discovery is asynchronous and the
  // Capability seam is not, so the work starts here and `ready()` exposes it.
  const startup = manager.start();

  return {
    name: 'mcp',
    summary: 'Borrows tools from external Model Context Protocol servers over stdio, HTTP or SSE.',
    flags: { mcp: true },
    tools: () => manager.tools(),
    methods: buildMcpMethods(manager),
    ready: () => startup,
    states: () => manager.states(),
    manager,
    dispose: () => manager.dispose(),
  };
}

export { MCP_PROTOCOL_VERSION, flattenContentBlocks, parseToolEntry, truncate } from './client.js';
export type { DiscoveredTool, McpClientOptions, McpToolResult } from './client.js';
export {
  MCP_TOOL_SEPARATOR,
  McpServerConfigSchema,
  assertHttpUrl,
  isEnabled,
  namespaceSegment,
  parseServerConfig,
} from './config.js';
export type { McpServerConfig, McpServerTransport, StdioServerConfig, UrlServerConfig } from './config.js';
export { buildChildEnv, isSecretLikeEnvName } from './env.js';
export { McpError, errorMessage } from './errors.js';
export type { McpErrorCode } from './errors.js';
export {
  PendingRequests,
  encodeMessage,
  isNotification,
  isRecord,
  isResponse,
  isServerRequest,
  parseJsonRpcMessage,
  parseJsonRpcText,
} from './jsonrpc.js';
export type {
  JsonRpcErrorBody,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccess,
} from './jsonrpc.js';
export { McpClient } from './client.js';
export { McpManager } from './manager.js';
export type { McpManagerOptions, McpServerState, McpServerStatus, McpToolInfo } from './manager.js';
export { buildMcpMethods } from './rpc.js';
export { createSseParser, readSseEvents } from './sse.js';
export type { SseEvent, SseParser } from './sse.js';
export { StdioTransport } from './transports/stdio.js';
export type { StdioTransportOptions } from './transports/stdio.js';
export { StreamableHttpTransport } from './transports/http.js';
export type { StreamableHttpTransportOptions } from './transports/http.js';
export { SseTransport } from './transports/sse.js';
export type { SseTransportOptions } from './transports/sse.js';
export { linkSignals } from './transport.js';
export type { CallOptions, McpTransport, McpTransportKind, SignalLink, TransportHooks } from './transport.js';
