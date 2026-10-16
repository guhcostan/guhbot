import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Host, hashToken, newToken } from '@guhbot/host-core';
import { GuhbotClient, HostServer } from '@guhbot/server';
import type { RpcError } from '@guhbot/protocol';
import {
  CompanionConfigError,
  REDACTED_PATH,
  createCompanion,
  createHostVerifyToken,
  pseudonymizeHostId,
  scrubServerFrame,
  type Companion,
  type DeviceIdentity,
} from '../src/index.js';
import { rawUpgrade, startFakeHarness, waitFor } from './support.js';

/**
 * The security properties this process exists to provide.
 *
 * Every refusal here is asserted twice where it matters: once against the
 * companion's response, and once against a count of what reached the harness. A
 * refusal that still opens an upstream connection is not a refusal.
 */

let dataDir: string;
let stop: Array<() => Promise<void>> = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'guhbot-companion-sec-'));
  stop = [];
});

afterEach(async () => {
  for (const dispose of stop.reverse()) await dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

async function bootHarness(): Promise<{ host: Host; port: number }> {
  const host = new Host({ dataDir, version: '0.0.0-test', mode: 'self-hosted', capabilities: {} });
  const server = new HostServer({ host, port: 0 });
  const { port } = await server.listen();
  stop.push(async () => {
    await server.close();
    await host.close('test over');
  });
  return { host, port };
}

function pairDevice(host: Host, name = 'Test Phone'): { token: string; id: string } {
  const salt = Buffer.from(`test-salt:${name}`, 'utf8');
  const token = newToken();
  const device = host.store.createDevice({
    name,
    platform: 'ios',
    deviceClass: 'background',
    tokenSalt: salt,
    tokenHash: hashToken(token, salt),
  });
  return { token, id: device.id };
}

async function boot(options: {
  harnessPort: number;
  verifyToken: (token: string) => Promise<DeviceIdentity | null>;
  allowedHosts?: readonly string[];
  allowPairing?: boolean;
  redactPaths?: readonly string[];
  advertisedAddresses?: readonly string[];
  now?: () => number;
}): Promise<Companion> {
  const companion = createCompanion({
    harness: { port: options.harnessPort },
    verifyToken: options.verifyToken,
    host: '127.0.0.1',
    port: 0,
    ...(options.allowedHosts !== undefined ? { allowedHosts: options.allowedHosts } : {}),
    ...(options.allowPairing !== undefined ? { allowPairing: options.allowPairing } : {}),
    ...(options.redactPaths !== undefined ? { redactPaths: options.redactPaths } : {}),
    ...(options.advertisedAddresses !== undefined ? { advertisedAddresses: options.advertisedAddresses } : {}),
    ...(options.now !== undefined ? { rateLimit: { now: options.now } } : {}),
  });
  stop.push(() => companion.close());
  await companion.listen();
  return companion;
}

describe('token verification', () => {
  it('refuses an unknown token without the harness seeing a connection', async () => {
    const harness = await startFakeHarness();
    stop.push(() => harness.close());
    const verify = vi.fn(async () => null);
    const companion = await boot({ harnessPort: harness.port, verifyToken: verify });

    const refused = await rawUpgrade(companion.port, {
      host: `127.0.0.1:${companion.port}`,
      token: 'not-a-real-token',
    });

    expect(refused.status).toBe(401);
    expect(refused.head).not.toContain('not-a-real-token');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(companion.stats.refusedAuth).toBe(1);
    // The point of the check: no upstream socket was ever opened.
    expect(harness.upgrades).toBe(0);
    expect(companion.stats.acceptedConnections).toBe(0);
  });

  it('refuses a bearer token presented in the Authorization header', async () => {
    const harness = await startFakeHarness();
    stop.push(() => harness.close());
    const companion = await boot({ harnessPort: harness.port, verifyToken: async () => null });

    const refused = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${companion.port}/rpc`, {
        headers: { Authorization: 'Bearer wrong' },
      });
      socket.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        socket.terminate();
      });
      socket.on('error', () => resolve(0));
      setTimeout(() => resolve(0), 3000);
    });

    expect(refused).toBe(401);
    expect(harness.upgrades).toBe(0);
  });

  it('refuses a revoked token on the next attempt, and the harness never sees the retry', async () => {
    const { host, port: harnessPort } = await bootHarness();
    const device = pairDevice(host);

    // Count what the harness is actually asked to create a session for. This is
    // the harness's own "a connection arrived" moment.
    const original = host.createSession.bind(host);
    let harnessConnections = 0;
    host.createSession = (channel, sessionDevice = null) => {
      harnessConnections += 1;
      return original(channel, sessionDevice);
    };

    const companion = await boot({ harnessPort, verifyToken: createHostVerifyToken(host) });

    const first = await rawUpgrade(companion.port, { host: `127.0.0.1:${companion.port}`, token: device.token });
    expect(first.status).toBe(101);
    await waitFor(() => harnessConnections === 1);

    // Revocation is immediate: the very next attempt is refused at the edge.
    expect(host.store.revokeDevice(device.id)).toBe(true);
    const second = await rawUpgrade(companion.port, { host: `127.0.0.1:${companion.port}`, token: device.token });
    expect(second.status).toBe(401);
    expect(harnessConnections).toBe(1);
    expect(host.authenticate(device.token)).toBeNull();
  });

  it('fails closed when the verifier itself throws', async () => {
    const harness = await startFakeHarness();
    stop.push(() => harness.close());
    const companion = await boot({
      harnessPort: harness.port,
      verifyToken: async () => {
        throw new Error('control plane is down');
      },
    });

    const refused = await rawUpgrade(companion.port, { host: `127.0.0.1:${companion.port}`, token: 't' });
    expect(refused.status).toBe(401);
    expect(harness.upgrades).toBe(0);
  });

  it('refuses an unauthenticated connection entirely when pairing passthrough is off', async () => {
    const harness = await startFakeHarness();
    stop.push(() => harness.close());
    const companion = await boot({ harnessPort: harness.port, verifyToken: async () => null, allowPairing: false });

    const refused = await rawUpgrade(companion.port, { host: `127.0.0.1:${companion.port}` });
    expect(refused.status).toBe(401);
    expect(harness.upgrades).toBe(0);
  });

  it('lets an unauthenticated phone pair, because that is the one flow with no token yet', async () => {
    const { host, port: harnessPort } = await bootHarness();
    const companion = await boot({ harnessPort, verifyToken: createHostVerifyToken(host) });

    // Pairing codes are minted on the host console — `HostServer.createPairing`
    // is the same call. The companion cannot mint one, which is why it has to let
    // an unpaired phone through at all.
    const pairing = host.beginPairing();

    const client = new GuhbotClient({ url: `ws://127.0.0.1:${companion.port}/rpc`, autoReconnect: false });
    stop.push(() => client.close());
    await client.connect();
    await waitFor(() => client.state === 'ready');
    expect(client.deviceId).toBe('anonymous');

    const claimed = await client.request('pairing.claim', {
      pairingId: pairing.pairingId,
      code: pairing.code,
      deviceName: 'New phone',
      platform: 'ios',
      requestedClass: 'background',
    });
    expect(claimed.device.class).toBe('background');

    // And the token it just received works through the companion on reconnect.
    const authed = new GuhbotClient({
      url: `ws://127.0.0.1:${companion.port}/rpc`,
      token: claimed.token,
      autoReconnect: false,
    });
    stop.push(() => authed.close());
    await authed.connect();
    await waitFor(() => authed.state === 'ready');
    expect(authed.deviceId).toBe(claimed.device.id);
  });

  it('answers an in-band auth frame with a refusal rather than forwarding a bad token', async () => {
    const harness = await startFakeHarness({ greet: true });
    stop.push(() => harness.close());
    const companion = await boot({ harnessPort: harness.port, verifyToken: async () => null });

    const socket = new WebSocket(`ws://127.0.0.1:${companion.port}/rpc`, { headers: { Host: '127.0.0.1' } });
    stop.push(async () => {
      socket.terminate();
    });
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    socket.send(JSON.stringify({ t: 'auth', token: 'guessed' }));

    const refusal = await new Promise<Record<string, unknown>>((resolve) => {
      socket.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if (parsed['t'] === 'res') resolve(parsed);
      });
      setTimeout(() => resolve({}), 3000);
    });
    expect(refusal['ok']).toBe(false);
    expect((refusal['error'] as { code?: string } | undefined)?.code).toBe('unauthenticated');
    // Only the greeting the fake harness sends itself reached this client: the
    // auth frame never went upstream.
    expect(harness.frames).toEqual([]);
  });
});

