/**
 * JSON-RPC 2.0, narrowed.
 *
 * MCP is JSON-RPC 2.0 with a specific meaning for the id: a message that has one
 * is a request expecting exactly one response, and a message without one is a
 * notification that must never be answered or awaited. Getting that distinction
 * wrong hangs a call or provokes a reply storm, so it is decided here, once, by
 * inspecting the message rather than by trusting the caller's context.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcErrorBody;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number';
}

/**
 * Classify an already-parsed value. Anything that is not a well-formed JSON-RPC
 * 2.0 message is dropped: a broken server should degrade to "no tools", not
 * throw inside the transport's read loop.
 */
export function parseJsonRpcMessage(value: unknown): JsonRpcMessage | undefined {
  if (!isRecord(value) || value.jsonrpc !== '2.0') return undefined;

  if (typeof value.method === 'string') {
    if (hasOwn(value, 'id') && isId(value.id)) {
      return {
        jsonrpc: '2.0',
        id: value.id,
        method: value.method,
        ...(hasOwn(value, 'params') ? { params: value.params } : {}),
      };
    }
    // No usable id: a notification. `id: null` lands here too — the spec forbids
    // it in a request, and replying to it would be a reply to nothing.
    return {
      jsonrpc: '2.0',
      method: value.method,
      ...(hasOwn(value, 'params') ? { params: value.params } : {}),
    };
  }

  if (hasOwn(value, 'result') && isId(value.id)) {
    return { jsonrpc: '2.0', id: value.id, result: value.result };
  }

  if (isRecord(value.error) && typeof value.error.code === 'number' && typeof value.error.message === 'string') {
    return {
      jsonrpc: '2.0',
      id: isId(value.id) ? value.id : null,
      error: {
        code: value.error.code,
        message: value.error.message,
        ...(hasOwn(value.error, 'data') ? { data: value.error.data } : {}),
      },
    };
  }

  return undefined;
}

/** Parse a wire line and classify it. Unparseable input yields `undefined`. */
export function parseJsonRpcText(text: string): JsonRpcMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return parseJsonRpcMessage(parsed);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcSuccess | JsonRpcFailure {
  return 'id' in message && !('method' in message);
}

export function isServerRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

export function encodeMessage(message: JsonRpcMessage): string {
  return JSON.stringify(message);
}

interface PendingEntry {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Outstanding requests, keyed by the id this client minted.
 *
 * Shared by the stdio and SSE transports: both multiplex responses for several
 * concurrent calls over one stream, so both need the same id bookkeeping and the
 * same "the stream died, fail everything" behavior.
 */
export class PendingRequests {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingEntry>();

  constructor(private readonly timeoutError: (method: string) => Error) {}

  get size(): number {
    return this.pending.size;
  }

  begin(method: string, timeoutMs: number): { id: number; promise: Promise<unknown> } {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.timeoutError(method));
      }, timeoutMs);
      // A pending request must not hold the host's event loop open on shutdown;
      // the transport that owns it is kept alive by its child process or socket.
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
    });
    return { id, promise };
  }

  /** Resolve or reject the caller waiting on `message.id`. False when unknown. */
  settle(message: JsonRpcSuccess | JsonRpcFailure): boolean {
    // A null id is a response to a request that could not be parsed; we never
    // mint one, so there is nothing waiting for it.
    if (message.id === null) return false;
    const entry = this.pending.get(message.id);
    if (!entry) return false;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if ('error' in message) {
      const detail = message.error.message.slice(0, 2000);
      entry.reject(new McpProtocolFailure(message.error.code, detail, entry.method));
    } else {
      entry.resolve(message.result);
    }
    return true;
  }

  cancel(id: JsonRpcId, error: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  failAll(error: Error): void {
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}

/** A JSON-RPC `error` object returned by the server for a method we sent. */
export class McpProtocolFailure extends Error {
  readonly code: number;
  readonly method: string;

  constructor(code: number, message: string, method: string) {
    super(message);
    this.name = 'McpProtocolFailure';
    this.code = code;
    this.method = method;
  }
}
