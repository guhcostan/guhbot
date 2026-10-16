import type { JsonRpcNotification, JsonRpcRequest } from './jsonrpc.js';

/**
 * The seam every MCP transport implements.
 *
 * One method, one response: the transports own framing, correlation and
 * timeouts, and the client above them only speaks methods and results. That is
 * what lets stdio, streamable HTTP and legacy SSE share the handshake, the tool
 * discovery and the tool call path.
 */
export type McpTransportKind = 'stdio' | 'http' | 'sse';

export interface CallOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export interface McpTransport {
  readonly kind: McpTransportKind;
  /** Acquire whatever the transport needs (spawn a child, open a stream). */
  start(): Promise<void>;
  call(method: string, params: Record<string, unknown> | undefined, options: CallOptions): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown> | undefined): Promise<void>;
  /** Release everything. Safe to call twice. */
  close(): Promise<void>;
  /** OS process id for a spawned server; null for an HTTP transport. */
  readonly pid: number | null;
}

/** What a transport does with a message the server sent on its own initiative. */
export interface TransportHooks {
  onNotification?: ((notification: JsonRpcNotification) => void) | undefined;
  /** Diagnostic line for the host's log. Never a request payload. */
  onLog?: ((line: string) => void) | undefined;
}

/** The reply this client sends to a server-initiated request it cannot serve. */
export function unsupportedRequestError(request: JsonRpcRequest): {
  jsonrpc: '2.0';
  id: JsonRpcRequest['id'];
  error: { code: number; message: string };
} {
  return {
    jsonrpc: '2.0',
    id: request.id,
    error: {
      code: -32601,
      // Truncated: the method name comes from the server, and the reply goes
      // back over the wire.
      message: `this client does not implement ${request.method.slice(0, 200)}`,
    },
  };
}

export interface SignalLink {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
  cleanup(): void;
}

/**
 * Link an external signal (a cancelled run) to a controller this transport owns,
 * so a timeout and a cancellation both abort the same in-flight operation.
 */
export function linkSignals(signals: readonly (AbortSignal | undefined)[]): SignalLink {
  const controller = new AbortController();
  const listeners: { signal: AbortSignal; listener: () => void }[] = [];

  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
    listeners.push({ signal, listener });
  }

  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    cleanup: () => {
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
      listeners.length = 0;
    },
  };
}