describe('Host header on the companion side', () => {
  it('refuses an upgrade for a hostname it was not configured to answer for', async () => {
    const harness = await startFakeHarness();
    stop.push(() => harness.close());
    const companion = await boot({
      harnessPort: harness.port,
      verifyToken: async () => ({ id: 'dv_1', name: 'Phone', class: 'background' }),
    });

    // The DNS-rebinding case: a page the user merely visited resolves evil.test
    // to this machine and the browser carries the attacker's name in Host.
    const refused = await rawUpgrade(companion.port, { host: 'evil.test', token: 't' });
    expect(refused.status).toBe(403);
    expect(harness.upgrades).toBe(0);
    expect(companion.stats.refusedHost).toBe(1);

    // An address literal is the normal way a phone arrives, and is accepted.
    const accepted = await rawUpgrade(companion.port, { host: `127.0.0.1:${companion.port}`, token: 't' });
    expect(accepted.status).toBe(101);
  });

  it('answers for a hostname it was configured to answer for', async () => {
    const harness = await startFakeHarness();
    stop.push(() => harness.close());
    const companion = await boot({
      harnessPort: harness.port,
      verifyToken: async () => ({ id: 'dv_1', name: 'Phone', class: 'background' }),
      allowedHosts: ['guhbot.example.ts.net'],
    });

    const accepted = await rawUpgrade(companion.port, { host: 'guhbot.example.ts.net:8787', token: 't' });
    expect(accepted.status).toBe(101);
  });

  it('refuses a request with no Host at all', async () => {
    const harness = await startFakeHarness();
    stop.push(() => harness.close());
    const companion = await boot({
      harnessPort: harness.port,
      verifyToken: async () => ({ id: 'dv_1', name: 'Phone', class: 'background' }),
    });

    const refused = await rawUpgrade(companion.port, { host: '', token: 't' });
    expect(refused.status).toBe(403);
    expect(harness.upgrades).toBe(0);
  });

  it('reads a bracketed IPv6 literal without mistaking its colons for a port', async () => {
    const harness = await startFakeHarness();
    stop.push(() => harness.close());
    const companion = await boot({
      harnessPort: harness.port,
      verifyToken: async () => ({ id: 'dv_1', name: 'Phone', class: 'background' }),
    });

    const accepted = await rawUpgrade(companion.port, { host: `[::1]:${companion.port}`, token: 't' });
    expect(accepted.status).toBe(101);
    expect(harness.upgrades).toBe(1);
  });
});

