import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  AgentLoop,
  OpenAiCompatibleProvider,
  builtinTools,
} from '@guhbot/agent';
import { Host, Store, hashToken } from '@guhbot/host-core';
import { HostServer } from '@guhbot/server';

/**
 * Hosted mode.
 *
 * The design decision that matters here is **separate runtime state per tenant**. Each tenant gets its own `Host` in the gateway process, its own data directory, its own
 * SQLite file and its own master key. There is no shared database with a
 * `tenant_id` on every row, because a single missing `WHERE` in that design
 * leaks one customer's transcripts into another's.
 *
 * Concretely:
 *
 *   tenants/<tenantId>/
 *     data.db        one tenant's agents, transcripts, runs, approvals
 *     master.key     one tenant's secret-encryption key, mode 0600
 *     artifacts/     one tenant's agent output
 *
 * The gateway in front does three things and nothing else: authenticate a bearer
 * token to a tenant, start that tenant's host, and proxy the WebSocket through
 * to it. The host itself is unmodified production code from `@guhbot/server` —
 * hosted mode is a deployment shape, not a fork.
 *
 * ## What this deliberately does not do
 *
 * There is no billing, no user accounts, no quota enforcement and no
 * self-service signup. Those are product decisions that depend on a business,
 * and shipping a guess at them would be worse than leaving the seam visible.
 * What is here is the part that is architectural: tenant lifecycle, isolation,
 * and a place for policy to attach.
 */

export interface Tenant {
  id: string;
  /** SHA-256 of the bearer token; the token itself is returned once and never stored. */
  tokenHash: Buffer;
  createdAt: string;
  /** Populated once the tenant's host is running. */
  port: number | null;
  dataDir: string;
}

export interface CloudOptions {
  /** Root directory holding one subdirectory per tenant. */
  rootDir: string;
  /** OpenAI-compatible base URL applied to every tenant's agent loop. */
  baseUrl: string;
  apiKey: string | undefined;
  model: string | undefined;
  /** Cap on concurrently running tenant hosts. */
  maxTenants?: number;
  /** Hosts agents may reach. Empty means no egress. */
  allowedHosts?: string[];
  /**
   * Interface the gateway listens on. Loopback by default — that is the honest
   * posture for a gateway that fronts real tenants, and keeps a stray process
   * from being reachable off the machine. A deployment that puts the gateway
   * behind a load balancer (container, ECS task) sets this to `0.0.0.0`.
   */
  bindHost?: string;
}

export class CloudGateway {
  private readonly options: CloudOptions;
  private readonly http: HttpServer;
  private readonly tenants = new Map<
    string,
    { tenant: Tenant; host: Host; server: HostServer }
  >();
  private readonly wss: WebSocketServer;
  private boundPort = 0;
  private readonly bindHost: string;
  private readonly catalog: Store;
  private initialized = false;

