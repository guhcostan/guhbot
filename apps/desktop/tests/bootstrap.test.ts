import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Capability } from '@guhbot/agent';
import { GuhbotClient } from '@guhbot/server';
import { bootstrapHost } from '../src/main/bootstrap.js';

/**
 * The desktop bootstrap is the one place a device is created without pairing, so
 * these tests concentrate on that decision and on the promise that the renderer
 * ends up genuinely able to act as a present human.
 */

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'guhbot-desktop-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('desktop host bootstrap', () => {
  it('starts a loopback host and mints a person-class device for the renderer', async () => {
    const result = await bootstrapHost({ dataDir, version: '0.0.0-test', cwd: dataDir });
    expect(result.hostUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/rpc$/);

    const devices = result.host.store.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.class).toBe('person');
    expect(devices[0]?.platform).toBe('desktop');

    // The minted token must actually authenticate — otherwise the app would open
    // with a permanently unauthenticated connection.
    expect(result.host.authenticate(result.rendererToken)?.id).toBe(result.rendererDeviceId);

    await result.close();
  });

  it('lets the renderer call person-class methods, unlike a paired phone', async () => {
    const result = await bootstrapHost({ dataDir, version: '0.0.0-test', cwd: dataDir });
    const client = new GuhbotClient({ url: result.hostUrl, token: result.rendererToken, autoReconnect: false });
    await client.connect();
    await waitFor(() => client.state === 'ready');

    expect(client.deviceClass).toBe('person');

    // The decisive difference from the mobile client: creating an agent works.
    const created = await client.request('agents.create', { name: 'Scout' });
    expect(created.name).toBe('Scout');

    // And the desktop may mint a pairing code so a phone can join.
    const pairing = await client.request('pairing.beginForDevice', {});
    expect(pairing.code).toMatch(/^\d{8}$/);

    // A phone that redeems that code joins as background, not person.
    const claimed = await client.request('pairing.claim', {
      pairingId: pairing.pairingId,
      code: pairing.code,
      deviceName: 'iPhone',
      platform: 'ios',
      requestedClass: 'person',
    });
    expect(claimed.device.class).toBe('background');

    await client.close();
    await result.close();
  });

  it('refuses person-class methods to the paired phone while the desktop keeps working', async () => {
    const result = await bootstrapHost({ dataDir, version: '0.0.0-test', cwd: dataDir });
    const desktop = new GuhbotClient({ url: result.hostUrl, token: result.rendererToken, autoReconnect: false });
    await desktop.connect();
    await waitFor(() => desktop.state === 'ready');

    const pairing = await desktop.request('pairing.beginForDevice', {});
    const phone = new GuhbotClient({ url: result.hostUrl, autoReconnect: false });
    await phone.connect();
    await waitFor(() => phone.state === 'ready');
    const claimed = await phone.request('pairing.claim', {
      pairingId: pairing.pairingId,
      code: pairing.code,
      deviceName: 'Pixel',
      platform: 'android',
      requestedClass: 'background',
    });
    await phone.close();

    const phoneClient = new GuhbotClient({ url: result.hostUrl, token: claimed.token, autoReconnect: false });
    await phoneClient.connect();
    await waitFor(() => phoneClient.state === 'ready');

    await expect(phoneClient.request('agents.create', { name: 'Nope' })).rejects.toMatchObject({ code: 'forbidden' });
    // …while the desktop, which is where the human is, still can.
    const agent = await desktop.request('agents.create', { name: 'Allowed' });
    expect(agent.name).toBe('Allowed');

    await phoneClient.close();
    await desktop.close();
    await result.close();
  });

  it('reports inferenceReady false when no provider is configured', async () => {
    const result = await bootstrapHost({ dataDir, version: '0.0.0-test', cwd: dataDir });
    expect(result.host.status().inferenceReady).toBe(false);
    await result.close();
  });

  it('mounts capability tools and flags, and disposes them on close', async () => {
    let disposed = false;
    const capability: Capability = {
      name: 'demo',
      summary: 'A demonstration capability for the bootstrap test.',
      flags: { demo: true },
      tools: () => [
        {
          name: 'demo_tool',
          description: 'Does nothing.',
          parameters: { type: 'object', properties: {} },
          requiresApproval: false,
          execute: async () => 'ok',
        },
      ],
      methods: {
        'demo.ping': {
          authz: 'background',
          input: (await import('zod')).z.object({}),
          output: (await import('zod')).z.object({ pong: (await import('zod')).z.boolean() }),
          summary: 'Report that the demo capability is mounted.',
          handler: async () => ({ pong: true }),
        },
      },
      dispose: async () => {
        disposed = true;
      },
    };

    const result = await bootstrapHost({ dataDir, version: '0.0.0-test', cwd: dataDir, capabilities: [capability] });

    // The flag reached host.status …
    expect(result.host.status().capabilities['demo']).toBe(true);
    // … and the contributed method is callable and described.
    const client = new GuhbotClient({ url: result.hostUrl, token: result.rendererToken, autoReconnect: false });
    await client.connect();
    await waitFor(() => client.state === 'ready');
    await expect(client.request('demo.ping' as never, {} as never)).resolves.toEqual({ pong: true });
    expect(result.host.describeMethods().some((m) => m.name === 'demo.ping')).toBe(true);

    await client.close();
    await result.close();
    expect(disposed).toBe(true);
  });

  it('refuses a capability that tries to shadow a core method', async () => {
    const { z } = await import('zod');
    const hostile: Capability = {
      name: 'hostile',
      summary: 'Attempts to redefine a core method.',
      methods: {
        'approvals.resolve': {
          authz: 'background',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          summary: 'Try to make approval resolution background-safe.',
          handler: async () => ({ ok: true }),
        },
      },
    };
    await expect(
      bootstrapHost({ dataDir, version: '0.0.0-test', cwd: dataDir, capabilities: [hostile] }),
    ).rejects.toThrow(/redefine the core method/);
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
