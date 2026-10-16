import {
  PROTOCOL_VERSION,
  decodeServerFrame,
  encodeFrame,
  type EventName,
  type MethodInput,
  type MethodName,
  type MethodOutput,
  type RpcError,
} from '@guhbot/protocol';

/**
 * The client SDK.
 *
 * Shared verbatim by the desktop renderer, the mobile app, the CLI and the
 * cloud console. It is written against the standard `WebSocket` global so the
 * same file runs in Node, in a browser and in React Native, and it holds no
 * host-specific state: everything it displays comes from the event stream plus
 * explicit queries.
 *
 * ## Reconnection
 *
 * A phone will lose its connection constantly — backgrounded, tunnel, wrong
 * network. The client therefore reconnects with backoff and re-authenticates,
 * and emits `reconnected` so the UI can re-read what it missed. It does not try
 * to replay missed deltas; `transcript.delta` is explicitly lossy and the
 * durable entries are re-read from the host.
 */

export interface GuhbotClientOptions {
  url: string;
  token?: string | undefined;
  /** WebSocket implementation. Defaults to the global. */
  webSocketImpl?: typeof WebSocket | undefined;
  /** Reconnect automatically after an unexpected close. Default true. */
  autoReconnect?: boolean;
  maxBackoffMs?: number;
  onError?: (error: RpcError | Error) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: RpcError) => void;
  timer: NodeJS.Timeout;
}

export type ClientState = 'idle' | 'connecting' | 'authenticating' | 'ready' | 'closed';

type EventListener = (payload: unknown) => void;

export class GuhbotClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly options: GuhbotClientOptions;
  private seq = 0;
  private backoffMs = 250;
  private closedByCaller = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  state: ClientState = 'idle';
  deviceId: string | null = null;
  deviceClass: 'person' | 'background' | null = null;

  constructor(options: GuhbotClientOptions) {
    this.options = options;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    this.closedByCaller = false;
    await this.open();
  }

  private async open(): Promise<void> {
    const WebSocketImpl = this.options.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WebSocketImpl) {
      throw new Error('no WebSocket implementation available; pass webSocketImpl in the options');
    }

    this.state = 'connecting';
    const url = this.options.token ? `${this.options.url}?token=${encodeURIComponent(this.options.token)}` : this.options.url;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocketImpl(url);
      this.socket = socket;

      const onOpenError = (error: unknown): void => {
        this.state = 'closed';
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      socket.addEventListener('error', onOpenError, { once: true });
      socket.addEventListener('open', () => {
        socket.removeEventListener('error', onOpenError);
        this.state = 'authenticating';
        // With a token in the query string the server authenticates on upgrade;
        // an explicit auth frame covers the anonymous/pairing path.
        socket.send(encodeFrame({ t: 'auth', ...(this.options.token ? { token: this.options.token } : {}) }));
        resolve();
      });

      socket.addEventListener('message', (event: MessageEvent) => {
        this.handleFrame(typeof event.data === 'string' ? event.data : String(event.data));
      });

      socket.addEventListener('close', () => {
        this.failAllPending({ code: 'cancelled', message: 'connection closed', retryable: true });
        if (this.closedByCaller || this.options.autoReconnect === false) {
          this.state = 'closed';
          return;
        }
        this.scheduleReconnect();
      });

      socket.addEventListener('error', (event: Event) => {
        this.options.onError?.(new Error(`websocket error: ${String((event as unknown as { message?: string }).message ?? 'unknown')}`));
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.state = 'connecting';
    const delay = this.backoffMs;
    // Exponential backoff with a ceiling, so a host that is switched off does
    // not get hammered by a phone in a pocket.
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open()
        .then(() => {
          this.backoffMs = 250;
          this.emit('reconnected', { deviceId: this.deviceId });
        })
        .catch(() => {
          this.scheduleReconnect();
        });
    }, delay);
  }

  async close(): Promise<void> {
    this.closedByCaller = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failAllPending({ code: 'cancelled', message: 'client closed', retryable: false });
    const socket = this.socket;
    this.socket = null;
    this.state = 'closed';
    if (socket) {
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        socket.addEventListener('close', done, { once: true });
        socket.close(1000, 'client closing');
        // Do not hang forever on a socket that never acknowledges the close.
        setTimeout(done, 1000);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Framing
  // -------------------------------------------------------------------------

  private handleFrame(raw: string): void {
    const decoded = decodeServerFrame(raw);
    if (!decoded.ok) {
      this.options.onError?.(decoded.error);
      return;
    }
    const frame = decoded.frame;

    if (frame.t === 'hello') {
      if (frame.protocolVersion !== PROTOCOL_VERSION) {
        this.options.onError?.(
          new Error(
            `host speaks protocol ${frame.protocolVersion} but this client speaks ${PROTOCOL_VERSION}; ` +
              'update whichever is older',
          ),
        );
        void this.close();
      }
      return;
    }

    if (frame.t === 'ready') {
      this.state = 'ready';
      this.deviceId = frame.deviceId;
      this.deviceClass = frame.deviceClass;
      this.emit('ready', { deviceId: frame.deviceId, deviceClass: frame.deviceClass });
      return;
    }

    if (frame.t === 'res') {
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.ok) {
        waiter.resolve(frame.result);
      } else {
        const error = frame.error ?? { code: 'internal', message: 'host returned an error with no detail', retryable: false };
        waiter.reject(error);
        this.options.onError?.(error);
      }
      return;
    }

    this.emit(frame.event, frame.payload);
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /**
   * Call a host method.
   *
   * Two overloads, deliberately. The first is typed end to end from the core
   * registry, so a client cannot call a core method that does not exist or pass
   * the wrong shape without a compile error. The second accepts any string, so
   * a capability can contribute methods without the protocol package having to
   * know about every capability — the alternative would be a registry that grows
   * a dependency on each one.
   *
   * A capability method is validated on the host against the schemas it declared
   * when it was contributed, so the looser client signature costs nothing at the
   * boundary that matters.
   */
  request<M extends MethodName>(method: M, params: MethodInput<M>, timeoutMs?: number): Promise<MethodOutput<M>>;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  request(method: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    const socket = this.socket;
    if (!socket || this.state !== 'ready') {
      return Promise.reject({ code: 'cancelled', message: 'client is not connected', retryable: true } satisfies RpcError);
    }
    this.seq += 1;
    const id = `r${this.seq}`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ code: 'internal', message: `${method} timed out after ${timeoutMs}ms`, retryable: true } satisfies RpcError);
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      socket.send(encodeFrame({ t: 'req', id, method, params }));
    });
  }

  /** Fire a request without caring about the result. */
  notify<M extends MethodName>(method: M, params: MethodInput<M>): void;
  notify(method: string, params?: unknown): void;
  notify(method: string, params?: unknown): void {
    const socket = this.socket;
    if (!socket || this.state !== 'ready') return;
    this.seq += 1;
    socket.send(encodeFrame({ t: 'req', id: `n${this.seq}`, method, params }));
  }

  private failAllPending(error: RpcError): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on(event: EventName | 'ready' | 'reconnected', listener: EventListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  private emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        // A broken listener must not take down the socket loop.
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
