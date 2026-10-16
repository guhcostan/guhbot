import { McpError, errorMessage } from './errors.js';
import { isRecord } from './jsonrpc.js';
import type { CallOptions, McpTransport } from './transport.js';

/**
 * The MCP client: handshake, tool discovery, tool calls.
 *
 * Everything here treats the server as untrusted input. A server is a remote
 * program of unknown quality and intent; it can return a tool list that is not
 * an array, entries without names, a name with a newline in it, or a
 * multi-megabyte base64 image. None of that may throw inside the host, hang a
 * run, or fill a transcript, so each response is parsed defensively and shaped
 * before it goes anywhere else.
 */

/** Protocol revision this client offers. The server may pick an older one. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

const CLIENT_INFO = { name: 'guhbot', version: '0.1.0' } as const;

const MAX_PAGES = 20;
const MAX_TOOLS = 1000;
const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_RESULT_CHARS = 100_000;

export interface DiscoveredTool {
  /** The name the server knows. Never the name the model sees. */
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface McpToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export interface McpClientOptions {
  serverName: string;
  transport: McpTransport;
  requestTimeoutMs?: number | undefined;
  /** `initialize` gets its own budget: a cold `npx` download is slow. */
  initTimeoutMs?: number | undefined;
  maxTools?: number | undefined;
  maxResultChars?: number | undefined;
  onNotification?: ((method: string) => void) | undefined;
  onLog?: ((line: string) => void) | undefined;
}

export class McpClient {
  private readonly transport: McpTransport;
  private readonly serverName: string;
  private readonly requestTimeoutMs: number;
  private readonly initTimeoutMs: number;
  private readonly maxTools: number;
  private readonly maxResultChars: number;
  private protocolVersion: string = MCP_PROTOCOL_VERSION;
  private serverInfo = '';

  constructor(private readonly options: McpClientOptions) {
    this.transport = options.transport;
    this.serverName = options.serverName;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.initTimeoutMs = options.initTimeoutMs ?? 60_000;
    this.maxTools = options.maxTools ?? MAX_TOOLS;
    this.maxResultChars = options.maxResultChars ?? MAX_RESULT_CHARS;
  }

  get pid(): number | null {
    return this.transport.pid;
  }

  /** Version the server chose, after `initialize`. */
  get negotiatedVersion(): string {
    return this.protocolVersion;
  }

  get serverDescription(): string {
    return this.serverInfo;
  }

  async connect(signal?: AbortSignal | undefined): Promise<void> {
    await this.transport.start();
    const result = await this.request(
      'initialize',
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, clientInfo: CLIENT_INFO },
      { timeoutMs: this.initTimeoutMs, signal },
    );

    const info = isRecord(result) ? result : {};
    this.protocolVersion = typeof info.protocolVersion === 'string' ? info.protocolVersion : MCP_PROTOCOL_VERSION;
    this.serverInfo = describeServer(info.serverInfo) ?? this.serverName;
    // We accept the server's chosen revision instead of refusing a mismatch:
    // `tools/list` and `tools/call` have been stable across revisions, and
    // refusing would make an older server unusable for no security gain.