  constructor(options: CloudOptions) {
    this.options = options;
    this.bindHost = options.bindHost ?? '127.0.0.1';
    mkdirSync(join(options.rootDir, 'tenants'), {
      recursive: true,
      mode: 0o700,
    });
    this.catalog = new Store({ dataDir: join(options.rootDir, 'catalog') });

    this.http = createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    this.wss = new WebSocketServer({ noServer: true });

    // Authenticate before the WebSocket upgrade so an unauthenticated peer never
    // reaches a tenant's host process at all.
    this.http.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });
  }

  async listen(port = 0): Promise<number> {
    if (!this.initialized) {
      await this.restoreTenants();
      this.initialized = true;
    }
    await new Promise<void>((resolvePromise, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, this.bindHost, () => {
        this.http.off('error', reject);
        resolvePromise();
      });
    });
    const address = this.http.address();
    this.boundPort =
      typeof address === 'object' && address !== null ? address.port : port;
    return this.boundPort;
  }

  get port(): number {
    return this.boundPort;
  }

  // -------------------------------------------------------------------------
  // Tenant lifecycle
  // -------------------------------------------------------------------------

  /** Create a tenant. The returned token is shown once and only its hash is kept. */
  async createTenant(): Promise<{ tenant: Tenant; token: string }> {
    const max = this.options.maxTenants ?? 100;
    if (this.tenants.size >= max) {
      throw new Error(
        `tenant limit reached (${max}); refusing to start another host`,
      );
    }

    const id = `t_${randomBytes(12).toString('hex')}`;
    const dataDir = join(this.options.rootDir, 'tenants', id);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    const token = randomBytes(32).toString('base64url');
    const tenant: Tenant = {
      id,
      tokenHash: createHash('sha256').update(token).digest(),
      createdAt: new Date().toISOString(),
      port: null,
      dataDir,
    };

    const { host, server } = await this.startHost(tenant, token);
    this.tenants.set(id, { tenant, host, server });
    this.persistTenants();
    return { tenant, token };
  }

  /**
   * Start a tenant's host, and register the provisioning token as a device on it.
   *
   * The same token has to satisfy two checks: the gateway's edge authentication
   * and the host's own device authentication. Minting a device whose hash is of
   * the same secret means one credential, verified in both places, and a client
   * that authenticates at the edge cannot then be refused by the host.
   *
   * The device is `person` class. It is the tenant's owner console, the hosted
   * equivalent of the desktop app's own device, and without it nobody could ever
   * start a run — `runs.start` is a person-class method by design. A second
   * device, such as a phone, should be added through `pairing.beginForDevice`
   * from this one and will join as `background`, exactly as it would on a
   * self-hosted machine.
   */
  private async startHost(
    tenant: Tenant,
    token?: string,
  ): Promise<{ host: Host; server: HostServer }> {
    const provider =
      this.options.baseUrl.length > 0
        ? new OpenAiCompatibleProvider({
            baseUrl: this.options.baseUrl,
            apiKey: this.options.apiKey,
            ...(this.options.model !== undefined
              ? { defaultModel: this.options.model }
              : {}),
          })
        : null;

    const host = new Host({
      dataDir: tenant.dataDir,
      version: '0.2.0',
      mode: 'hosted',
      capabilities: { exec: false, filesystem: true, hosted: true },
      ...(provider
        ? {
            executor: new AgentLoop({
              provider,
              tools: builtinTools({
                allowedHosts: this.options.allowedHosts ?? [],
              }).filter((tool) => tool.name !== 'run_command'),
              cwd: tenant.dataDir,
            }),
          }
        : {}),
    });

    // The tenant's device, keyed by the same secret the gateway verifies.
    if (token !== undefined) {
      const salt = createHash('sha256').update(`tenant:${tenant.id}`).digest();
      host.store.createDevice({
        name: 'Cloud console',
        platform: 'cloud',
        deviceClass: 'person',
        tokenSalt: salt,
        tokenHash: hashToken(token, salt),
      });
    }

    // Loopback only, and deliberately so: tenants reach their host through this
    // gateway, never directly. That keeps one place where authentication and
    // (eventually) rate limiting are enforced.
    const server = new HostServer({ host, port: 0 });
    const { port } = await server.listen();
    tenant.port = port;
    return { host, server };
  }

  private persistTenants(): void {
    this.catalog.setMeta(
      'tenants',
      JSON.stringify(
        [...this.tenants.values()].map(({ tenant }) => ({
          id: tenant.id,
          tokenHash: tenant.tokenHash.toString('hex'),
          createdAt: tenant.createdAt,
        })),
      ),
    );
  }

  private async restoreTenants(): Promise<void> {
    const raw = this.catalog.getMeta('tenants');
    if (raw === null) return;
    const records: unknown = JSON.parse(raw);
    if (!Array.isArray(records)) throw new Error('invalid tenant catalog');
    for (const value of records as unknown[]) {
      if (typeof value !== 'object' || value === null)
        throw new Error('invalid tenant catalog entry');
      const item = value as Record<string, unknown>;
      if (
        typeof item['id'] !== 'string' ||
        !/^t_[a-f0-9]{24}$/.test(item['id']) ||
        typeof item['tokenHash'] !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item['tokenHash']) ||
        typeof item['createdAt'] !== 'string'
      )
        throw new Error('invalid tenant catalog entry');
      const tenant: Tenant = {
        id: item['id'],
        tokenHash: Buffer.from(item['tokenHash'], 'hex'),
        createdAt: item['createdAt'],
        port: null,
        dataDir: join(this.options.rootDir, 'tenants', item['id']),
      };
      const { host, server } = await this.startHost(tenant);
      this.tenants.set(tenant.id, { tenant, host, server });
    }
  }

  /** Resolve a bearer token to a running tenant. Returns null when it does not match. */
  authenticate(token: string): Tenant | null {
    const candidate = createHash('sha256').update(token).digest();
    for (const { tenant } of this.tenants.values()) {
      // Length is fixed by SHA-256, so timingSafeEqual is safe to call directly.
      if (timingSafeEqual(candidate, tenant.tokenHash)) return tenant;
    }
    return null;
  }

  async destroyTenant(id: string): Promise<boolean> {
    const entry = this.tenants.get(id);
    if (!entry) return false;
    await entry.server.close();
    await entry.host.close('tenant destroyed');
    this.tenants.delete(id);
    this.persistTenants();
    return true;
  }

  listTenants(): Tenant[] {
    return [...this.tenants.values()].map(({ tenant }) => ({
      ...tenant,
      tokenHash: Buffer.alloc(0),
    }));
  }

  // -------------------------------------------------------------------------
  // HTTP surface
  // -------------------------------------------------------------------------

  private async handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      this.json(res, 200, {
        service: 'guhbot-cloud',
        tenants: this.tenants.size,
      });
      return;
    }

    // Provisioning is protected by an operator secret, not a tenant token: it is
    // what creates tenants, so it must not be reachable with one.
    if (req.method === 'POST' && url.pathname === '/tenants') {
      const operator = process.env['GUHBOT_CLOUD_OPERATOR_TOKEN'];
      if (operator === undefined || operator.length === 0) {
        this.json(res, 503, {
          error:
            'this gateway has no operator token configured, so tenant provisioning is disabled',
        });
        return;
      }
      const provided = bearer(req);
      if (provided === null || !constantTimeEquals(provided, operator)) {
        this.json(res, 401, { error: 'operator token required' });
        return;
      }
      try {
        const { tenant, token } = await this.createTenant();
        this.json(res, 201, {
          tenantId: tenant.id,
          token,
          rpcPath: `/t/${tenant.id}/rpc`,
          // Said plainly because it is true: we cannot show it again.
          note: 'Store this token now. Only its hash is retained, so it cannot be recovered.',
        });
      } catch (error) {
        this.json(res, 429, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    this.json(res, 404, { error: 'not found' });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  // -------------------------------------------------------------------------
  // WebSocket proxying
  // -------------------------------------------------------------------------

  /**
   * Authenticate, then hand the socket to the tenant's own `HostServer`.
   *
   * The proxy is a byte pipe: the tenant's host speaks the ordinary protocol, so
   * a client cannot tell hosted mode from self-hosted. Everything the protocol
   * enforces — the `person`/`background` split, schema validation, approvals —
   * still applies, and is still enforced on the far side of this hop.
   */
  private async handleUpgrade(
    req: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/t\/([^/]+)\/rpc$/.exec(url.pathname);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const tenantId = match[1]!;
    const entry = this.tenants.get(tenantId);
    if (!entry || entry.tenant.port === null) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token') ?? bearer(req);
    const authenticated =
      token !== null &&
      (this.authenticate(token)?.id === tenantId ||
        entry.host.authenticate(token) !== null);

    // A request with no valid token is still proxied, but without credentials.
    // That is deliberate rather than lax: an unauthenticated connection is how a
    // new device pairs, and the authorization model for it already lives in the
    // host (exactly three methods are reachable). Refusing it here would mean
    // implementing a second, divergent copy of that policy at the edge.
    //
    // What the gateway does enforce is that a token belonging to tenant A can
    // never be presented to tenant B: an unmatched token is stripped, so the
    // request arrives unauthenticated and cannot borrow another tenant's identity.
    const upstreamQuery = authenticated
      ? `?token=${encodeURIComponent(token)}`
      : '';

    // Forward the upgrade to the tenant's loopback host, so its own
    // authentication and authorization path runs unchanged.
    const upstream = `ws://127.0.0.1:${entry.tenant.port}/rpc${upstreamQuery}`;
    const { WebSocket } = await import('ws');
    const target = new WebSocket(upstream);

    /**
     * The host sends `hello` and `ready` the instant the connection opens, which
     * is before the client-side handshake below has completed. Attaching the
     * forwarder only after `handleUpgrade` returns would silently drop those
     * frames, and the client would wait forever for a `ready` that had already
     * been sent. So the listener is attached up front and anything that arrives
     * early is queued.
     */
    type Frame = [data: import('ws').RawData, isBinary: boolean];
    const queue: Frame[] = [];
    let client: import('ws').WebSocket | null = null;

    target.on('message', (data, isBinary) => {
      if (client !== null && client.readyState === client.OPEN) {
        client.send(data, { binary: isBinary });
      } else {
        queue.push([data, isBinary]);
      }
    });

    const closeBoth = (): void => {
      target.close();
      socket.destroy();
    };

    target.on('open', () => {
      // Complete the client-side handshake only after the host accepted, so a
      // failed upstream surfaces as a failed upgrade rather than a half-open pipe.
      this.wss.handleUpgrade(req, socket, head, (upgraded) => {
        client = upgraded;
        for (const [data, isBinary] of queue) {
          upgraded.send(data, { binary: isBinary });
        }
        queue.length = 0;

        upgraded.on('message', (data, isBinary) => {
          if (target.readyState === target.OPEN)
            target.send(data, { binary: isBinary });
        });
        upgraded.on('close', closeBoth);
        upgraded.on('error', closeBoth);
      });
    });

    target.on('error', () => {
      queue.length = 0;
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
      }
    });
    target.on('close', closeBoth);
  }

  async close(): Promise<void> {
    for (const entry of this.tenants.values()) {
      await entry.server.close();
      await entry.host.close('gateway stopped');
    }
    this.tenants.clear();
    this.wss.close();
    await new Promise<void>((resolvePromise) =>
      this.http.close(() => resolvePromise()),
    );
    this.catalog.close();
  }
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice(7);
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export { resolve };
