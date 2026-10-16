import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  PROTOCOL_VERSION,
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  type ServerFrame,
} from '@guhbot/protocol';
import { SlidingWindow, type RateLimitOptions } from './limiter.js';
import { scrubServerFrame, type ScrubPolicy } from './scrub.js';
import type { DeviceIdentity, VerifyToken } from './verify.js';

/**
 * The companion: the only guhbot process that binds a network interface.
 *
 * ```
 *   phone --LAN/tailnet--> companion :8787 --loopback--> harness 127.0.0.1:<port>
 *                     ^                                     ^
 *                     | device token, allow list,           | unmodified,
 *                     | rate limit, Host rewrite             | loopback-only
 * ```
 *
 * The split is borrowed from OpenMausBot's `companion/` design, which is worth
 * attributing because their README also records why the obvious alternative is a
 * trap: they had patched a third party's request handler to bind a second socket
 * next to the local one, and it broke the first time upstream hardened its
 * loopback gate. So here the harness keeps its loopback-only bind and its `Host`
 * check, unmodified, and this process sits in front of it. The runtime that runs
 * commands, holds credentials and reads files never opens a listening socket a
 * phone can reach; the network-facing surface is this file, and it decides who
 * may connect.
 *
 * What this process is responsible for, in the order it happens:
 *
 *   1. **Its own `Host` check.** Binding a network interface does not make a
 *      service public property. A DNS-rebinding attack points a hostname the
 *      attacker controls at this address and lets the victim's browser carry the
 *      request in. The browser sends the attacker's name in `Host`; a real phone
 *      sends an IP literal. Names are only accepted when configured.
 *   2. **Authentication.** A device token arrives in the query string or as
 *      `Authorization: Bearer`, and it is verified through the injected
 *      `verifyToken` seam *before* an upstream socket exists. An unknown or
 *      revoked token never reaches the harness, and never spends the harness's
 *      CPU on a scrypt hash.
 *   3. **Rate limiting.** Per device for connections and requests; per source
 *      address for unauthenticated attempts, so a guessing loop is slow. See
 *      `limiter.ts` for why those keys differ.
 *   4. **Forwarding**, with `Host` rewritten to the loopback name the harness
 *      requires, and with the harness's early frames buffered rather than
 *      dropped. Both are load-bearing; see the comments at each site.
 *   5. **Response scrubbing** — see `scrub.ts` for exactly what is removed.
 *
 * TLS is the deployment's job and this package will not grow a certificate
 * loader. The recommended shape is a TLS terminator (Caddy, nginx, tailscale
 * serve) on the same machine, listening on the network and forwarding to this
 * companion bound to `127.0.0.1`. Binding the network directly is supported for
 * a trusted LAN or tailnet, but it takes an explicit acknowledgement, because
 * what it means is that every device token crosses that network in the clear.
 */

const DEFAULT_BIND_HOST = '0.0.0.0';
const DEFAULT_BIND_PORT = 8787;
const DEFAULT_HARNESS_HOST = '127.0.0.1';
const DEFAULT_ATTEMPTS_PER_ADDRESS = 30;
const DEFAULT_CONNECTIONS_PER_DEVICE = 10;
const DEFAULT_REQUESTS_PER_DEVICE = 300;

/**
 * Inbound frame ceiling on the client-facing socket only.
 *
 * This process is the network edge now, so it is the place to bound what an
 * unauthenticated peer can make it buffer. The upstream leg is left at the
 * library default because harness-to-client frames legitimately carry artifacts.
 */
const MAX_INBOUND_FRAME_BYTES = 16 * 1024 * 1024;

/** Remembered request ids per connection. The rate limiter bounds this in practice. */
const MAX_PENDING_REQUESTS = 512;

