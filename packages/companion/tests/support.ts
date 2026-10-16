import { createServer, type Server as HttpServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * Test support: a fake harness and raw-socket helpers.
 *
 * The fake harness matters more than it looks. "The harness never saw this
 * connection" is a security property, and the only honest way to assert it is to
 * count how many connections actually reached something that behaves like a
 * harness. A spy on the verifier proves the companion was consulted; a connection
 * count proves the harness was not.
 */

export interface FakeHarness {
  readonly port: number;
  /** Upgrades that actually reached this server. */
  readonly upgrades: number;
  /** `Host` headers seen, in order, so a rewrite can be asserted literally. */
  readonly hosts: readonly string[];
  /** Raw frames received from the companion. */
  readonly frames: readonly string[];
  /** Client sockets it currently holds open. */
  readonly openSockets: number;
  close(): Promise<void>;
}

/** A minimal harness: accepts an upgrade, counts it, optionally answers requests. */
export async function startFakeHarness(options: { answer?: boolean; greet?: boolean } = {}): Promise<FakeHarness> {
  const answer = options.answer ?? false;
  const greet = options.greet ?? false;
  const http: HttpServer = createServer();
  let upgrades = 0;
  let openSockets = 0;
  const hosts: string[] = [];
  const frames: string[] = [];

  // Registered before the WebSocketServer attaches its own upgrade listener, so
  // every upgrade is counted even when the handshake is later completed by it.
  http.on('upgrade', (req) => {
    upgrades += 1;
    hosts.push(req.headers.host ?? '');
  });

  const wss = new WebSocketServer({ server: http, path: '/rpc' });
  wss.on('connection', (socket: WebSocket) => {
    openSockets += 1;
    socket.on('close', () => {
      openSockets -= 1;
    });
    if (greet) {
      // The harness's real behaviour: speak before the peer says anything.
      socket.send(JSON.stringify({ t: 'hello', protocolVersion: 1, hostVersion: 'fake', authRequired: true }));
      socket.send(JSON.stringify({ t: 'ready', deviceId: 'dv_fake', deviceClass: 'background' }));
    }
    socket.on('message', (data) => {
      const raw = data.toString();
      frames.push(raw);
      if (!answer) return;
      const parsed = safeParse(raw);
      if (parsed === null || parsed['t'] !== 'req') return;
      socket.send(JSON.stringify({ t: 'res', id: parsed['id'], ok: true, result: { echoed: parsed['method'] } }));
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    get upgrades() {
      return upgrades;
    },
    hosts,
    frames,
    get openSockets() {
      return openSockets;
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

export interface RawResponse {
  readonly status: number;
  readonly head: string;
}

/**
 * A WebSocket upgrade over a raw socket.
 *
 * `Host` is a forbidden header in the fetch spec and `ws` will happily set it, but
 * a raw handshake is the only way to send a header the client library would
 * otherwise normalise, and it also reads the refusal status directly.
 */
export async function rawUpgrade(
  port: number,
  options: { host: string; token?: string; path?: string },
): Promise<RawResponse> {
  const path = options.path ?? '/rpc';
  const query = options.token !== undefined ? `?token=${encodeURIComponent(options.token)}` : '';
  const head =
    `GET ${path}${query} HTTP/1.1\r\n` +
    `Host: ${options.host}\r\n` +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    'Sec-WebSocket-Version: 13\r\n\r\n';
  return sendRaw(port, head);
}

export async function rawHttpGet(port: number, host: string, path = '/health'): Promise<RawResponse> {
  return sendRaw(port, `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
}

function sendRaw(port: number, request: string): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve) => {
    const socket: Socket = connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    const finish = (): void => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? '0');
      resolve({ status, head: data });
      socket.destroy();
    };
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      if (data.includes('\r\n\r\n')) finish();
    });
    socket.on('end', finish);
    socket.on('error', finish);
    setTimeout(finish, 3000);
  });
}

/** True when a TCP connection to this port succeeds, used to prove a listener is gone. */
export async function canConnect(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 2000);
  });
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for condition');
}

export function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
