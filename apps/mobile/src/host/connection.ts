/**
 * The one place in the app that owns a socket.
 *
 * `GuhbotClient` (from `@guhbot/server`) already speaks the protocol, retries
 * with backoff and re-authenticates. This wrapper adds what a screen needs on
 * top of it: a snapshot of the link, a bounded wait for the host's `ready`
 * frame, and an event fan-in. It holds no UI state.
 */
import {
  EVENT_NAMES,
  type DeviceClass,
  type EventName,
  type MethodInput,
  type MethodName,
  type MethodOutput,
  type RpcError,
} from '@guhbot/protocol';
import { GuhbotClient, type ClientState } from '@guhbot/server';

import { asDeviceClass } from '../core/capabilities';
import { describeEndpoint, rpcUrl, type HostEndpoint } from '../core/endpoint';
import { isRpcError } from '../core/errors';

export interface ConnectionSnapshot {
  readonly clientState: ClientState;
  /** True once the host has accepted this device at least once on this link. */
  readonly hasBeenReady: boolean;
  readonly deviceId: string | null;
  readonly deviceClass: DeviceClass | null;
  /** Last transport failure, formatted for display. */
  readonly detail: string | null;
}

export interface ConnectionHandlers {
  readonly onEvent: (event: EventName, payload: unknown) => void;
  readonly onChange: (snapshot: ConnectionSnapshot) => void;
  /** Fired after an unexpected drop was recovered; the UI must re-query. */
  readonly onReconnected: () => void;
  readonly onError?: (error: RpcError | Error) => void;
}

export interface HostConnectionOptions extends ConnectionHandlers {
  readonly endpoint: HostEndpoint;
  /** Absent while pairing: the host accepts an anonymous session for that only. */
  readonly token: string | null;
  readonly maxBackoffMs?: number;
  readonly readyTimeoutMs?: number;
}

export interface Connection {
  readonly snapshot: ConnectionSnapshot;
  start(): Promise<void>;
  stop(): Promise<void>;
  request<M extends MethodName>(method: M, params: MethodInput<M>): Promise<MethodOutput<M>>;
}

/** GuhbotClient mutates `state` internally and does not emit on every change. */
const SAMPLE_INTERVAL_MS = 700;
const DEFAULT_READY_TIMEOUT_MS = 6_000;

function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: () => string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message())), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        // Preserve `RpcError` (a plain object) as-is: the caller's schema check
        // (`isRpcError`) reads the shape, and re-wrapping would lose the code.
        reject(error instanceof Error || isRpcError(error) ? error : new Error(String(error)));
      },
    );
  });
}

export class HostConnection implements Connection {
  private readonly client: GuhbotClient;
  private readonly handlers: ConnectionHandlers;
  private readonly endpoint: HostEndpoint;
  private readonly readyTimeoutMs: number;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private hasBeenReady = false;
  private detail: string | null = null;
  private lastEmitted: ConnectionSnapshot;

  constructor(options: HostConnectionOptions) {
    this.handlers = options;
    this.endpoint = options.endpoint;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.client = new GuhbotClient({
      url: rpcUrl(options.endpoint),
      ...(options.token === null ? {} : { token: options.token }),
      ...(options.maxBackoffMs === undefined ? {} : { maxBackoffMs: options.maxBackoffMs }),
      autoReconnect: true,
      onError: (error) => {
        // `RpcError` is a plain `{ code, message }` object from the wire, not an
        // `Error`, so the message has to be read off the union rather than assumed.
        this.detail = error.message;
        this.handlers.onError?.(error);
        this.emitIfChanged();
      },
    });

    this.client.on('ready', () => {
      this.hasBeenReady = true;
      this.detail = null;
      this.emitIfChanged();
    });
    this.client.on('reconnected', () => {
      this.detail = null;
      this.emitIfChanged();
      this.handlers.onReconnected();
    });
    for (const name of EVENT_NAMES) {
      this.client.on(name, (payload) => this.handlers.onEvent(name, payload));
    }

    this.lastEmitted = this.snapshot;
  }

  get snapshot(): ConnectionSnapshot {
    return {
      clientState: this.client.state,
      hasBeenReady: this.hasBeenReady,
      deviceId: this.client.deviceId,
      deviceClass: asDeviceClass(this.client.deviceClass),
      detail: this.detail,
    };
  }

  /**
   * Resolves once the host has accepted this device. Rejects when the host is
   * not answering or has refused the token, and leaves the client's own retry
   * loop running so a host that comes back is picked up.
   */
  async start(): Promise<void> {
    this.emitIfChanged();
    try {
      await withTimeout(this.client.connect(), this.readyTimeoutMs, () => this.stallMessage());
      await withTimeout(this.once('ready'), this.readyTimeoutMs, () => this.stallMessage());
    } finally {
      this.startSampling();
      this.emitIfChanged();
    }
  }

  async stop(): Promise<void> {
    if (this.sampleTimer !== null) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    await this.client.close();
    this.emitIfChanged();
  }

  request<M extends MethodName>(method: M, params: MethodInput<M>): Promise<MethodOutput<M>> {
    return this.client.request(method, params);
  }

  private stallMessage(): string {
    // A revoked token leaves the socket open and the client stuck in
    // `authenticating`, which is not the same story as an unreachable host.
    return this.client.state === 'authenticating'
      ? 'The host did not accept this device token. It may have been revoked there; pair again.'
      : `No answer from ${describeEndpoint(this.endpoint)}.`;
  }

  private once(event: 'ready'): Promise<void> {
    if (this.client.state === 'ready') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const off = this.client.on(event, () => {
        off();
        resolve();
      });
    });
  }

  private startSampling(): void {
    if (this.sampleTimer !== null) return;
    this.sampleTimer = setInterval(() => this.emitIfChanged(), SAMPLE_INTERVAL_MS);
  }

  private emitIfChanged(): void {
    const next = this.snapshot;
    const previous = this.lastEmitted;
    if (
      next.clientState === previous.clientState &&
      next.hasBeenReady === previous.hasBeenReady &&
      next.deviceId === previous.deviceId &&
      next.deviceClass === previous.deviceClass &&
      next.detail === previous.detail
    ) {
      return;
    }
    this.lastEmitted = next;
    this.handlers.onChange(next);
  }
}
