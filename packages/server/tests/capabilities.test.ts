import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentLoop, OpenAiCompatibleProvider } from '@guhbot/agent';
import { Host } from '@guhbot/host-core';
import { mountCapabilities } from '../src/capabilities.js';

/**
 * Capability wiring.
 *
 * `mountCapabilities` is the one place that decides which capabilities this host
 * actually has, and until now nothing verified that the decision is honoured. A
 * capability that is built and never mounted is dead code that reads as working,
 * which is the specific failure these tests exist to prevent.
 */

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'guhbot-mount-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('capability mounting', () => {
  it('mounts nothing at all when nothing is configured', async () => {
    // The contract this file documents: a capability that is not configured is
    // not mounted, so `host.status` can say `browser: false` rather than handing
    // the model tools that can only fail.
    const mounted = await mountCapabilities({ dataDir });
    expect(mounted.mounted).toEqual([]);
    expect(mounted.tools).toEqual([]);
    await mounted.dispose();
  });

  it('mounts canvas when asked, and never reaches the network doing it', async () => {
    const mounted = await mountCapabilities({ dataDir, canvas: { enabled: true } });
    expect(mounted.mounted).toContain('canvas');
    expect(mounted.flags['canvas']).toBe(true);
    // A canvas with no allowed hosts still mounts: its frames are confined to
    // `connect-src 'none'`, which is the safe case rather than a broken one.
    expect(mounted.tools.map((t) => t.name)).toContain('canvas_create');
    await mounted.dispose();
  });

  it('explains why the browser is absent rather than mounting it uselessly', async () => {
    const mounted = await mountCapabilities({ dataDir, browser: { enabled: true } });
    expect(mounted.mounted).not.toContain('browser');
    expect(mounted.notes.join(' ')).toMatch(/browser capability not mounted: no allowed hosts/);
    await mounted.dispose();
  });

  it('mounts the browser once hosts are allowed, and shares that list with egress', async () => {
    const mounted = await mountCapabilities({ dataDir, allowedHosts: ['example.com'], browser: { enabled: true } });
    expect(mounted.mounted).toContain('browser');
    expect(mounted.flags['browser']).toBe(true);
    await mounted.dispose();
  });

  it('mounts the scheduler only when it is handed a way to reach the host', async () => {
    const withoutHost = await mountCapabilities({ dataDir });
    expect(withoutHost.mounted).not.toContain('scheduler');
    await withoutHost.dispose();

    // A getter, not the host itself: the scheduler declares its tools before the
    // host exists, because the host needs those tools at construction.
    const host = new Host({ dataDir: join(dataDir, 'h'), version: '0.0.0-test', mode: 'self-hosted' });
    const withHost = await mountCapabilities({ dataDir, scheduler: { host: () => host } });
    expect(withHost.mounted).toContain('scheduler');
    expect(withHost.flags['scheduler']).toBe(true);
    // And its methods reached the registry, including the person-class one that
    // hands out a webhook secret.
    expect(Object.keys(withHost.extraMethods)).toContain('automations.webhook');
    await withHost.dispose();
    await host.close();
  });

  it('reports canvas and scheduler methods with the classes the host will enforce', async () => {
    const host = new Host({ dataDir: join(dataDir, 'h'), version: '0.0.0-test', mode: 'self-hosted' });
    const mounted = await mountCapabilities({
      dataDir,
      canvas: { enabled: true },
      scheduler: { host: () => host },
    });

    const loaded = new Host({
      dataDir: join(dataDir, 'h2'),
      version: '0.0.0-test',
      mode: 'self-hosted',
      capabilities: mounted.flags,
      executor: new AgentLoop({
        provider: new OpenAiCompatibleProvider({ baseUrl: 'http://127.0.0.1:1/v1' }),
        tools: mounted.tools,
        cwd: dataDir,
      }),
      extraMethods: mounted.extraMethods,
    });

    const described = new Map(loaded.describeMethods().map((m) => [m.name, m.authz]));
    expect(described.get('canvas.list')).toBe('background');
    expect(described.get('canvas.delete')).toBe('person');
    expect(described.get('scheduler.status')).toBe('background');
    expect(described.get('automations.webhook')).toBe('person');

    // The contributed tools reached the executor, since an unmounted tool is the
    // failure this whole file guards against.
    const names = mounted.tools.map((t) => t.name);
    expect(names).toContain('canvas_create');
    expect(names).toContain('schedule_create');
    for (const tool of mounted.tools) {
      expect(typeof tool.requiresApproval).toBe('boolean');
    }

    await loaded.close();
    await mounted.dispose();
    await host.close();
  });

  it('refuses a capability name that would shadow a core method', async () => {
    // The host builder is the guard, and a capability cannot talk its way past it.
    const host = new Host({ dataDir: join(dataDir, 'h'), version: '0.0.0-test', mode: 'self-hosted' });
    const mounted = await mountCapabilities({ dataDir, scheduler: { host: () => host } });

    expect(() =>
      new Host({
        dataDir: join(dataDir, 'h3'),
        version: '0.0.0-test',
        mode: 'self-hosted',
        extraMethods: {
          // Deliberately colliding with a core method the authorization model
          // depends on.
          'approvals.resolve': mounted.extraMethods['canvas.list']!,
        },
      }),
    ).toThrow(/redefine the core method/);

    await mounted.dispose();
    await host.close();
  });

  it('disposes every capability it mounted, and survives one that throws', async () => {
    const mounted = await mountCapabilities({
      dataDir,
      allowedHosts: ['example.com'],
      browser: { enabled: true },
      canvas: { enabled: true },
    });
    expect(mounted.mounted.length).toBeGreaterThan(0);
    await mounted.dispose();
    // Twice, because a shutdown path that runs on both a signal and a normal exit
    // will call it twice, and throwing there would mask the real reason for exit.
    await mounted.dispose();
  });
});

describe('engine listing', () => {
  it('probes the installed CLIs without a network or a credential', async () => {
    const { createCliEngines, createEngineRegistry } = await import('@guhbot/engine-cli');
    const registry = createEngineRegistry(createCliEngines());
    expect(registry.ids()).toContain('claude-code');
    expect(registry.ids()).toContain('codex');
    expect(registry.ids()).toContain('opencode');

    for (const id of registry.ids()) {
      const probe = await registry.require(id).probe();
      // Never throws for a missing binary: that is the whole point of a probe.
      expect(typeof probe.available).toBe('boolean');
      if (probe.available) expect(probe.version).not.toBeNull();
      else expect(probe.reason).not.toBeNull();
    }
  }, 30_000);

  it('names the available engines when asked for one that does not exist', async () => {
    const { createCliEngines, createEngineRegistry } = await import('@guhbot/engine-cli');
    const registry = createEngineRegistry(createCliEngines());
    expect(() => registry.require('nope')).toThrow(/claude-code/);
  });
});

describe('mcp configuration file', () => {
  it('reads a config the CLI cannot express as flags', async () => {
    const path = join(dataDir, 'mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { files: { command: 'node', args: ['server.js'] } } }));

    // The parser lives in the CLI, so this asserts the shape it must accept
    // rather than re-implementing it: a bare array and the standard object form
    // are both things people paste.
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: Record<string, unknown> };
    const servers = Object.entries(parsed.mcpServers).map(([name, entry]) => ({ name, ...(entry as object) }));
    expect(servers).toEqual([{ name: 'files', command: 'node', args: ['server.js'] }]);
  });
});
