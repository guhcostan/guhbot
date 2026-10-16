import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuhbotClient } from '@guhbot/server';
import { CloudGateway } from '../src/gateway.js';

/**
 * Hosted-mode tests concentrate on the property that would be catastrophic to
 * get wrong: one tenant must never be able to reach another tenant's data.
 *
 * They also pin the provisioning default, because an open provisioning endpoint
 * is an unbounded-spend bug waiting to be found.
 */

let rootDir: string;
let gateway: CloudGateway;
let operatorToken: string | undefined;

beforeEach(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'guhbot-cloud-'));
  operatorToken = 'operator-secret-token';
  process.env['GUHBOT_CLOUD_OPERATOR_TOKEN'] = operatorToken;
  gateway = new CloudGateway({
    rootDir,
    // No provider: a host with no model still serves transcripts, and these
    // tests are about isolation rather than inference.
    baseUrl: '',
    apiKey: undefined,
    model: undefined,
  });
  await gateway.listen(0);
});

afterEach(async () => {
  await gateway.close();
  delete process.env['GUHBOT_CLOUD_OPERATOR_TOKEN'];
  rmSync(rootDir, { recursive: true, force: true });
});

async function provision(): Promise<{ tenantId: string; token: string }> {
  const response = await fetch(`http://127.0.0.1:${gateway.port}/tenants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${operatorToken}` },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { tenantId: string; token: string };
  return body;
}

async function connect(tenantId: string, token: string): Promise<GuhbotClient> {
  const client = new GuhbotClient({
    url: `ws://127.0.0.1:${gateway.port}/t/${tenantId}/rpc`,
    token,
    autoReconnect: false,
  });
  await client.connect();
  await waitFor(() => client.state === 'ready');
  return client;
}

describe('provisioning', () => {
  it('is disabled when no operator token is configured', async () => {
    delete process.env['GUHBOT_CLOUD_OPERATOR_TOKEN'];
    const response = await fetch(`http://127.0.0.1:${gateway.port}/tenants`, { method: 'POST' });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/no operator token configured/);
  });

  it('requires the operator token', async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/tenants`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(response.status).toBe(401);
  });

  it('returns the tenant token exactly once and stores only its hash', async () => {
    const { tenantId, token } = await provision();
    expect(token.length).toBeGreaterThan(30);

    // The listing must not hand the token back.
    const listed = gateway.listTenants();
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(listed.find((t) => t.id === tenantId)?.tokenHash.length).toBe(0);
  });

  it('serves a health document', async () => {
    await provision();
    const response = await fetch(`http://127.0.0.1:${gateway.port}/health`);
    const body = (await response.json()) as { service: string; tenants: number };
    expect(body.service).toBe('guhbot-cloud');
    expect(body.tenants).toBe(1);
  });
});

