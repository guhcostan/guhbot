import { assertHttpUrl } from '../config.js';
import { McpError, errorMessage } from '../errors.js';
import {
  encodeMessage,
  isNotification,
  isResponse,
  isServerRequest,
  parseJsonRpcText,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from '../jsonrpc.js';
import { readSseEvents } from '../sse.js';
import { linkSignals, unsupportedRequestError, type CallOptions, type McpTransport, type TransportHooks } from '../transport.js';

/**
 * Streamable HTTP transport.
 *
 * One POST per JSON-RPC message. The server answers either with a single JSON
 * document or with a short SSE stream carrying the response, and both are
 * accepted because both are in the field. The server may also hand back a
 * session id header on `initialize`, which every later request must echo.
 *
 * There is no retry here on purpose: `tools/call` is not idempotent, so
 * retrying a request whose response was lost could run a remote side effect
 * twice.
 */

export interface StreamableHttpTransportOptions extends TransportHooks {
  serverName: string;
  url: string;
  headers?: Record<string, string> | undefined;
}

const SESSION_HEADER = 'mcp-session-id';

export class StreamableHttpTransport implements McpTransport {
  readonly kind = 'http' as const;
  readonly pid = null;

  private readonly endpoint: URL;
  private sessionId: string | null = null;
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: StreamableHttpTransportOptions) {
    this.endpoint = assertHttpUrl(options.url, options.serverName);
  }

  async start(): Promise<void> {
    // Re-validated in the constructor: a transport that can be constructed with
    // a `file:` URL is a transport that will fetch one.
    assertHttpUrl(this.options.url, this.options.serverName);
  }

  async call(method: string, params: Record<string, unknown> | undefined, options: CallOptions): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return this.post(message, options, id);
  }

  async notify(method: string, params?: Record<string, unknown> | undefined): Promise<void> {
    const message: JsonRpcMessage = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
    await this.post(message, { timeoutMs: 30_000 }, null);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async post(message: JsonRpcMessage, options: CallOptions, expectId: number | null): Promise<unknown> {
    if (this.closed) throw new McpError('closed', `MCP server "${this.options.serverName}" is closed`);

    const link = linkSignals([options.signal]);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      link.abort(new Error('timeout'));
    }, options.timeoutMs);
    timer.unref?.();

    const method = 'method' in message ? message.method : 'response';

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: encodeMessage(message),
        signal: link.signal,
        redirect: 'error',
      });

      const sessionId = response.headers.get(SESSION_HEADER);
      if (sessionId !== null && sessionId.length > 0) this.sessionId = sessionId.slice(0, 512);

      if (!response.ok) {
        // The URL, the request headers and the response body are all kept out
        // of the message: any of them can carry a credential.
        throw new McpError('http', `MCP server "${this.options.serverName}" answered ${response.status} for ${method}`);
      }

      if (expectId === null) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (contentType.includes('text/event-stream')) {
        return await this.readFromStream(response, expectId, method, options);
      }

      const text = await response.text();
      const parsed = parseJsonRpcText(text);
      if (!parsed) {
        throw new McpError('protocol', `MCP server "${this.options.serverName}" answered ${method} with a non-JSON-RPC body`);
      }
      if (isNotification(parsed)) return undefined;
      return this.unwrap(parsed, expectId, method);
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (timedOut) {
        throw new McpError('timeout', `MCP server "${this.options.serverName}" timed out after ${options.timeoutMs}ms answering ${method}`);
      }
      if (options.signal?.aborted) {
        throw new McpError('cancelled', `MCP request ${method} to "${this.options.serverName}" was cancelled`);
      }
      throw new McpError('http', `MCP request ${method} to "${this.options.serverName}" failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
      link.cleanup();
    }
  }

  private async readFromStream(
    response: Response,
    expectId: number,
    method: string,
    options: CallOptions,
  ): Promise<unknown> {
    if (!response.body) {
      throw new McpError('protocol', `MCP server "${this.options.serverName}" sent an empty event stream for ${method}`);
    }

    for await (const event of readSseEvents(response.body)) {
      if (event.data.trim().length === 0) continue;
      const message = parseJsonRpcText(event.data);
      if (!message) continue;
      if (isResponse(message)) {
        if (message.id !== expectId) {
          this.options.onLog?.(`mcp/${this.options.serverName}: ignoring an unmatched response on the event stream`);
          continue;
        }
        return this.unwrap(message, expectId, method);
      }
      if (isServerRequest(message)) {
        await this.answerUnsupported(message, options);
        continue;
      }
      if (isNotification(message)) this.options.onNotification?.(message);
    }

    throw new McpError(
      'closed',
      `MCP server "${this.options.serverName}" closed the event stream before answering ${method}`,
    );
  }

  private unwrap(message: JsonRpcMessage, expectId: number, method: string): unknown {
    if (!isResponse(message) || message.id !== expectId) {
      throw new McpError('protocol', `MCP server "${this.options.serverName}" answered ${method} with an unrelated message`);
    }
    if ('error' in message) {
      throw new McpError(
        'protocol',
        `MCP server "${this.options.serverName}" rejected ${method}: ${message.error.message.slice(0, 2000)} (code ${message.error.code})`,
      );
    }
    return message.result;
  }

  private async answerUnsupported(request: JsonRpcRequest, options: CallOptions): Promise<void> {
    // Replying to a server-initiated request is optional in practice; doing it
    // keeps a server that waits for an answer from stalling the session.
    const link = linkSignals([options.signal]);
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: encodeMessage(unsupportedRequestError(request)),
        signal: link.signal,
        redirect: 'error',
      });
    } catch {
      this.options.onLog?.(`mcp/${this.options.serverName}: could not answer a server-initiated request`);
    } finally {
      link.cleanup();
    }
  }

  private headers(): Record<string, string> {
    return {
      ...(this.options.headers ?? {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.sessionId === null ? {} : { [SESSION_HEADER]: this.sessionId }),
    };
  }
}
