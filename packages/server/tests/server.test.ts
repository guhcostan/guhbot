import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentLoop } from '@guhbot/agent';
import { Host } from '@guhbot/host-core';
import type { Entry } from '@guhbot/protocol';
import { GuhbotClient, HostServer } from '../src/index.js';
import type { ModelEvent, ModelProvider, ModelRequest } from '@guhbot/agent';

/**
 * End-to-end over a real socket.
 *
 * These tests exercise the path a phone actually takes: open a WebSocket,
 * claim a pairing code while unauthenticated, then drive the host with a device
 * token. They are the closest thing here to an acceptance test.
 */

class OneTurnProvider implements ModelProvider {
  readonly id = 'one-turn';
  readonly defaultModel = 'm';
  async *stream(_request: ModelRequest): AsyncGenerator<ModelEvent> {
    yield { type: 'text-delta', text: 'work done' };
    yield { type: 'stop', reason: 'end' };
  }
}

let dataDir: string;

async function boot(options: { executor?: AgentLoop } = {}) {
  const host = new Host({
    dataDir,
    version: '0.0.0-test',
    mode: 'self-hosted',
    capabilities: { exec: true },
    ...(options.executor ? { executor: options.executor } : {}),
  });
  const server = new HostServer({ host, port: 0 });
  const { port, addresses } = await server.listen();
  return { host, server, port, addresses };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'guhbot-e2e-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('discovery', () => {
  it('serves a health document a client can probe', async () => {
    const { server, port } = await boot();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body['name']).toBe('guhbot-host');
    expect(body['rpcPath']).toBe('/rpc');
    expect(typeof body['hostId']).toBe('string');
    await server.close();
  });

  it('404s anything else', async () => {
    const { server, port } = await boot();
    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(response.status).toBe(404);
    await server.close();
  });
});

