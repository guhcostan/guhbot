import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Capability, ToolExecutionContext } from '@guhbot/agent';
import { assertCapability } from '@guhbot/agent';
import { Host } from '@guhbot/host-core';
import { createCanvasCapability } from '../src/index.js';

/**
 * The client-facing contract, proved against a real `Host`.
 *
 * Schemas and authorization classes are asserted directly, and then the same
 * methods are dispatched through `Host.dispatch`, which is the only thing that
 * actually enforces an `authz` class. A test that only read the spec would prove
 * nothing about a background device being refused.
 */

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'guhbot-canvas-methods-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function context(): ToolExecutionContext {
  return { readSecret: () => null, cwd: dataDir, signal: new AbortController().signal, note: () => undefined };
}

async function seedCanvas(capability: Capability, html = '<h1>report</h1>'): Promise<string> {
  const tool = (capability.tools?.() ?? []).find((candidate) => candidate.name === 'canvas_create');
  if (tool === undefined) throw new Error('no canvas_create tool');
  const raw = await tool.execute({ html, title: 'Report' }, context());
  return (JSON.parse(raw) as { id: string }).id;
}

function makeHost(capability: Capability): Host {
  return new Host({
    dataDir,
    version: '0.0.0-test',
    mode: 'self-hosted',
    capabilities: { canvas: true },
    extraMethods: capability.methods ?? {},
  });
}

describe('the capability contract', () => {
  it('passes the runtime validator', () => {
    const capability = createCanvasCapability({ dataDir });
    expect(() => assertCapability(capability)).not.toThrow();
    expect(capability.name).toBe('canvas');
    expect(capability.flags).toEqual({ canvas: true });
    expect(capability.summary.length).toBeGreaterThan(30);
  });

  it('contributes exactly the three namespaced methods with honest authz classes', () => {
    const methods = createCanvasCapability({ dataDir }).methods ?? {};
    expect(Object.keys(methods).sort()).toEqual(['canvas.delete', 'canvas.get', 'canvas.list']);

    expect(methods['canvas.list']?.authz).toBe('background');
    expect(methods['canvas.get']?.authz).toBe('background');
    expect(methods['canvas.delete']?.authz).toBe('person');

    for (const [name, spec] of Object.entries(methods)) {
      expect(name.includes('.'), name).toBe(true);
      expect(spec.summary.length, name).toBeGreaterThan(10);
      expect(spec.input, name).toBeDefined();
      expect(spec.output, name).toBeDefined();
    }
    // Every method declares an output schema, and `dispatch` enforces it.
    expect(methods['canvas.get']?.output.safeParse({ id: 'x' }).success).toBe(false);
  });

  it('validates its inputs and outputs', () => {
    const methods = createCanvasCapability({ dataDir }).methods ?? {};
    const list = methods['canvas.list'];
    const get = methods['canvas.get'];
    const remove = methods['canvas.delete'];
    if (list === undefined || get === undefined || remove === undefined) throw new Error('methods missing');

    expect(list.input.safeParse({}).success).toBe(true);
    expect(list.input.safeParse({ limit: 5 }).success).toBe(true);
    expect(list.input.safeParse({ limit: 0 }).success).toBe(false);
    expect(list.input.safeParse({ limit: 500 }).success).toBe(false);
    expect(list.output.safeParse({ canvases: [] }).success).toBe(true);
    expect(list.output.safeParse({ canvases: [{ id: 'nope' }] }).success).toBe(false);

    expect(get.input.parse({ id: 'abc' })).toEqual({ id: 'abc', theme: 'light' });
    expect(get.input.parse({ id: 'abc', theme: 'dark' })).toEqual({ id: 'abc', theme: 'dark' });
    expect(get.input.safeParse({ id: 'abc', theme: 'blue' }).success).toBe(false);
    expect(get.input.safeParse({}).success).toBe(false);
    const doc = { id: 'a'.repeat(64), title: 't', bytes: 12, createdAt: 'when', url: 'where', html: '<p>x</p>', csp: 'p' };
    expect(get.output.safeParse(doc).success).toBe(true);
    expect(get.output.safeParse({ ...doc, html: undefined }).success).toBe(false);

    expect(remove.input.safeParse({ id: 'a' }).success).toBe(true);
    expect(remove.output.safeParse({ deleted: true, id: 'a' }).success).toBe(true);
    expect(remove.output.safeParse({ deleted: 'yes', id: 'a' }).success).toBe(false);
  });

  it('is idempotent when disposed, and refuses to serve afterwards', async () => {
    const capability = createCanvasCapability({ dataDir });
    await expect(capability.dispose?.()).resolves.toBeUndefined();
    await expect(capability.dispose?.()).resolves.toBeUndefined();

    const host = makeHost(capability);
    await expect(host.dispatch(host.createSession('local'), 'canvas.list', {})).rejects.toMatchObject({ code: 'internal' });
    await host.close();
  });
});

describe('authorization through a real Host', () => {
  it('lets a background device list and fetch, but not delete; a local session may', async () => {
    const capability = createCanvasCapability({ dataDir });
    const id = await seedCanvas(capability);
    const host = makeHost(capability);

    // A phone that redeemed a pairing code: background class, no human presence.
    const { pairingId, code } = host.beginPairing();
    const { device } = host.claimPairing({
      pairingId,
      code,
      deviceName: 'iPhone',
      platform: 'ios',
      requestedClass: 'background',
    });
    const phone = host.createSession('network', device);

    const listed = await host.dispatch(phone, 'canvas.list', {});
    expect(listed).toMatchObject({ canvases: [{ id, title: 'Report', url: expect.stringContaining(id) }] });

    const fetched = await host.dispatch(phone, 'canvas.get', { id, theme: 'dark' });
    expect(fetched).toMatchObject({ id, csp: expect.stringContaining("default-src 'none'") });
    expect((fetched as { html: string }).html).toContain('<h1>report</h1>');
    expect((fetched as { url: string }).url).toBe(`guhbot-canvas://frame/${id}?theme=dark`);

    await expect(host.dispatch(phone, 'canvas.delete', { id })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(host.dispatch(host.createSession('network'), 'canvas.delete', { id })).rejects.toMatchObject({
      code: 'forbidden',
    });

    const local = host.createSession('local');
    await expect(host.dispatch(local, 'canvas.delete', { id })).resolves.toEqual({ deleted: true, id });
    // Deleting something that is already gone is reported, not failed.
    await expect(host.dispatch(local, 'canvas.delete', { id })).resolves.toEqual({ deleted: false, id });

    await host.close();
  });

  it('maps store refusals onto protocol codes', async () => {
    const capability = createCanvasCapability({ dataDir });
    const host = makeHost(capability);
    const local = host.createSession('local');

    await expect(host.dispatch(local, 'canvas.get', { id: '0'.repeat(64) })).rejects.toMatchObject({ code: 'not-found' });
    await expect(host.dispatch(local, 'canvas.get', { id: '../../etc/passwd' })).rejects.toMatchObject({
      code: 'bad-request',
    });
    await expect(host.dispatch(local, 'canvas.list', { limit: 0 })).rejects.toMatchObject({ code: 'bad-request' });

    await host.close();
  });

  it('advertises the contributed methods through host.describe', async () => {
    const capability = createCanvasCapability({ dataDir });
    const host = makeHost(capability);
    const described = host.describeMethods().filter((method) => method.name.startsWith('canvas.'));
    expect(described.map((method) => [method.name, method.authz])).toEqual([
      ['canvas.delete', 'person'],
      ['canvas.get', 'background'],
      ['canvas.list', 'background'],
    ]);
    await host.close();
  });
});