/** How long `close()` lets WebSocket close frames do their work before destroying sockets. */
const SHUTDOWN_GRACE_MS = 500;

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export interface CompanionOptions {
  /** Where the harness listens. Loopback by design; `host` defaults to `127.0.0.1`. */
  harness: { host?: string; port: number };
  /**
   * Resolve a device token to a device. Required, and required to be honest:
   * see `verify.ts` for why this cannot live inside the companion.
   */
  verifyToken: VerifyToken;
  /** Interface to bind on the network side. Default `0.0.0.0`. */
  host?: string;
  /** Port to bind on the network side. Default `8787`; `0` picks an ephemeral one. */
  port?: number;
  /**
   * Acknowledgement that device tokens will cross the network without TLS.
   * Refused for a non-loopback bind unless this is exactly `true`.
   */
  insecurePlaintext?: boolean;
  /** Extra hostnames this companion answers for, beyond IP literals and localhost. */
  allowedHosts?: readonly string[];
  /**
   * Whether an unauthenticated connection may reach the harness at all.
   *
   * Default true, and the default is a deliberate decision rather than an
   * oversight. Pairing is the one flow that cannot present a token yet: the user
   * reads a code off the host console and types it into the phone, so the phone's
   * first connection has no credential to verify. The compensating controls are
   * that the harness permits an unauthenticated session exactly three methods
   * (`pairing.claim`, `host.status`, `host.describe`), that a wrong code burns one
   * of ten stored attempts, and that this companion charges every anonymous
   * connection to its source address' attempt budget.
   *
   * A deployment that pre-provisions tokens, or that pairs over a cable, should
   * set this to false; then nothing without a verified device token gets through.
   */
  allowPairing?: boolean;
  /** Connection and request budgets. See `limiter.ts`. */
  rateLimit?: RateLimitOptions;
  /** Filesystem prefixes that must never appear in a response. Empty by default. */
  redactPaths?: readonly string[];
  /** Addresses to advertise in `host.status`. Defaults to this machine's own. */
  advertisedAddresses?: readonly string[];
  /** Mixed into the host-id pseudonym, so two deployments do not agree on one. */
  identitySalt?: string;
  /**
   * Test seam: milliseconds to wait between the harness accepting and the client
   * handshake completing.
   *
   * The queue that protects the harness's early frames is the point of the
   * forwarding code, and it is not observable in a regression test by accident.
   * Measured: with the forwarder deliberately attached late, the frame test passes
   * without this delay and fails with it — whether the harness's first frames
   * land in the same TCP read as the upgrade response is a coalescing accident,
   * not a property. Widening the window makes the test prove the queue instead of
   * proving the kernel's timing.
   *
   * A deployment has no reason to set this, and it only ever adds latency.
   */
  handshakeDelayMs?: number;
}

export interface CompanionStats {
  readonly acceptedConnections: number;
  readonly refusedAuth: number;
  readonly refusedRate: number;
  readonly refusedHost: number;
  readonly refusedOther: number;
  readonly upstreamFailures: number;
  readonly rejectedFrames: number;
  readonly activeConnections: number;
}

export interface Companion {
  /** Bound port, or 0 before `listen()`. */
  readonly port: number;
  readonly stats: CompanionStats;
  listen(): Promise<{ port: number; addresses: string[] }>;
  /** Stop accepting, close live upstream sockets, and be idempotent. */
  close(): Promise<void>;
}

/** Thrown for a configuration that must not be started, rather than one that might fail later. */
export class CompanionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanionConfigError';
  }
}

interface ProxyConnection {
  readonly address: string;
  readonly upstream: WebSocket;
  readonly queued: Array<[RawData, boolean]>;
  readonly pendingMethods: Map<string, string>;
  client: WebSocket | null;
  deviceId: string | null;
  ended: boolean;
  /** Serializes client frames, because verifying an `auth` frame is asynchronous. */
  inbound: Promise<void>;
}