describe('pairing over the wire', () => {
  it('lets an unauthenticated client claim a code and become a device', async () => {
    const { server, host } = await boot();
    const info = server.createPairing();

    const pairing = new GuhbotClient({ url: `ws://127.0.0.1:${info.port}/rpc`, autoReconnect: false });
    await pairing.connect();
    // Wait for the server's ready frame after anonymous auth.
    await waitFor(() => pairing.state === 'ready');

    const claimed = await pairing.request('pairing.claim', {
      pairingId: info.pairingId,
      code: info.code,
      deviceName: 'Test Phone',
      platform: 'ios',
      requestedClass: 'background',
    });

    expect(claimed.device.name).toBe('Test Phone');
    expect(claimed.device.class).toBe('background');
    expect(claimed.token.length).toBeGreaterThan(20);
    // The device is now durable on the host.
    expect(host.store.listDevices()).toHaveLength(1);

    await pairing.close();
    await server.close();
  });

  it('refuses a wrong code', async () => {
    const { server } = await boot();
    const info = server.createPairing();
    const pairing = new GuhbotClient({ url: `ws://127.0.0.1:${info.port}/rpc`, autoReconnect: false });
    await pairing.connect();
    await waitFor(() => pairing.state === 'ready');

    await expect(
      pairing.request('pairing.claim', {
        pairingId: info.pairingId,
        code: '00000000',
        deviceName: 'x',
        platform: 'ios',
        requestedClass: 'background',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await pairing.close();
    await server.close();
  });

  it('refuses every method except the allow list before authentication', async () => {
    const { server } = await boot();
    const info = server.createPairing();
    const pairing = new GuhbotClient({ url: `ws://127.0.0.1:${info.port}/rpc`, autoReconnect: false });
    await pairing.connect();
    await waitFor(() => pairing.state === 'ready');

    await expect(pairing.request('agents.list', {})).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(pairing.request('transcript.page', { agentId: 'ag_x', limit: 10 })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    // The allow-listed ones still work.
    const status = await pairing.request('host.status', {});
    expect(status.mode).toBe('self-hosted');

    await pairing.close();
    await server.close();
  });

  it('rejects a bogus device token', async () => {
    const { server } = await boot();
    const client = new GuhbotClient({
      url: `ws://127.0.0.1:${server['boundPort'] as number}/rpc`,
      token: 'not-a-real-token',
      autoReconnect: false,
    });
    let sawError = false;
    client.on('ready', () => {
      sawError = true;
    });
    await client.connect();
    // With a bad token the server never says ready, so requests stay refused.
    await new Promise((r) => setTimeout(r, 80));
    expect(sawError).toBe(false);
    await expect(client.request('agents.list', {})).rejects.toMatchObject({ code: 'cancelled' });
    await client.close();
    await server.close();
  });
});

describe('authenticated session', () => {
  it('downgrades a phone to background class and enforces it', async () => {
    const { server } = await boot();
    const info = server.createPairing();
    const phone = new GuhbotClient({ url: `ws://127.0.0.1:${info.port}/rpc`, autoReconnect: false });
    await phone.connect();
    await waitFor(() => phone.state === 'ready');

    const claimed = await phone.request('pairing.claim', {
      pairingId: info.pairingId,
      code: info.code,
      deviceName: 'iPhone',
      platform: 'ios',
      requestedClass: 'person',
    });
    expect(claimed.device.class).toBe('background');

    const authed = new GuhbotClient({ url: `ws://127.0.0.1:${info.port}/rpc`, token: claimed.token, autoReconnect: false });
    await authed.connect();
    await waitFor(() => authed.state === 'ready');
    expect(authed.deviceClass).toBe('background');

    // Observation is allowed …
    await expect(authed.request('agents.list', {})).resolves.toEqual({ agents: [] });
    // … mutation is not.
    await expect(authed.request('agents.create', { name: 'Sneaky' })).rejects.toMatchObject({ code: 'forbidden' });

    await phone.close();
    await authed.close();
    await server.close();
  });

  it('streams run lifecycle and transcript events to a paired client', async () => {
    const host = new Host({
      dataDir,
      version: '0.0.0-test',
      mode: 'self-hosted',
      capabilities: {},
      executor: new AgentLoop({ provider: new OneTurnProvider(), tools: [], cwd: dataDir }),
    });
    const server = new HostServer({ host, port: 0 });
    const { port } = await server.listen();

    const info = server.createPairing();
    const phone = new GuhbotClient({ url: `ws://127.0.0.1:${port}/rpc`, autoReconnect: false });
    await phone.connect();
    await waitFor(() => phone.state === 'ready');
    const claimed = await phone.request('pairing.claim', {
      pairingId: info.pairingId,
      code: info.code,
      deviceName: 'iPhone',
      platform: 'ios',
      requestedClass: 'background',
    });
    const authed = new GuhbotClient({ url: `ws://127.0.0.1:${port}/rpc`, token: claimed.token, autoReconnect: false });
    await authed.connect();
    await waitFor(() => authed.state === 'ready');

    const entries: Entry[] = [];
    const runStatuses: string[] = [];
    authed.on('transcript.appended', (payload) => entries.push((payload as { entry: Entry }).entry));
    authed.on('run.updated', (payload) => runStatuses.push((payload as { run: { status: string } }).run.status));

    // A local console session starts the run; the phone observes it. This is
    // exactly the self-hosted story: work starts on the machine, the phone watches.
    const local = host.createSession('local');
    const agent = host.store.createAgent({ name: 'Ops' });
    const { run } = (await host.dispatch(local, 'runs.start', { agentId: agent.id, prompt: 'go' })) as {
      run: { id: string };
    };

    await waitFor(() => runStatuses.includes('succeeded'));
    expect(runStatuses).toContain('running');
    // The prompt entry and the agent's reply both reached the phone.
    expect(entries.map((e) => e.content)).toContain('go');
    expect(entries.map((e) => e.content)).toContain('work done');

    // And the phone can read the same transcript back.
    const page = await authed.request('transcript.page', { agentId: agent.id, limit: 50 });
    expect(page.entries.map((e) => e.content)).toEqual(['go', 'work done']);
    expect(page.entries.map((e) => e.seq)).toEqual([0, 1]);

    void run;
    await phone.close();
    await authed.close();
    await server.close();
    await host.close();
  });

  it('resyncs a client that connects after the work happened', async () => {
    const host = new Host({
      dataDir,
      version: '0.0.0-test',
      mode: 'self-hosted',
      capabilities: {},
      executor: new AgentLoop({ provider: new OneTurnProvider(), tools: [], cwd: dataDir }),
    });
    const server = new HostServer({ host, port: 0 });
    const { port } = await server.listen();

    const local = host.createSession('local');
    const agent = host.store.createAgent({ name: 'Later' });
    await host.dispatch(local, 'runs.start', { agentId: agent.id, prompt: 'first' });
    await new Promise((r) => setTimeout(r, 120));

    // A phone that was never connected during the run still sees everything.
    const info = server.createPairing();
    const phone = new GuhbotClient({ url: `ws://127.0.0.1:${port}/rpc`, autoReconnect: false });
    await phone.connect();
    await waitFor(() => phone.state === 'ready');
    const claimed = await phone.request('pairing.claim', {
      pairingId: info.pairingId,
      code: info.code,
      deviceName: 'P',
      platform: 'android',
      requestedClass: 'background',
    });
    const authed = new GuhbotClient({ url: `ws://127.0.0.1:${port}/rpc`, token: claimed.token, autoReconnect: false });
    await authed.connect();
    await waitFor(() => authed.state === 'ready');

    const page = await authed.request('transcript.page', { agentId: agent.id, limit: 50 });
    expect(page.entries.map((e) => e.content)).toEqual(['first', 'work done']);

    await phone.close();
    await authed.close();
    await server.close();
    await host.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for condition');
}