    await this.transport.notify('notifications/initialized');
  }

  async listTools(signal?: AbortSignal | undefined): Promise<DiscoveredTool[]> {
    const tools: DiscoveredTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.request('tools/list', cursor === undefined ? {} : { cursor }, { timeoutMs: this.requestTimeoutMs, signal });

      if (!isRecord(result)) {
        this.log('tools/list returned a non-object result; treating the server as having no tools');
        break;
      }

      const list = result.tools;
      if (list !== undefined && !Array.isArray(list)) {
        this.log('tools/list returned a non-array "tools" field; ignoring it');
        break;
      }

      for (const entry of list ?? []) {
        const tool = parseToolEntry(entry);
        if (!tool) {
          // A malformed entry is skipped, not fatal: one bad tool must not cost
          // the user every other tool on that server.
          this.log('skipping a malformed entry in tools/list');
          continue;
        }
        tools.push(tool);
        if (tools.length >= this.maxTools) {
          this.log(`server offered more than ${this.maxTools} tools; ignoring the rest`);
          return tools;
        }
      }

      const next = result.nextCursor;
      if (typeof next !== 'string' || next.length === 0) break;
      if (seenCursors.has(next)) {
        this.log('tools/list repeated a cursor; stopping pagination');
        break;
      }
      seenCursors.add(next);
      cursor = next;
    }

    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, options: CallOptions): Promise<McpToolResult> {
    const result = await this.request('tools/call', { name, arguments: args }, options);
    if (!isRecord(result)) {
      throw new McpError('protocol', `MCP server "${this.serverName}" answered tools/call with a non-object result`);
    }

    const isError = result.isError === true;
    let text = flattenContentBlocks(result.content, this.maxResultChars);
    if (text.length === 0 && isRecord(result.structuredContent)) {
      // Servers that return machine-readable output and no text blocks still
      // owe the model something it can read.
      text = truncate(safeJson(result.structuredContent), this.maxResultChars);
    }
    if (text.length === 0) text = '(the tool returned no content)';
    return { text, isError };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private request(method: string, params: Record<string, unknown> | undefined, options: CallOptions): Promise<unknown> {
    return this.transport.call(method, params, options);
  }

  private log(message: string): void {
    this.options.onLog?.(`mcp/${this.serverName}: ${message}`);
  }
}

function describeServer(info: unknown): string | null {
  if (!isRecord(info) || typeof info.name !== 'string') return null;
  const version = typeof info.version === 'string' ? info.version : '';
  return version.length > 0 ? `${info.name} ${version}` : info.name;
}

/**
 * Validate one `tools/list` entry.
 *
 * Returns null for anything unusable. The name is length-capped because it
 * becomes part of a model-facing tool name and a 1 MB name is a denial of
 * service on the transcript, not a tool.
 */
export function parseToolEntry(entry: unknown): DiscoveredTool | null {
  if (!isRecord(entry)) return null;
  if (typeof entry.name !== 'string') return null;
  const name = entry.name.trim();
  if (name.length === 0 || name.length > 256) return null;
  // Control characters would corrupt a transcript and a tool name alike.
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;

  const description = typeof entry.description === 'string' ? entry.description.slice(0, MAX_DESCRIPTION_CHARS) : '';
  const parameters = isRecord(entry.inputSchema) ? entry.inputSchema : { type: 'object', properties: {} };
  return { name, description, parameters };
}

/**
 * Flatten MCP content blocks into one string for the model.
 *
 * Binary blocks become a short placeholder on purpose. Inlining a base64 image
 * into a tool result would spend the entire context window on data the model
 * cannot read, so the placeholder says what was dropped and how large it was.
 */
export function flattenContentBlocks(content: unknown, maxChars = MAX_RESULT_CHARS): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];

  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = typeof block.type === 'string' ? block.type : 'unknown';

    if (type === 'text') {
      if (typeof block.text === 'string') parts.push(block.text);
      continue;
    }

    if (type === 'image' || type === 'audio') {
      const mime = typeof block.mimeType === 'string' ? block.mimeType : 'unknown type';
      parts.push(`[${type}: ${mime}, ${describeBase64(block.data)} omitted]`);
      continue;
    }

    if (type === 'resource') {
      const resource = isRecord(block.resource) ? block.resource : {};
      const uri = typeof resource.uri === 'string' ? resource.uri.slice(0, 2048) : 'unknown';
      if (typeof resource.text === 'string') {
        parts.push(resource.text);
        continue;
      }
      const mime = typeof resource.mimeType === 'string' ? resource.mimeType : 'unknown type';
      parts.push(`[resource: ${uri} (${mime}, ${describeBase64(resource.blob)} omitted)]`);
      continue;
    }

    if (type === 'resource_link') {
      const uri = typeof block.uri === 'string' ? block.uri.slice(0, 2048) : 'unknown';
      parts.push(`[resource link: ${uri}]`);
      continue;
    }

    parts.push(`[unsupported content block: ${type}]`);
  }

  return truncate(parts.join('\n'), maxChars);
}

function describeBase64(data: unknown): string {
  if (typeof data !== 'string') return 'unknown size';
  return `~${Math.round((data.length * 3) / 4)} bytes`;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... truncated ${text.length - maxChars} characters]`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch (error) {
    return `[unserializable result: ${errorMessage(error)}]`;
  }
}
