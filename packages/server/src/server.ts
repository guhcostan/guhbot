import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  decodeClientFrame,
  encodeFrame,
  type ClientFrame,
  type RequestFrame,
  type RpcError,
  type ServerFrame,
} from '@guhbot/protocol';
import { Host, HostError, type Session } from '@guhbot/host-core';

/**
 * The host server.
 *
 * One WebSocket endpoint serves every client: the Electron renderer, a phone on
 * the LAN, a browser console, and (in hosted mode) a fleet of tenants behind a
 * gateway. The client does not care which, because the framing is identical.
 *
 * ## Binding and reachability
 *
 * This server binds **loopback and nothing else**, and there is no flag to change
 * that. Reachability from a phone is a separate process's job: `@guhbot/companion`
 * terminates the network and forwards to this one over loopback.
 *
 * The separation is worth the extra moving part. The process that runs commands,
 * holds credentials and reads your files never opens a listening socket that
 * another machine can reach; the network-facing surface is a small proxy with a
 * narrow job. It also means one auditable place decides who may connect, instead
 * of that decision being smeared across the runtime.
 *
 * ## DNS rebinding
 *
 * Binding loopback is not sufficient on its own. A web page can resolve a
 * hostname to 127.0.0.1 and then talk to this server *through the user's
 * browser*, which is a way to reach a local service from a page the user merely
 * visited. The defence is to check the `Host` header: a browser will send the
 * attacker's hostname, and a genuine local client sends `127.0.0.1` or
 * `localhost`. Anything else is refused before it reaches the host.
 *
 * ## Authentication
 *
 * `hello` is sent before anything else, then the client authenticates with a
 * device token. A client that has not authenticated may call exactly one method,
 * `pairing.claim`, and nothing else. The allow-list is enforced here rather than
 * in the dispatcher because it is a property of the unauthenticated transport,
 * not of the method table.
 */

export interface HostServerOptions {
  host: Host;
  port?: number;
  /**
   * Extra hostnames to accept in the `Host` header.
   *
   * Only needed when something legitimate fronts this server and rewrites the
   * header. The default set is loopback names only.
   */
  allowedHosts?: readonly string[];
  /** Absolute path served as a discovery document. */
  hostname?: string;
  /** Called with the pairing URI so a UI can render a QR code. */
  onPairing?: (info: PairingInfo) => void;
}

export interface PairingInfo {
  pairingId: string;
  code: string;
  expiresAt: string;
  /** `guhbot://pair?...` — a phone scans this and knows where to connect. */
  uri: string;
  /** Plain addresses a client can try, for manual entry. */
  addresses: string[];
  port: number;
}

/** Methods a client may call before it has authenticated. */
const UNAUTHENTICATED_METHODS = new Set(['pairing.claim', 'host.status', 'host.describe']);

export class HostServer {
  readonly host: Host;
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Map<WebSocket, Session>();
  private readonly requestedPort: number;
  private readonly allowedHosts: Set<string>;
  private readonly onPairing: ((info: PairingInfo) => void) | undefined;
  private boundPort = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(options: HostServerOptions) {
    this.host = options.host;
    this.requestedPort = options.port ?? 0;
    // Loopback names, plus anything the operator explicitly added. Port is
    // stripped before comparison, because a Host header carries `name:port`.
    this.allowedHosts = new Set([
      '127.0.0.1',
      'localhost',
      '[::1]',
      '::1',
      ...(options.allowedHosts ?? []).map((h) => h.toLowerCase()),
    ]);
    this.onPairing = options.onPairing;

    this.http = createServer((req, res) => this.handleHttp(req, res));

    // Registered BEFORE the WebSocketServer, because upgrade listeners run in
    // registration order and this one has to reject a bad Host before a
    // handshake is completed.
    this.http.on('upgrade', (req, socket) => {
      if (this.isAllowedHost(req)) return;
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });

    this.wss = new WebSocketServer({ server: this.http, path: '/rpc' });
    this.wss.on('connection', (socket, request) => this.handleConnection(socket, request));
  }