export function createCompanion(options: CompanionOptions): Companion {
  const bindHost = options.host ?? DEFAULT_BIND_HOST;
  const bindPort = options.port ?? DEFAULT_BIND_PORT;

  if (!isLoopbackAddress(bindHost) && options.insecurePlaintext !== true) {
    throw new CompanionConfigError(
      `refusing to bind ${bindHost}:${String(bindPort)}: this is not a loopback address, device tokens would ` +
        'cross that network in the clear, and TLS is the deployment\'s job.\n' +
        '  Three ways forward:\n' +
        '    * acknowledge it: --insecure-plaintext  (device tokens cross the network unencrypted; ' +
        'anyone who can read the link can act as a paired device)\n' +
        '    * stay loopback: --host 127.0.0.1 and put a TLS terminator in front of this port\n' +
        '    * bind a private interface you trust (a tailnet address) with --insecure-plaintext',
    );
  }

  return new CompanionServer(options, bindHost, bindPort);
}

class CompanionServer implements Companion {
  private readonly options: CompanionOptions;
  private readonly bindHost: string;
  private readonly bindPort: number;
  private readonly harnessHost: string;
  private readonly harnessPort: number;
  private readonly harnessHostHeader: string;
  private readonly verifyToken: VerifyToken;
  private readonly allowPairing: boolean;
  private readonly allowedHosts: Set<string>;
  private readonly limiter: SlidingWindow;
  private readonly limits: {
    connectionsPerDevice: number;
    requestsPerDevice: number;
    attemptsPerAddress: number;
  };
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly connections = new Set<ProxyConnection>();
  /** Every open socket leg, on either side, so shutdown can wait for them. */
  private readonly legs = new Set<WebSocket>();
  private boundPort = 0;
  private policy: ScrubPolicy | null = null;
  private shutdown: Promise<void> | null = null;
  private readonly counters = {
    acceptedConnections: 0,
    refusedAuth: 0,
    refusedRate: 0,
    refusedHost: 0,
    refusedOther: 0,
    upstreamFailures: 0,
    rejectedFrames: 0,
  };

