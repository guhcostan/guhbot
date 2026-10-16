import type { ToolDefinition, ToolExecutionContext } from '@guhbot/agent';
import { McpClient, parseToolEntry, type DiscoveredTool } from './client.js';
import {
  MCP_TOOL_SEPARATOR,
  isEnabled,
  namespaceSegment,
  parseServerConfig,
  type McpServerConfig,
} from './config.js';
import { McpError, errorMessage } from './errors.js';
import { isRecord, type JsonRpcNotification } from './jsonrpc.js';
import { StdioTransport } from './transports/stdio.js';
import { StreamableHttpTransport } from './transports/http.js';
import { SseTransport } from './transports/sse.js';
import type { McpTransport, McpTransportKind } from './transport.js';

/**
 * Owns every configured server: registration, connection, discovery and the
 * mapping from a model-facing tool name back to the server that offered it.
 *
 * The routing rule is the whole point. A tool name the model sees is
 * `<namespace>__<tool>`, and the closure that executes it carries the server it
 * came from. A call can therefore only ever reach the server that advertised
 * the tool — there is no lookup by name at call time that a crafted tool name
 * could redirect to another server.
 */

export type McpServerStatus = 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpServerState {
  name: string;
  transport: McpTransportKind;
  enabled: boolean;
  status: McpServerStatus;
  error: string | null;
  toolCount: number;
  pid: number | null;
}

export interface McpToolInfo {
  server: string;
  /** The server's own name for the tool. */
  name: string;
  /** The name the model sees. */
  exposedName: string;
  description: string;
  enabled: boolean;
}

export interface McpManagerOptions {
  servers?: McpServerConfig[] | undefined;
  /** Explicit opt-in before any stdio command is spawned. Default false. */
  allowStdio?: boolean | undefined;
  /** Whether a discovered tool needs a human before it runs. Default true. */
  requireApproval?: boolean | undefined;
  requestTimeoutMs?: number | undefined;
  initTimeoutMs?: number | undefined;
  maxTools?: number | undefined;
  maxResultChars?: number | undefined;
  /** SIGTERM grace before SIGKILL on shutdown. Mainly for tests. */
  killGraceMs?: number | undefined;
  onLog?: ((line: string) => void) | undefined;
}

interface ServerEntry {
  readonly config: McpServerConfig;
  client: McpClient | null;
  discovered: DiscoveredTool[];
  /** Tools the user switched off, by the server's own name. */
  readonly disabledTools: Set<string>;
  status: McpServerStatus;
  error: string | null;
}