  async listen(): Promise<{ port: number; addresses: string[] }> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.requestedPort, '127.0.0.1', () => {
        this.http.off('error', reject);
        resolve();
      });
    });

    const address = this.http.address();
    this.boundPort = typeof address === 'object' && address !== null ? address.port : this.requestedPort;

    // This server is reachable only from this machine, so that is what it
    // reports. A client asking `host.status` for somewhere to connect is told the
    // truth rather than a LAN address this socket does not answer on.
    this.host.setListenInfo(['127.0.0.1'], this.boundPort);

    // Fan out host events to every authenticated client.
    this.unsubscribe = this.subscribeToHostEvents();
    return { port: this.boundPort, addresses: ['127.0.0.1'] };
  }

  private subscribeToHostEvents(): () => void {
    const events = [
      'transcript.appended',
      'transcript.delta',
      'run.updated',
      'approval.requested',
      'approval.resolved',
      'agent.updated',
      'host.shutdown',
    ] as const;
    const disposers = events.map((event) =>
      this.host.on(event, (payload: unknown) => {
        this.broadcast({ t: 'evt', event, payload }, true);
      }),
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  /** Send a frame to every session that has authenticated. */
  broadcast(frame: ServerFrame, authenticatedOnly: boolean): void {
    const encoded = encodeFrame(frame);
    for (const [socket, session] of this.sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      if (session.device !== null) {
        const current = this.host.store.getDevice(session.device.id);
        if (current === null || current.revokedAt !== null) {
          socket.close(1008, 'device revoked');
          continue;
        }
      }
      if (authenticatedOnly && session.device === null && session.channel !== 'local') continue;
      socket.send(encoded);
    }
  }

  /** Mint a pairing code and hand the caller a URI a phone can scan. */
  createPairing(): PairingInfo {
    const { pairingId, code, expiresAt } = this.host.beginPairing();
    const addresses = ['127.0.0.1'];
    const primary = addresses[0] ?? '127.0.0.1';
    const uri = `guhbot://pair?host=${encodeURIComponent(primary)}&port=${this.boundPort}&id=${pairingId}&code=${code}`;
    const info: PairingInfo = { pairingId, code, expiresAt, uri, addresses, port: this.boundPort };
    this.onPairing?.(info);
    return info;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  /**
   * Whether the `Host` header names something we answer for.
   *
   * This is the DNS-rebinding defence, and it is the reason binding loopback is
   * not enough by itself: a page the user merely visited can point a hostname at
   * 127.0.0.1 and reach this server through their own browser. A real local client
   * sends `127.0.0.1` or `localhost`; a rebinding attack sends its own name.
   *
   * A missing Host is refused too. HTTP/1.1 requires it, and a client that omits
   * it is either broken or probing.
   */
  private isAllowedHost(req: IncomingMessage): boolean {
    const raw = req.headers.host;
    if (typeof raw !== 'string' || raw.length === 0) return false;
    // Strip a port, and handle a bracketed IPv6 literal (`[::1]:8787`).
    const host = raw.replace(/^\[([^\]]+)\]/, '$1').replace(/:\d+$/, '').toLowerCase();
    return this.allowedHosts.has(host) || this.allowedHosts.has(`[${host}]`);
  }

  private handleHttp(req: IncomingMessage, res: import('node:http').ServerResponse): void {
    if (!this.isAllowedHost(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden: this host answers only to loopback names\n');
      return;
    }

    // A tiny discovery document, so a client that only knows the host and port
    // can learn whether it is paired and what the host supports.
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      const status = this.host.status();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: 'guhbot-host',
          protocolVersion: PROTOCOL_VERSION,
          hostId: status.hostId,
          version: status.version,
          mode: status.mode,
          inferenceReady: status.inferenceReady,
          rpcPath: '/rpc',
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  }

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    // Anything arriving on a socket is a network client, even on loopback: it
    // did not go through the in-process channel, so it must authenticate.
    const session = this.host.createSession('network');
    this.sockets.set(socket, session);

    socket.send(
      encodeFrame({
        t: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        hostVersion: this.host.version,
        authRequired: true,
      }),
    );

    // If a token arrives on the query string, authenticate immediately so a
    // reconnecting phone does not need an extra round trip.
    const url = new URL(request.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token');
    if (token !== null) {
      const device = this.host.authenticate(token);
      if (device !== null) {
        session.device = device;
        socket.send(encodeFrame({ t: 'ready', deviceId: device.id, deviceClass: device.class }));
      }
    }

    socket.on('message', (data) => {
      void this.handleMessage(socket, session, data.toString());
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
    });
    socket.on('error', () => {
      this.sockets.delete(socket);
    });
  }

  private async handleMessage(socket: WebSocket, session: Session, raw: string): Promise<void> {
    const decoded = decodeClientFrame(raw);
    if (!decoded.ok) {
      this.send(socket, { t: 'res', id: 'unknown', ok: false, error: decoded.error });
      return;
    }
    const frame: ClientFrame = decoded.frame;

    if (frame.t === 'auth') {
      await this.handleAuth(socket, session, frame.token ?? null);
      return;
    }
    await this.handleRequest(socket, session, frame);
  }

  private async handleAuth(socket: WebSocket, session: Session, token: string | null): Promise<void> {
    if (token === null) {
      // An explicit anonymous auth is how a client says "I want to pair".
      this.send(socket, { t: 'ready', deviceId: 'anonymous', deviceClass: 'background' });
      return;
    }
    const device = this.host.authenticate(token);
    if (device === null) {
      this.send(socket, {
        t: 'res',
        id: 'auth',
        ok: false,
        error: { code: 'unauthenticated', message: 'device token is not valid or has been revoked', retryable: false },
      });
      return;
    }
    session.device = device;
    this.send(socket, { t: 'ready', deviceId: device.id, deviceClass: device.class });
  }

  private async handleRequest(socket: WebSocket, session: Session, frame: RequestFrame): Promise<void> {
    const authenticated = session.device !== null;

    if (!authenticated && !UNAUTHENTICATED_METHODS.has(frame.method)) {
      this.send(socket, {
        t: 'res',
        id: frame.id,
        ok: false,
        error: {
          code: 'unauthenticated',
          message: `authenticate before calling ${frame.method}`,
          retryable: false,
        },
      });
      return;
    }

    try {
      const result = await this.host.dispatch(session, frame.method, frame.params ?? {});
      this.send(socket, { t: 'res', id: frame.id, ok: true, result });

      // A successful claim means the client is now paired; confirm it on this
      // socket so it does not have to reconnect to start receiving events.
      if (frame.method === 'pairing.claim') {
        const claimed = result as { device: { id: string; class: 'person' | 'background' }; token: string };
        const device = this.host.authenticate(claimed.token);
        if (device !== null) {
          session.device = device;
          this.send(socket, { t: 'ready', deviceId: device.id, deviceClass: device.class });
        }
      }
    } catch (error) {
      this.send(socket, { t: 'res', id: frame.id, ok: false, error: toRpcError(error) });
    }
  }

  private send(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(encodeFrame(frame));
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    for (const socket of this.sockets.keys()) {
      socket.close(1001, 'host shutting down');
    }
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
    });
  }
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof HostError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'internal', message, retryable: false };
}

/**
 * Non-loopback IPv4 addresses, best-effort.
 *
 * Exported for the companion, which is the process that actually needs to tell a
 * phone where to connect. This server never advertises one, because it does not
 * answer on one.
 */
export function localAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      out.push(entry.address);
    }
  }
  return out.length > 0 ? out : ['127.0.0.1'];
}