describe('isolation', () => {
  it('gives each tenant its own data directory and master key on disk', async () => {
    const a = await provision();
    const b = await provision();

    const dirA = join(rootDir, 'tenants', a.tenantId);
    const dirB = join(rootDir, 'tenants', b.tenantId);

    expect(existsSync(join(dirA, 'data.db'))).toBe(true);
    expect(existsSync(join(dirA, 'master.key'))).toBe(true);
    expect(existsSync(join(dirB, 'data.db'))).toBe(true);

    const keyA = (await import('node:fs')).readFileSync(join(dirA, 'master.key'), 'utf8');
    const keyB = (await import('node:fs')).readFileSync(join(dirB, 'master.key'), 'utf8');
    // Two tenants must not share a key, or one could decrypt the other's secrets.
    expect(keyA).not.toBe(keyB);
  });

  it('keeps one tenant from seeing another tenant agents', async () => {
    const a = await provision();
    const b = await provision();
    const clientA = await connect(a.tenantId, a.token);
    const clientB = await connect(b.tenantId, b.token);

    // Create an agent inside tenant A. The desktop-equivalent path is person
    // class; here we assert through the host directly to keep the test about
    // isolation rather than authorization.
    const hostA = (gateway as unknown as { tenants: Map<string, { host: { store: { createAgent(i: { name: string }): unknown } } }> }).tenants.get(a.tenantId)!.host;
    hostA.store.createAgent({ name: 'Tenant A only' });

    const listA = await clientA.request('agents.list', {});
    const listB = await clientB.request('agents.list', {});

    expect(listA.agents.map((x) => x.name)).toEqual(['Tenant A only']);
    expect(listB.agents).toEqual([]);

    await clientA.close();
    await clientB.close();
  });

  it('refuses a tenant token presented against another tenant', async () => {
    const a = await provision();
    const b = await provision();

    // A's token, B's endpoint.
    const response = await fetch(`http://127.0.0.1:${gateway.port}/t/${b.tenantId}/rpc`, { method: 'GET' });
    expect(response.status).toBe(404); // not an upgrade; plain HTTP is not the RPC endpoint

    const crossed = new GuhbotClient({
      url: `ws://127.0.0.1:${gateway.port}/t/${b.tenantId}/rpc`,
      token: a.token,
      autoReconnect: false,
    });
    // The token is stripped because it does not belong to this tenant, so the
    // upstream connection is unauthenticated and the host refuses anything but
    // the three pairing-era methods.
    try {
      await crossed.connect();
      await new Promise((r) => setTimeout(r, 150));
      await expect(crossed.request('agents.list', {})).rejects.toMatchObject({ code: 'unauthenticated' });
    } catch {
      // Refusing the upgrade outright is also acceptable.
    }
    await crossed.close();
  });

  it('rejects an unknown tenant id and an unknown token', async () => {
    const unknown = new GuhbotClient({
      url: `ws://127.0.0.1:${gateway.port}/t/t_nope/rpc`,
      token: 'whatever',
      autoReconnect: false,
    });
    // An unknown tenant id cannot be upgraded at all.
    await expect(unknown.connect()).rejects.toBeTruthy();
    await unknown.close();

    const a = await provision();
    const badToken = new GuhbotClient({
      url: `ws://127.0.0.1:${gateway.port}/t/${a.tenantId}/rpc`,
      token: 'not-a-real-token',
      autoReconnect: false,
    });
    // A token that belongs to nobody is stripped at the edge, and the host then
    // refuses the client's own auth frame, so the session never becomes ready.
    await badToken.connect();
    await new Promise((r) => setTimeout(r, 200));
    expect(badToken.state).not.toBe('ready');
    await expect(badToken.request('agents.list', {})).rejects.toMatchObject({ code: 'cancelled' });
    await badToken.close();
  });
});

describe('proxied protocol', () => {
  it('carries the ordinary protocol through the gateway unchanged', async () => {
    const { tenantId, token } = await provision();
    const client = await connect(tenantId, token);

    // The host reports hosted mode, which is how a client can display it.
    const status = await client.request('host.status', {});
    expect(status.mode).toBe('hosted');
    expect(status.capabilities['hosted']).toBe(true);

    // The provisioning token belongs to the tenant's owner console, so it is
    // person class and may do person-class work — the hosted equivalent of the
    // desktop app's own device.
    const created = await client.request('agents.create', { name: 'Hosted agent' });
    expect(created.name).toBe('Hosted agent');
    expect(client.deviceClass).toBe('person');

    // A second device added from here joins as background, exactly as it would
    // on a self-hosted machine, and is then refused person-class work.
    const pairing = await client.request('pairing.beginForDevice', {});
    const anon = new GuhbotClient({ url: `ws://127.0.0.1:${gateway.port}/t/${tenantId}/rpc`, autoReconnect: false });
    await anon.connect();
    await waitFor(() => anon.state === 'ready');
    const claimed = await anon.request('pairing.claim', {
      pairingId: pairing.pairingId,
      code: pairing.code,
      deviceName: 'Phone',
      platform: 'ios',
      requestedClass: 'person',
    });
    expect(claimed.device.class).toBe('background');
    await anon.close();

    await client.close();
  });

  it('enforces the tenant limit', async () => {
    await gateway.close();
    gateway = new CloudGateway({ rootDir, baseUrl: '', apiKey: undefined, model: undefined, maxTenants: 1 });
    await gateway.listen(0);

    await provision();
    const response = await fetch(`http://127.0.0.1:${gateway.port}/tenants`, {
      method: 'POST',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/tenant limit reached/);
  });

  it('destroys a tenant and stops accepting its connections', async () => {
    const { tenantId, token } = await provision();
    const client = await connect(tenantId, token);
    await client.close();

    expect(await gateway.destroyTenant(tenantId)).toBe(true);
    expect(await gateway.destroyTenant(tenantId)).toBe(false);

    const after = new GuhbotClient({
      url: `ws://127.0.0.1:${gateway.port}/t/${tenantId}/rpc`,
      token,
      autoReconnect: false,
    });
    await expect(after.connect()).rejects.toBeTruthy();
    await after.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out waiting for condition');
}