export class McpManager {
  private readonly entries = new Map<string, ServerEntry>();
  private readonly namespaces = new Map<string, string>();
  private startPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: McpManagerOptions) {
    for (const candidate of options.servers ?? []) {
      this.register(parseServerConfig(candidate));
    }
  }

  /**
   * Register a server. Refuses anything that could not be routed unambiguously,
   * and refuses stdio without the explicit opt-in.
   */
  private register(config: McpServerConfig): ServerEntry {
    if (this.entries.has(config.name)) {
      throw new McpError('config', `an MCP server named "${config.name}" is already registered`);
    }

    if (config.transport === 'stdio' && isEnabled(config) && this.options.allowStdio !== true) {
      throw new McpError(
        'refused',
        `refusing to configure stdio MCP server "${config.name}": spawning a local process is arbitrary ` +
          `code execution on this machine. Pass allowStdio: true to opt in deliberately.`,
      );
    }

    const namespace = namespaceSegment(config.name);
    const clash = this.namespaces.get(namespace);
    if (clash !== undefined) {
      throw new McpError(
        'config',
        `MCP servers "${clash}" and "${config.name}" both map to the tool namespace "${namespace}"; ` +
          'rename one of them so their tools stay distinguishable',
      );
    }
    this.namespaces.set(namespace, config.name);

    const entry: ServerEntry = {
      config,
      client: null,
      discovered: [],
      disabledTools: new Set(),
      status: isEnabled(config) ? 'disconnected' : 'disabled',
      error: null,
    };
    this.entries.set(config.name, entry);
    return entry;
  }

  /** Connect and discover every enabled server that is not connected yet. */
  async start(): Promise<void> {
    if (this.disposed) return;
    if (!this.startPromise) this.startPromise = this.connectAll();
    await this.startPromise;
  }

  private async connectAll(): Promise<void> {
    const pending = [...this.entries.values()].filter((entry) => entry.status === 'disconnected');
    // One unreachable server must not stop the others from loading.
    await Promise.all(pending.map((entry) => this.connectEntry(entry).catch(() => undefined)));
  }

  /** Connect one server, recording the outcome on its state. */
  private async connectEntry(entry: ServerEntry): Promise<void> {
    entry.status = 'connecting';
    entry.error = null;
    let client: McpClient | null = null;

    // A connect is slow (a cold `npx` can take seconds), so dispose or a
    // removal can land while it is still in flight. Whoever wins that race must
    // not leave a spawned process behind: every await below is followed by this
    // check before the client is adopted.
    const stale = (): boolean => this.disposed || this.entries.get(entry.config.name) !== entry;

    try {
      client = this.createClient(entry, (message) => {
        // Only the *current* client may report a death: a deliberate close
        // during reload or dispose detaches it first, so a shutdown is never
        // misreported as a crash.
        if (this.disposed || entry.client !== client) return;
        entry.client = null;
        entry.discovered = [];
        entry.status = 'error';
        entry.error = `the server ${message}`;
      });
      await client.connect();
      if (stale()) {
        await client.close().catch(() => undefined);
        return;
      }

      entry.client = client;
      entry.status = 'connected';
      try {
        entry.discovered = await client.listTools();
      } catch (error) {
        // The handshake worked, so the server is reachable; only discovery
        // failed. Say that, instead of calling the whole server broken.
        entry.error = errorMessage(error);
        this.log(`mcp/${entry.config.name}: tool discovery failed: ${errorMessage(error)}`);
      }

      if (stale()) {
        const adopted = entry.client;
        entry.client = null;
        entry.discovered = [];
        entry.status = 'disconnected';
        await adopted?.close().catch(() => undefined);
      }
    } catch (error) {
      entry.status = 'error';
      entry.error = errorMessage(error);
      entry.discovered = [];
      if (client) await client.close().catch(() => undefined);
      throw error;
    }
  }

  private createClient(entry: ServerEntry, onExit: (message: string) => void): McpClient {
    const config = entry.config;
    const hooks = {
      onLog: (line: string) => this.log(line),
      onNotification: (notification: JsonRpcNotification) => {
        this.log(`mcp/${config.name}: notification ${notification.method}`);
      },
    };

    let transport: McpTransport;
    if (config.transport === 'stdio') {
      transport = new StdioTransport({
        serverName: config.name,
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
        // The host-level check already ran; this one is the transport's own
        // guarantee that no code path spawns a process without the opt-in.
        allowStdio: this.options.allowStdio === true,
        killGraceMs: this.options.killGraceMs,
        onExit,
        ...hooks,
      });
    } else if (config.transport === 'http') {
      transport = new StreamableHttpTransport({ serverName: config.name, url: config.url, headers: config.headers, ...hooks });
    } else {
      transport = new SseTransport({ serverName: config.name, url: config.url, headers: config.headers, ...hooks });
    }

    return new McpClient({
      serverName: config.name,
      transport,
      requestTimeoutMs: this.options.requestTimeoutMs,
      initTimeoutMs: this.options.initTimeoutMs,
      maxTools: this.options.maxTools,
      maxResultChars: this.options.maxResultChars,
      onLog: (line) => this.log(line),
      onNotification: (method) => this.log(`mcp/${config.name}: notification ${method}`),
    });
  }

  /** Register and connect a server at runtime (`mcp.connect`). */
  async addServer(config: unknown): Promise<McpServerState> {
    if (this.disposed) throw new McpError('closed', 'the MCP capability has been disposed');
    const parsed = parseServerConfig(config);
    const entry = this.register(parsed);
    if (entry.status === 'disabled') return stateOf(entry);
    try {
      await this.connectEntry(entry);
    } catch (error) {
      // Keep the registration: the user can fix the target and reload instead
      // of retyping the whole configuration.
      throw new McpError('closed', `MCP server "${parsed.name}" could not be connected: ${errorMessage(error)}`);
    }
    return stateOf(entry);
  }

  /** Unregister a server and stop it if it is running. */
  async removeServer(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry) return false;
    this.entries.delete(name);
    this.namespaces.delete(namespaceSegment(name));
    const client = entry.client;
    entry.client = null;
    entry.discovered = [];
    entry.status = 'disconnected';
    if (client) await client.close().catch(() => undefined);
    return true;
  }

  /** Reconnect and re-read tool lists. Returns how many servers were re-read. */
  async reload(name?: string | undefined): Promise<number> {
    if (this.disposed) throw new McpError('closed', 'the MCP capability has been disposed');
    const targets = name === undefined ? [...this.entries.values()] : [this.requireEntry(name)];
    let refreshed = 0;

    for (const entry of targets) {
      if (!isEnabled(entry.config)) continue;
      const client = entry.client;
      entry.client = null;
      entry.discovered = [];
      entry.status = 'disconnected';
      if (client) await client.close().catch(() => undefined);
      try {
        await this.connectEntry(entry);
        refreshed += 1;
      } catch (error) {
        this.log(`mcp/${entry.config.name}: reload failed: ${errorMessage(error)}`);
      }
    }

    return refreshed;
  }

  /**
   * One definition per discovered tool, across every enabled server.
   *
   * Called by the host at start, and again whenever it wants a fresh view.
   */
  tools(): ToolDefinition[] {
    // A host that collects tools without awaiting `ready()` still gets the
    // connection started; it will see the tools on its next collection.
    void this.start();

    const definitions: ToolDefinition[] = [];
    const claimed = new Map<string, string>();

    for (const entry of this.entries.values()) {
      if (!isEnabled(entry.config)) continue;
      const namespace = namespaceSegment(entry.config.name);

      for (const tool of entry.discovered) {
        if (entry.disabledTools.has(tool.name)) continue;

        const exposed = `${namespace}${MCP_TOOL_SEPARATOR}${namespaceSegment(tool.name)}`;
        const owner = claimed.get(exposed);
        if (owner !== undefined) {
          // Two servers cannot own one model-facing name: silently keeping the
          // last one would let a later server shadow another's tool.
          this.log(`skipping ${entry.config.name}.${tool.name}: ${exposed} is already offered by ${owner}`);
          continue;
        }
        claimed.set(exposed, `${entry.config.name}.${tool.name}`);

        definitions.push({
          name: exposed,
          description: tool.description.length > 0 ? tool.description : `MCP tool "${tool.name}" on server "${entry.config.name}".`,
          parameters: tool.parameters,
          // A remote tool is opaque: nobody can tell from its schema whether it
          // sends mail or deletes a repository, so a human sees the first call.
          requiresApproval: this.options.requireApproval !== false,
          execute: (args: unknown, context: ToolExecutionContext) => this.executeTool(entry, tool, exposed, args, context),
        });
      }
    }

    return definitions;
  }

  private async executeTool(
    entry: ServerEntry,
    tool: DiscoveredTool,
    exposed: string,
    args: unknown,
    context: ToolExecutionContext,
  ): Promise<string> {
    const result = await this.callTool(entry.config.name, tool.name, args, context.signal);
    // Rendered the way the loop renders its own tool failures, so the model
    // treats a remote failure as a failed call rather than as fresh content.
    return result.isError ? `Error: MCP tool "${exposed}" failed: ${result.text}` : result.text;
  }

  /** Invoke one tool on one server. Never spawns anything; routing only. */
  async callTool(
    serverName: string,
    toolName: string,
    args: unknown,
    signal?: AbortSignal | undefined,
  ): Promise<{ text: string; isError: boolean }> {
    const entry = this.requireEntry(serverName);
    if (entry.status !== 'connected' || !entry.client) {
      const detail = entry.error === null ? entry.status : `${entry.status}: ${entry.error}`;
      throw new McpError('closed', `MCP server "${serverName}" is not connected (${detail})`);
    }

    const tool = findDiscoveredTool(entry, toolName);
    if (!tool) {
      throw new McpError('config', `MCP server "${serverName}" has no tool named "${toolName}"${availableHint(entry)}`);
    }
    if (entry.disabledTools.has(tool.name)) {
      throw new McpError('config', `MCP tool "${tool.name}" on "${serverName}" is disabled`);
    }

    return entry.client.callTool(tool.name, isRecord(args) ? args : {}, {
      timeoutMs: this.options.requestTimeoutMs ?? 30_000,
      signal,
    });
  }

  setToolEnabled(serverName: string, toolName: string, enabled: boolean): McpToolInfo {
    const entry = this.requireEntry(serverName);
    const tool = findDiscoveredTool(entry, toolName);
    if (!tool) {
      throw new McpError('config', `MCP server "${serverName}" has no tool named "${toolName}"${availableHint(entry)}`);
    }
    if (enabled) entry.disabledTools.delete(tool.name);
    else entry.disabledTools.add(tool.name);
    return toolInfoOf(entry, tool);
  }

  toolsFor(serverName?: string | undefined): McpToolInfo[] {
    const entries = serverName === undefined ? [...this.entries.values()] : [this.requireEntry(serverName)];
    const tools: McpToolInfo[] = [];
    for (const entry of entries) {
      for (const tool of entry.discovered) tools.push(toolInfoOf(entry, tool));
    }
    return tools;
  }

  states(): McpServerState[] {
    return [...this.entries.values()].map(stateOf);
  }

  /** Server names currently registered. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const clients = [...this.entries.values()].map((entry) => entry.client);
    for (const entry of this.entries.values()) {
      entry.client = null;
      entry.status = isEnabled(entry.config) ? 'disconnected' : 'disabled';
    }
    await Promise.all(clients.map((client) => client?.close().catch(() => undefined)));
  }

  private requireEntry(name: string): ServerEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new McpError('config', `no MCP server named "${name}"`);
    return entry;
  }

  private log(line: string): void {
    this.options.onLog?.(line);
  }
}

function stateOf(entry: ServerEntry): McpServerState {
  return {
    name: entry.config.name,
    transport: entry.config.transport,
    enabled: isEnabled(entry.config),
    status: entry.status,
    error: entry.error,
    toolCount: entry.discovered.length,
    pid: entry.client?.pid ?? null,
  };
}

function toolInfoOf(entry: ServerEntry, tool: DiscoveredTool): McpToolInfo {
  return {
    server: entry.config.name,
    name: tool.name,
    exposedName: `${namespaceSegment(entry.config.name)}${MCP_TOOL_SEPARATOR}${namespaceSegment(tool.name)}`,
    description: tool.description,
    enabled: !entry.disabledTools.has(tool.name),
  };
}

/** Resolve a tool by the server's name or by the name the model was shown. */
function findDiscoveredTool(entry: ServerEntry, name: string): DiscoveredTool | null {
  const namespace = namespaceSegment(entry.config.name);
  for (const tool of entry.discovered) {
    if (tool.name === name) return tool;
    if (`${namespace}${MCP_TOOL_SEPARATOR}${namespaceSegment(tool.name)}` === name) return tool;
  }
  return null;
}

/** A bounded list of what the server actually offers, for a useful error. */
function availableHint(entry: ServerEntry): string {
  if (entry.discovered.length === 0) return '';
  const names = entry.discovered.slice(0, 10).map((tool) => tool.name);
  const suffix = entry.discovered.length > names.length ? `, ... (${entry.discovered.length} total)` : '';
  return `; it offers: ${names.join(', ')}${suffix}`;
}

export { MCP_TOOL_SEPARATOR, parseToolEntry };
