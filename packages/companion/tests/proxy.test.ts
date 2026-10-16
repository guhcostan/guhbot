import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Host, hashToken, newToken } from '@guhbot/host-core';
import { GuhbotClient, HostServer } from '@guhbot/server';
import { createCompanion, createHostVerifyToken, type Companion } from '../src/index.js';
import { canConnect, rawHttpGet, rawUpgrade, safeParse, startFakeHarness, waitFor } from './support.js';

/**
 * The forwarding path, over real sockets.
 *
 * The first test is the one that matters most: a real harness, a real client and
 * the companion in between. It is the closest thing here to a phone on a LAN, and
 * it is the test that catches a proxy that drops the frames the harness sends
 * before the client-side handshake completes.
 */

let dataDir: string;
let stop: Array<() => Promise<void>> = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'guhbot-companion-'));
  stop = [];
});

afterEach(async () => {
  for (const dispose of stop.reverse()) await dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

async function bootHarness(): Promise<{ host: Host; server: HostServer; port: number }> {
  const host = new Host({ dataDir, version: '0.0.0-test', mode: 'self-hosted', capabilities: {} });
  const server = new HostServer({ host, port: 0 });
  const { port } = await server.listen();
  stop.push(async () => {
    await server.close();
    await host.close('test over');
  });
  return { host, server, port };
}

/** A paired device, created directly so the test does not depend on the pairing flow. */
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

async function bootCompanion(options: {
  harnessPort: number;
  verifyToken: (token: string) => Promise<{ id: string; name: string; class: 'person' | 'background' } | null>;
  allowedHosts?: readonly string[];
}): Promise<Companion> {
  const companion = createCompanion({
    harness: { host: '127.0.0.1', port: options.harnessPort },
    verifyToken: options.verifyToken,
    host: '127.0.0.1',
    port: 0,
    ...(options.allowedHosts !== undefined ? { allowedHosts: options.allowedHosts } : {}),
  });
  stop.push(() => companion.close());
  await companion.listen();
  return companion;
}

describe('forwarding', () => {
  it('carries the protocol end to end: a client reaches ready and calls a method through the companion', async () => {
    const { host, port: harnessPort } = await bootHarness();
    const device = pairDevice(host);
    host.store.createAgent({ name: 'Ops' });

    const companion = await bootCompanion({
      harnessPort,
      verifyToken: createHostVerifyToken(host),
    });

    const client = new GuhbotClient({
      url: `ws://127.0.0.1:${companion.port}/rpc`,
      token: device.token,
      autoReconnect: false,
    });
    stop.push(() => client.close());

    await client.connect();
    // `ready` is sent by the harness the instant the upstream opens, which is
    // before this companion has finished the client-side handshake. It has to
    // survive that window or the client waits forever.
    //
    // Worth knowing when reading this as a regression test: it is not the sharp
    // one for that window. GuhbotClient sends its own `auth` frame on open and the
    // harness answers with a second `ready`, so a proxy that drops the early
    // frames still lets this test pass (measured). The frame test below is the one
    // that pins it.
    await waitFor(() => client.state === 'ready');
    expect(client.deviceId).toBe(device.id);
    expect(client.deviceClass).toBe('background');

    // A real round trip, not just a handshake: the agent was created on the host
    // and is read back through the companion.
    const listed = await client.request('agents.list', {});
    expect(listed.agents.map((agent) => agent.name)).toEqual(['Ops']);

    // And the request really did reach the harness, which authenticated it as
    // the same device the companion verified.
    expect(companion.stats.acceptedConnections).toBe(1);
    expect(companion.stats.refusedAuth).toBe(0);
  });

  it('delivers the frames the harness sends before the client handshake completes', async () => {
    const { host, port: harnessPort } = await bootHarness();
    const device = pairDevice(host);

    // The regression test for the frame-dropping bug, and the reason the delay
    // seam exists. `handshakeDelayMs` holds the client-side handshake open across
    // the moment the harness speaks, so a proxy that attaches its forwarder too
    // late loses those frames deterministically. Without the delay the same proxy
    // often passes, because the harness's frames sometimes land in the same TCP
    // read as the upgrade response — which is luck, not correctness.
    const companion = createCompanion({
      harness: { port: harnessPort },
      verifyToken: createHostVerifyToken(host),
      host: '127.0.0.1',
      port: 0,
      handshakeDelayMs: 60,
    });
    stop.push(() => companion.close());
    await companion.listen();

    // A bare WebSocket that deliberately never sends an `auth` frame. That
    // matters: GuhbotClient always sends one, and the harness answers that with a
    // second `ready` — so a proxy that drops the early frames can hide behind the
    // client's own auth round trip. This client sends nothing, so `hello` and
    // `ready` can only arrive if they were buffered across the handshake.
    const socket = new WebSocket(`ws://127.0.0.1:${companion.port}/rpc?token=${encodeURIComponent(device.token)}`);
    stop.push(async () => {
      socket.terminate();
    });

    const frames: Array<Record<string, unknown>> = [];
    socket.on('message', (data) => {
      const parsed = safeParse(data.toString());
      if (parsed !== null) frames.push(parsed);
    });

    await waitFor(() => frames.length >= 2);
    expect(frames.map((frame) => frame['t'])).toEqual(['hello', 'ready']);
    expect(frames[1]?.['deviceId']).toBe(device.id);
  });

  it('rewrites Host to the loopback name the harness requires', async () => {
    const harness = await startFakeHarness();
    stop.push(() => harness.close());
    const companion = await bootCompanion({
      harnessPort: harness.port,
      verifyToken: async () => ({ id: 'dv_1', name: 'Phone', class: 'background' }),
      // The name the phone used. Without it the companion would refuse the
      // client's Host itself, which is the separate check below.
      allowedHosts: ['phone.lan'],
    });

    const socket = new WebSocket(`ws://127.0.0.1:${companion.port}/rpc?token=t`, {
      headers: { Host: 'phone.lan' },
    });
    stop.push(async () => {
      socket.terminate();
    });
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));

    // The client named one host; the harness must have been addressed as its own
    // loopback name, because it refuses anything else.
    await waitFor(() => harness.hosts.length === 1);
    expect(harness.hosts[0]).toBe(`127.0.0.1:${harness.port}`);
  });

  it('completes a client handshake that carried a non-loopback Host against a real harness', async () => {
    const { host, port: harnessPort } = await bootHarness();
    const device = pairDevice(host);
    const companion = await bootCompanion({
      harnessPort,
      verifyToken: createHostVerifyToken(host),
      allowedHosts: ['phone.lan'],
    });

    // The harness refuses `phone.lan` outright, so receiving `hello` proves the
    // rewrite happened rather than that the harness was lenient.
    const socket = new WebSocket(`ws://127.0.0.1:${companion.port}/rpc?token=${encodeURIComponent(device.token)}`, {
      headers: { Host: 'phone.lan' },
    });
    stop.push(async () => {
      socket.terminate();
    });

    const first = await new Promise<string>((resolve, reject) => {
      socket.on('message', (data) => resolve(data.toString()));
      socket.on('error', reject);
      setTimeout(() => reject(new Error('no frame from the harness within 3s')), 3000);
    });
    expect(safeParse(first)?.['t']).toBe('hello');
  });

  it('answers its own health probe without naming the harness', async () => {
    const { host, port: harnessPort } = await bootHarness();
    const companion = await bootCompanion({ harnessPort, verifyToken: createHostVerifyToken(host) });

    const response = await rawHttpGet(companion.port, `127.0.0.1:${companion.port}`, '/health');
    expect(response.status).toBe(200);
    expect(response.head).toContain('guhbot-companion');
    expect(response.head).not.toContain(String(harnessPort));
    expect(response.head).not.toContain('hostId');
  });
});