  constructor(options: CompanionOptions, bindHost: string, bindPort: number) {
    this.options = options;
    this.bindHost = bindHost;
    this.bindPort = bindPort;
    this.harnessHost = options.harness.host ?? DEFAULT_HARNESS_HOST;
    this.harnessPort = options.harness.port;
    // The harness refuses any `Host` that is not a loopback name, so the header
    // this process sends upstream has to name the harness the way it recognises
    // itself, not the way the phone addressed us.
    this.harnessHostHeader = `${this.harnessHost}:${String(this.harnessPort)}`;
    this.verifyToken = options.verifyToken;
    this.allowPairing = options.allowPairing ?? true;
    this.allowedHosts = new Set((options.allowedHosts ?? []).map((name) => name.toLowerCase()));
    this.limits = {
      connectionsPerDevice: options.rateLimit?.maxConnectionsPerDevice ?? DEFAULT_CONNECTIONS_PER_DEVICE,
      requestsPerDevice: options.rateLimit?.maxRequestsPerDevice ?? DEFAULT_REQUESTS_PER_DEVICE,
      attemptsPerAddress: options.rateLimit?.maxAttemptsPerAddress ?? DEFAULT_ATTEMPTS_PER_ADDRESS,
    };
    this.limiter = new SlidingWindow({
      windowMs: options.rateLimit?.windowMs ?? 60_000,
      now: options.rateLimit?.now ?? Date.now,
    });

    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.http.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });

    // `noServer`, because the upgrade is only completed once the harness has
    // accepted the connection; until then there is no client to speak to.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_FRAME_BYTES });
  }

  get port(): number {
    return this.boundPort;
  }

  get stats(): CompanionStats {
    return { ...this.counters, activeConnections: this.connections.size };
  }

  async listen(): Promise<{ port: number; addresses: string[] }> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.bindPort, this.bindHost, () => {
        this.http.off('error', reject);
        resolve();
      });
    });

    const address = this.http.address();
    this.boundPort = typeof address === 'object' && address !== null ? address.port : this.bindPort;
    const addresses = this.advertisedAddresses();
    this.policy = {
      addresses,
      port: this.boundPort,
      redactPaths: this.options.redactPaths ?? [],
      identitySalt: this.options.identitySalt ?? '',
    };
    return { port: this.boundPort, addresses };
  }

  /**
   * Stop accepting, then close both legs of every live connection.
   *
   * Idempotent: the first call does the work and every later call awaits the same
   * promise, so a signal handler and a `finally` block can both call it.
   */
  close(): Promise<void> {
    this.shutdown ??= this.runShutdown();
    return this.shutdown;
  }

  private async runShutdown(): Promise<void> {
    const httpClosed = new Promise<void>((resolve) => {
      // Stops the listener immediately; the callback waits for live sockets.
      this.http.close(() => resolve());
    });
    // No new upgrades, and no new frames on existing ones.
    this.wss.close();

    // Ask every live connection, on both legs, to close.
    for (const connection of [...this.connections]) this.endConnection(connection);

    // Then wait for the legs to actually finish, so a caller that awaited
    // `close()` knows the upstream sockets are gone. Bounded, because a peer that
    // never answers a close frame must not be able to stall a shutdown.
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (this.legs.size > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    for (const leg of this.legs) leg.terminate();
    this.legs.clear();
    this.connections.clear();

    await httpClosed;
  }

  // -------------------------------------------------------------------------
  // HTTP surface
  // -------------------------------------------------------------------------

  private isAllowedHost(header: string | undefined): boolean {
    const name = hostName(header);
    if (name === null) return false;
    if (this.allowedHosts.has(name) || this.allowedHosts.has(`[${name}]`)) return true;
    if (name === 'localhost') return true;
    // An address literal is the normal way a phone reaches this companion, and
    // an attacker's page cannot make a browser send one it does not resolve to.
    // A *name* is different: that is what a DNS-rebinding attack carries, so
    // names have to be configured.
    return isIP(name) !== 0;
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (!this.isAllowedHost(req.headers.host)) {
      this.counters.refusedHost += 1;
      send(res, 403, 'forbidden: this companion answers only for the hosts it was configured for\n');
      return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      // Deliberately small: a health check tells a load balancer that this
      // process is up, and tells a prober nothing about the harness behind it.
      sendJson(res, 200, {
        name: 'guhbot-companion',
        version: '0.1.0',
        protocolVersion: PROTOCOL_VERSION,
        rpcPath: '/rpc',
      });
      return;
    }
    if (req.url === '/rpc' || req.url?.startsWith('/rpc?')) {
      send(res, 426, 'upgrade required: /rpc speaks the guhbot protocol over a WebSocket\n');
      return;
    }
    send(res, 404, 'not found\n');
  }

  // -------------------------------------------------------------------------
  // Upgrade path
  // -------------------------------------------------------------------------

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.shutdown !== null) {
      this.refuse(socket, 503, 'this companion is shutting down');
      return;
    }
    if (!this.isAllowedHost(req.headers.host)) {
      this.counters.refusedHost += 1;
      this.refuse(socket, 403, 'forbidden: this companion answers only for the hosts it was configured for');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://companion.invalid');
    if (url.pathname !== '/rpc') {
      this.counters.refusedOther += 1;
      this.refuse(socket, 404, 'not found');
      return;
    }

    // Query string wins over the header, and whichever one is verified is the
    // only one forwarded, so the harness can never be shown a different token
    // from the one this process checked.
    const token = url.searchParams.get('token') ?? bearerToken(req);
    const address = req.socket.remoteAddress ?? 'unknown';

    // The address budget is charged before verification on purpose: verifying a
    // token is a deliberate scrypt hash, so this is the check that bounds how
    // much CPU one peer can spend.
    //
    // Budgets are keyed by purpose as well as by subject. Sharing one key between
    // "connections" and "requests" would make a single connection spend two
    // entries of one window and refuse a legitimate second request.
    const attempt = this.limiter.take(`attempts:addr:${address}`, this.limits.attemptsPerAddress);
    if (!attempt.allowed) {
      this.counters.refusedRate += 1;
      this.refuse(socket, 429, 'too many connection attempts from this address', attempt.retryAfterMs);
      return;
    }

    let identity: DeviceIdentity | null = null;
    if (token !== null) {
      identity = await this.verify(token);
      if (identity === null) {
        this.counters.refusedAuth += 1;
        this.refuse(socket, 401, 'unknown or revoked device token');
        return;
      }
    } else if (!this.allowPairing) {
      this.counters.refusedAuth += 1;
      this.refuse(socket, 401, 'a device token is required');
      return;
    }

    if (identity !== null) {
      const device = this.limiter.take(`connections:device:${identity.id}`, this.limits.connectionsPerDevice);
      if (!device.allowed) {
        this.counters.refusedRate += 1;
        this.refuse(socket, 429, 'too many connections for this device', device.retryAfterMs);
        return;
      }
    }

    // Verification is asynchronous, so the peer may already be gone. Opening an
    // upstream socket for a client that has left spends the harness's connection
    // budget for nobody.
    if (socket.destroyed) return;

    const upstream = new WebSocket(this.upstreamUrl(token), {
      headers: { Host: this.harnessHostHeader },
    });
    this.trackLeg(upstream);
    const connection: ProxyConnection = {
      address,
      upstream,
      queued: [],
      pendingMethods: new Map(),
      client: null,
      deviceId: identity?.id ?? null,
      ended: false,
      inbound: Promise.resolve(),
    };
    this.connections.add(connection);

    /**
     * The harness sends `hello` and `ready` the instant the connection opens,
     * which is before the client-side handshake below has completed. Attaching
     * the forwarder only after `handleUpgrade` returns would silently drop those
     * frames — the client then waits forever for a `ready` that was already sent.
     * So the listener goes on up front and anything that arrives early is queued.
     * (`apps/cloud/src/gateway.ts` documents the same trap; it is a property of
     * fronting this harness, not of either proxy.)
     */
    upstream.on('message', (data, isBinary) => {
      const frame = this.scrubOutgoing(connection, data, isBinary);
      const client = connection.client;
      if (client !== null && client.readyState === WebSocket.OPEN) {
        client.send(frame.data, { binary: frame.binary });
      } else {
        connection.queued.push([frame.data, frame.binary]);
      }
    });

    upstream.on('open', () => {
      void this.completeClientHandshake(req, socket, head, connection);
    });

    upstream.on('error', () => {
      this.counters.upstreamFailures += 1;
      connection.queued.length = 0;
      if (!connection.ended) this.refuse(socket, 502, 'the harness is not reachable');
      this.endConnection(connection);
    });
    upstream.on('close', () => this.endConnection(connection));
    socket.on('close', () => this.endConnection(connection));
  }

  /**
   * Finish the client side of the proxy, once the harness has accepted.
   *
   * Completing only after the harness accepted means a dead harness surfaces as a
   * failed upgrade rather than a half-open pipe.
   */
  private async completeClientHandshake(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    connection: ProxyConnection,
  ): Promise<void> {
    const delay = this.options.handshakeDelayMs ?? 0;
    if (delay > 0) {
      // Test seam. See `handshakeDelayMs`: it exists so the window the queue
      // above protects can be observed deliberately instead of by luck.
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    if (connection.ended || socket.destroyed) return;

    this.wss.handleUpgrade(req, socket, head, (client) => {
      connection.client = client;
      this.trackLeg(client);
      for (const [data, binary] of connection.queued) client.send(data, { binary });
      connection.queued.length = 0;

      client.on('message', (data, isBinary) => {
        connection.inbound = connection.inbound
          .then(() => this.handleClientFrame(connection, data, isBinary))
          .catch(() => undefined);
      });
      client.on('close', () => this.endConnection(connection));
      client.on('error', () => this.endConnection(connection));
      this.counters.acceptedConnections += 1;
    });
  }

  private upstreamUrl(token: string | null): string {
    const base = `ws://${this.harnessHost}:${String(this.harnessPort)}/rpc`;
    return token === null ? base : `${base}?token=${encodeURIComponent(token)}`;
  }

  /**
   * Verify a presented token, failing closed.
   *
   * A verifier that throws is treated as "not valid": an unavailable check must
   * never read as a pass, or the companion becomes the open relay it exists to
   * prevent.
   */
  private async verify(token: string): Promise<DeviceIdentity | null> {
    try {
      return await this.verifyToken(token);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Client -> harness
  // -------------------------------------------------------------------------

  private async handleClientFrame(connection: ProxyConnection, data: RawData, isBinary: boolean): Promise<void> {
    if (connection.ended) return;
    const upstream = connection.upstream;
    if (upstream.readyState !== WebSocket.OPEN) return;

    if (isBinary) {
      upstream.send(data, { binary: true });
      return;
    }

    const raw = data.toString();
    const decoded = decodeClientFrame(raw);
    if (!decoded.ok) {
      // A malformed frame is the harness's to answer; forwarding it keeps this
      // proxy from inventing protocol errors of its own.
      upstream.send(raw);
      return;
    }
    const frame = decoded.frame;

    if (frame.t === 'auth') {
      const token = frame.token ?? null;
      if (token === null) {
        if (!this.allowPairing) {
          this.counters.refusedAuth += 1;
          this.sendToClient(connection, {
            t: 'res',
            id: 'auth',
            ok: false,
            error: { code: 'unauthenticated', message: 'this companion requires a device token', retryable: false },
          });
          return;
        }
      } else {
        const identity = await this.verify(token);
        if (identity === null) {
          this.counters.refusedAuth += 1;
          this.sendToClient(connection, {
            t: 'res',
            id: 'auth',
            ok: false,
            error: {
              code: 'unauthenticated',
              message: 'device token is not valid or has been revoked',
              retryable: false,
            },
          });
          return;
        }
        connection.deviceId = identity.id;
      }
      upstream.send(raw);
      return;
    }

    const decision = this.limiter.take(this.rateLimitKey(connection), this.limits.requestsPerDevice);
    if (!decision.allowed) {
      this.counters.refusedRate += 1;
      this.sendToClient(connection, {
        t: 'res',
        id: frame.id,
        ok: false,
        error: { code: 'rate-limited', message: 'too many requests; retry shortly', retryable: true },
      });
      return;
    }

    connection.pendingMethods.set(frame.id, frame.method);
    if (connection.pendingMethods.size > MAX_PENDING_REQUESTS) {
      const oldest = connection.pendingMethods.keys().next();
      if (!oldest.done) connection.pendingMethods.delete(oldest.value);
    }
    upstream.send(raw);
  }

  /**
   * What this connection's request budget is charged to.
   *
   * A verified device gets its own budget, so one hostile phone cannot spend
   * another's. Before a device is known — an unknown token is already refused by
   * then, so this is the pairing path — the source address carries it.
   */
  private rateLimitKey(connection: ProxyConnection): string {
    return connection.deviceId === null
      ? `requests:addr:${connection.address}`
      : `requests:device:${connection.deviceId}`;
  }

  // -------------------------------------------------------------------------
  // Harness -> client
  // -------------------------------------------------------------------------

  private scrubOutgoing(connection: ProxyConnection, data: RawData, isBinary: boolean): { data: RawData; binary: boolean } {
    if (isBinary) return { data, binary: true };

    const raw = data.toString();
    const decoded = decodeServerFrame(raw);
    // A frame this build cannot parse is forwarded untouched: the client and the
    // harness are the authorities on their own protocol version, not this proxy.
    if (!decoded.ok) return { data, binary: false };
    const frame = decoded.frame;

    if (frame.t === 'ready') {
      // A device that paired over this connection gets its own budget from the
      // first frame that names it.
      if (frame.deviceId !== 'anonymous') connection.deviceId = frame.deviceId;
      return { data, binary: false };
    }

    let method: string | null = null;
    if (frame.t === 'res') {
      method = connection.pendingMethods.get(frame.id) ?? null;
      connection.pendingMethods.delete(frame.id);
    }

    const scrubbed = scrubServerFrame(frame, method, this.scrubPolicy());
    if (!scrubbed.changed) return { data, binary: false };
    // Re-encoded only when something was actually removed, so an ordinary frame
    // travels exactly as the harness wrote it.
    return { data: Buffer.from(encodeFrame(scrubbed.frame), 'utf8'), binary: false };
  }

  private scrubPolicy(): ScrubPolicy {
    this.policy ??= {
      addresses: this.advertisedAddresses(),
      port: this.boundPort,
      redactPaths: this.options.redactPaths ?? [],
      identitySalt: this.options.identitySalt ?? '',
    };
    return this.policy;
  }

  private advertisedAddresses(): string[] {
    const configured = this.options.advertisedAddresses;
    if (configured !== undefined) return [...configured];
    if (isLoopbackAddress(this.bindHost)) return ['127.0.0.1'];
    if (this.bindHost !== '0.0.0.0' && this.bindHost !== '::' && isIP(this.bindHost) !== 0) return [this.bindHost];
    return localAddresses();
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  private trackLeg(leg: WebSocket): void {
    this.legs.add(leg);
    leg.on('close', () => {
      this.legs.delete(leg);
    });
  }

  private endConnection(connection: ProxyConnection): void {
    if (connection.ended) return;
    connection.ended = true;
    this.connections.delete(connection);
    connection.pendingMethods.clear();
    connection.queued.length = 0;

    const upstream = connection.upstream;
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close(1001, 'companion closed the upstream leg');
    }
    const client = connection.client;
    if (client !== null && client.readyState !== WebSocket.CLOSED) {
      client.close(1001, 'companion closed the client leg');
    }
  }

  private sendToClient(connection: ProxyConnection, frame: ServerFrame): void {
    const client = connection.client;
    if (client === null || client.readyState !== WebSocket.OPEN) {
      this.counters.rejectedFrames += 1;
      return;
    }
    client.send(encodeFrame(frame));
  }

  private refuse(socket: Duplex, status: number, body: string, retryAfterMs?: number): void {
    if (socket.destroyed || socket.writableEnded) return;
    const payload = `${body}\n`;
    const lines = [
      `HTTP/1.1 ${String(status)} ${STATUS_TEXT[status] ?? 'Error'}`,
      'content-type: text/plain; charset=utf-8',
      `content-length: ${String(Buffer.byteLength(payload))}`,
      'connection: close',
      ...(retryAfterMs !== undefined ? [`retry-after: ${String(Math.max(1, Math.ceil(retryAfterMs / 1000)))}`] : []),
      '',
      payload,
    ];
    // Destroy once the refusal is flushed: a peer that will not read must not be
    // able to hold a slot open.
    socket.write(lines.join('\r\n'), () => socket.destroy());
    socket.end();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The bare name in a `Host` header, with any port and IPv6 brackets removed. */
function hostName(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const value = header.trim();
  if (value.length === 0) return null;

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) {
    const inner = bracketed[1];
    return inner === undefined || inner.length === 0 ? null : inner.toLowerCase();
  }
  // A bare IPv6 literal has colons that are not a port separator.
  if (isIP(value) !== 0) return value.toLowerCase();

  const withoutPort = /^(.*):\d+$/.exec(value);
  const name = (withoutPort ? (withoutPort[1] ?? '') : value).toLowerCase();
  return name.length === 0 ? null : name;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length === 0 ? null : token;
}

export function isLoopbackAddress(value: string): boolean {
  const name = value.toLowerCase();
  if (name === 'localhost' || name === '::1' || name === '[::1]') return true;
  // 127.0.0.0/8, in the one form that matters here.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/**
 * Non-loopback IPv4 addresses, best-effort.
 *
 * `@guhbot/server` exports an identical helper "for the companion", but this
 * process deliberately does not depend on that package: it would link the whole
 * runtime — model providers, the SQLite store, every capability — into the one
 * process an attacker can reach. Ten lines here are a better trade, and they keep
 * this package's runtime dependencies at `ws` and the protocol schema.
 */
function localAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      out.push(entry.address);
    }
  }
  return out.length > 0 ? out : ['127.0.0.1'];
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}