describe('plaintext acknowledgement', () => {
  const verifyToken = async (): Promise<DeviceIdentity | null> => null;

  it('refuses a non-loopback bind without an explicit acknowledgement', () => {
    expect(() => createCompanion({ harness: { port: 1 }, verifyToken, host: '0.0.0.0', port: 0 })).toThrow(
      CompanionConfigError,
    );
    // And the refusal says what the acknowledgement would mean.
    expect(() => createCompanion({ harness: { port: 1 }, verifyToken, host: '0.0.0.0', port: 0 })).toThrow(
      /device tokens would cross that network in the clear/,
    );
  });

  it('allows a loopback bind, and allows the network bind once acknowledged', async () => {
    const loopback = createCompanion({ harness: { port: 1 }, verifyToken, host: '127.0.0.1', port: 0 });
    await loopback.listen();
    await loopback.close();

    const acknowledged = createCompanion({
      harness: { port: 1 },
      verifyToken,
      host: '0.0.0.0',
      port: 0,
      insecurePlaintext: true,
    });
    await acknowledged.listen();
    await acknowledged.close();
  });
});

describe('response scrubbing', () => {
  it('replaces the harness endpoint and pseudonymizes the host id in host.status', async () => {
    const { host, port: harnessPort } = await bootHarness();
    const device = pairDevice(host);
    const companion = await boot({
      harnessPort,
      verifyToken: createHostVerifyToken(host),
      advertisedAddresses: ['10.0.0.9'],
    });

    const client = new GuhbotClient({
      url: `ws://127.0.0.1:${companion.port}/rpc`,
      token: device.token,
      autoReconnect: false,
    });
    stop.push(() => client.close());
    await client.connect();
    await waitFor(() => client.state === 'ready');

    const status = await client.request('host.status', {});
    // The phone must be told somewhere it can actually reach, not the harness's
    // loopback port, which for the phone is the phone itself.
    expect(status.port).toBe(companion.port);
    expect(status.addresses).toEqual(['10.0.0.9']);
    expect(status.hostId).not.toBe(host.hostId);
    expect(status.hostId).toMatch(/^cmp_[0-9a-f]{24}$/);
    // Everything a client needs to decide what it can do survives.
    expect(status.mode).toBe('self-hosted');
    expect(status.version).toBe('0.0.0-test');
  });

  it('strips a declared path out of an error message, and leaves events alone', async () => {
    const { host, port: harnessPort } = await bootHarness();
    const device = pairDevice(host);
    const artifactsDir = host.store.artifactsDir;
    const companion = await boot({
      harnessPort,
      verifyToken: createHostVerifyToken(host),
      redactPaths: [artifactsDir],
    });

    const client = new GuhbotClient({
      url: `ws://127.0.0.1:${companion.port}/rpc`,
      token: device.token,
      autoReconnect: false,
    });
    stop.push(() => client.close());
    await client.connect();
    await waitFor(() => client.state === 'ready');

    // The harness answers a missing artifact by naming its absolute path.
    const error = await client
      .request('artifacts.get', { agentId: 'ag_missing', path: join(artifactsDir, 'nope.txt') })
      .then(() => null, (failure: RpcError) => failure);

    expect(error?.code).toBe('not-found');
    expect(error?.message).toContain(REDACTED_PATH);
    expect(error?.message).not.toContain(artifactsDir);
    expect(error?.message).not.toContain(dataDir);
  });

  it('does not rewrite event payloads, because they are the user\'s own data', () => {
    const payload = { entry: { content: `wrote ${dataDir}/workspace/notes.md` } };
    const frame = { t: 'evt', event: 'transcript.appended', payload } as const;
    const result = scrubServerFrame(frame, null, {
      addresses: ['10.0.0.9'],
      port: 8787,
      redactPaths: [dataDir],
      identitySalt: '',
    });
    expect(result.changed).toBe(false);
    expect(result.frame).toEqual(frame);
  });

  it('derives a stable, one-way host-id pseudonym', () => {
    const first = pseudonymizeHostId('host_abc', 'salt');
    expect(first).toBe(pseudonymizeHostId('host_abc', 'salt'));
    expect(first).not.toBe(pseudonymizeHostId('host_abc', 'other'));
    expect(first).not.toContain('host_abc');
  });
});