describe('shutdown', () => {
  it('is idempotent, stops accepting, and closes live upstream sockets', async () => {
    const harness = await startFakeHarness({ greet: true });
    stop.push(() => harness.close());
    const companion = createCompanion({
      harness: { port: harness.port },
      verifyToken: async () => ({ id: 'dv_1', name: 'Phone', class: 'background' }),
      host: '127.0.0.1',
      port: 0,
    });
    await companion.listen();
    const port = companion.port;

    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=t`);
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    await waitFor(() => harness.openSockets === 1);

    await companion.close();
    // Second call: a signal handler and a `finally` block can both call this.
    await companion.close();

    expect(harness.openSockets).toBe(0);
    await waitFor(() => socket.readyState === WebSocket.CLOSED);
    // The listener is gone: the port refuses connections rather than hanging.
    expect(await listenerGone(port)).toBe(true);
  });

  it('stops accepting upgrades after close()', async () => {
    const harness = await startFakeHarness();
    stop.push(() => harness.close());
    const companion = await bootCompanion({
      harnessPort: harness.port,
      verifyToken: async () => ({ id: 'dv_1', name: 'Phone', class: 'background' }),
    });
    await companion.close();

    const refused = await rawUpgrade(companion.port, { host: `127.0.0.1:${companion.port}`, token: 't' });
    // Either the listener is gone or it refuses; both mean "not accepting".
    expect([0, 503]).toContain(refused.status);
    expect(harness.upgrades).toBe(0);
  });
});

/** Polls until nothing is listening, because a closed listener can take a tick to disappear. */
async function listenerGone(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await canConnect(port))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
