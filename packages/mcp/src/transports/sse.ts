import { assertHttpUrl } from '../config.js';
import { McpError, errorMessage } from '../errors.js';
import {
  PendingRequests,
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
 * Legacy HTTP+SSE transport, kept because servers in the field still ship it.
 *
 * The shape is two channels: a long-lived GET that carries an `endpoint` event
 * naming where to POST, and that POST URL for everything going the other way.
 * Responses arrive on the GET stream, so `call` posts and then waits for the id
 * to come back over the stream.
 */

export interface SseTransportOptions extends TransportHooks {
  serverName: string;
  url: string;
  headers?: Record<string, string> | undefined;
}

export class SseTransport implements McpTransport {
  readonly kind = 'sse' as const;
  readonly pid = null;

  private readonly streamUrl: URL;
  private readonly pending: PendingRequests;
  private readonly streamController = new AbortController();
  private endpoint: URL | null = null;
  private endpointWaiters: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] = [];
  private streamTask: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: SseTransportOptions) {
    this.streamUrl = assertHttpUrl(options.url, options.serverName);
    this.pending = new PendingRequests(
      (method) => new McpError('timeout', `MCP server "${options.serverName}" timed out answering ${method}`),
    );
  }

  async start(): Promise<void> {
    if (this.streamTask) return;
    this.streamTask = this.readStream();
    // The endpoint event can be slow; a server that never sends one must fail
    // the handshake rather than hang it.
    await this.waitForEndpoint(15_000);
  }

  async call(method: string, params: Record<string, unknown> | undefined, options: CallOptions): Promise<unknown> {
    const { id, promise } = this.pending.begin(method, options.timeoutMs);
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };

    const link = linkSignals([options.signal]);
    const onAbort = (): void => {
      this.pending.cancel(id, new McpError('cancelled', `MCP request ${method} to "${this.options.serverName}" was cancelled`));
    };
    if (link.signal.aborted) onAbort();
    else link.signal.addEventListener('abort', onAbort, { once: true });

    try {
      await this.post(message, method);
    } catch (error) {
      // The request never reached the server; its pending entry would only
      // become an unhandled rejection at the timeout.
      this.pending.cancel(id, error instanceof Error ? error : new McpError('closed', String(error)));
      throw error;
    }

    try {
      return await promise;
    } finally {
      link.signal.removeEventListener('abort', onAbort);
      link.cleanup();
    }
  }

  async notify(method: string, params?: Record<string, unknown> | undefined): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }, method);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.streamController.abort(new Error('closed'));
    this.pending.failAll(new McpError('closed', `MCP server "${this.options.serverName}" was shut down`));
    this.settleEndpoint(new McpError('closed', `MCP server "${this.options.serverName}" was shut down`));
    try {
      await this.streamTask;
    } catch {
      // The stream task reports its own failure to the pending calls.
    }
  }

  private async waitForEndpoint(timeoutMs: number): Promise<void> {
    if (this.endpoint) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.endpointWaiters = this.endpointWaiters.filter((waiter) => waiter.timer !== timer);
        reject(new McpError('protocol', `MCP server "${this.options.serverName}" never sent an SSE endpoint event`));
      }, timeoutMs);
      timer.unref?.();
      this.endpointWaiters.push({ resolve, reject, timer });
    });
  }

  private settleEndpoint(error?: Error): void {
    const waiters = this.endpointWaiters;
    this.endpointWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  private async readStream(): Promise<void> {
    try {
      const response = await fetch(this.streamUrl, {
        method: 'GET',
        headers: { ...(this.options.headers ?? {}), accept: 'text/event-stream' },
        signal: this.streamController.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        throw new McpError('http', `MCP server "${this.options.serverName}" answered ${response.status} for the SSE stream`);
      }
      if (!response.body) {
        throw new McpError('protocol', `MCP server "${this.options.serverName}" sent an empty SSE stream`);
      }

      for await (const event of readSseEvents(response.body)) {
        if (event.event === 'endpoint') {
          try {
            this.endpoint = new URL(event.data.trim(), this.streamUrl);
          } catch {
            throw new McpError('protocol', `MCP server "${this.options.serverName}" sent an unusable SSE endpoint`);
          }
          this.settleEndpoint();
          continue;
        }
        if (event.data.trim().length === 0) continue;
        const message = parseJsonRpcText(event.data);
        if (!message) continue;
        this.handleMessage(message);
      }
      throw new McpError('closed', `MCP server "${this.options.serverName}" closed its SSE stream`);
    } catch (error) {
      const failure = error instanceof McpError ? error : new McpError('closed', `MCP SSE stream for "${this.options.serverName}" failed: ${errorMessage(error)}`);
      this.pending.failAll(failure);
      this.settleEndpoint(failure);
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      if (!this.pending.settle(message)) {
        this.options.onLog?.(`mcp/${this.options.serverName}: ignoring a response with an unknown id`);
      }
      return;
    }
    if (isServerRequest(message)) {
      void this.answerUnsupported(message);
      return;
    }
    if (isNotification(message)) this.options.onNotification?.(message);
  }

  private async answerUnsupported(request: JsonRpcRequest): Promise<void> {
    try {
      await this.post(unsupportedRequestError(request), 'response');
    } catch {
      this.options.onLog?.(`mcp/${this.options.serverName}: could not answer a server-initiated request`);
    }
  }

  private async post(message: JsonRpcMessage, method: string): Promise<void> {
    const endpoint = this.endpoint;
    if (!endpoint || this.closed) {
      throw new McpError('closed', `MCP server "${this.options.serverName}" has no SSE endpoint yet (${method})`);
    }
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { ...(this.options.headers ?? {}), 'content-type': 'application/json' },
        body: encodeMessage(message),
        // Closing the session aborts an in-flight POST too.
        signal: this.streamController.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (this.closed) throw new McpError('closed', `MCP server "${this.options.serverName}" was shut down`);
      throw new McpError('http', `MCP request ${method} to "${this.options.serverName}" failed: ${errorMessage(error)}`);
    }
    if (!response.ok) {
      throw new McpError('http', `MCP server "${this.options.serverName}" answered ${response.status} for ${method}`);
    }
    await response.body?.cancel().catch(() => undefined);
  }
}
