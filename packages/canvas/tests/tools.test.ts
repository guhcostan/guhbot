import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Capability, ToolDefinition, ToolExecutionContext } from '@guhbot/agent';
import { createCanvasCapability, parseCanvasUrl } from '../src/index.js';
import type { CanvasCapabilityOptions } from '../src/index.js';

/**
 * The tool surface, driven the way the agent loop drives it: `execute` with
 * unknown arguments, no renderer, no network.
 */

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'guhbot-canvas-tools-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const ALLOWED = ['api.example.com', '.cdn.example.com'];

function makeCapability(overrides: Partial<CanvasCapabilityOptions> = {}): Capability {
  return createCanvasCapability({ dataDir, allowedHosts: ALLOWED, ...overrides });
}

function context(): ToolExecutionContext {
  return { readSecret: () => null, cwd: dataDir, signal: new AbortController().signal, note: () => undefined };
}

function toolNamed(capability: Capability, name: string): ToolDefinition {
  const tool = (capability.tools?.() ?? []).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`the capability contributes no tool named ${name}`);
  return tool;
}

async function create(capability: Capability, html: string, extra: Record<string, unknown> = {}): Promise<
  { id: string; url: string; csp: string; bytes: number; title: string }
> {
  const raw = await toolNamed(capability, 'canvas_create').execute({ html, ...extra }, context());
  return JSON.parse(raw) as { id: string; url: string; csp: string; bytes: number; title: string };
}

describe('the tool set', () => {
  it('is exactly the six declared tools, each with an explicit approval flag', () => {
    const expected: Record<string, boolean> = {
      canvas_create: false,
      canvas_list: false,
      canvas_read: false,
      canvas_delete: false,
      artifact_write: false,
      artifact_list: false,
    };
    const tools = makeCapability().tools() ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(expected).sort());

    for (const tool of tools) {
      expect(Object.prototype.hasOwnProperty.call(tool, 'requiresApproval'), tool.name).toBe(true);
      expect(typeof tool.requiresApproval, tool.name).toBe('boolean');
      expect(tool.requiresApproval, tool.name).toBe(expected[tool.name]);
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
    }
    // The tools that write into the host's own data say so rather than inheriting
    // a default: writing an artifact cannot touch anything outside its jail, and
    // deleting a canvas removes a document this host produced.
    expect(toolNamed(makeCapability(), 'canvas_delete').requiresApproval).toBe(false);
    expect(toolNamed(makeCapability(), 'artifact_write').requiresApproval).toBe(false);
  });

  it('declares JSON schemas a provider can send as-is', () => {
    for (const tool of makeCapability().tools() ?? []) {
      expect(tool.parameters['type'], tool.name).toBe('object');
      expect(tool.parameters['properties'], tool.name).toBeTypeOf('object');
    }
  });
});

describe('canvas_create', () => {
  it('stores a document and returns an id and a locator', async () => {
    const capability = makeCapability();
    const created = await create(capability, '<h1>hello</h1>', { title: '  Hello   world  ' });

    expect(created.id).toMatch(/^[0-9a-f]{64}$/);
    expect(created.title).toBe('Hello world');
    expect(created.csp).toContain("default-src 'none'");
    expect(created.bytes).toBeGreaterThan('<h1>hello</h1>'.length);
    expect(parseCanvasUrl(created.url)).toEqual({ id: created.id, theme: 'light' });
  });

  it('gives identical HTML the same id', async () => {
    const capability = makeCapability();
    const first = await create(capability, '<p>same</p>');
    const second = await create(capability, '<p>same</p>');
    expect(second.id).toBe(first.id);
    const listed = JSON.parse(await toolNamed(capability, 'canvas_list').execute({}, context())) as { canvases: unknown[] };
    expect(listed.canvases).toHaveLength(1);
  });

  it('defaults the title when none is given', async () => {
    const capability = makeCapability();
    expect((await create(capability, '<p>x</p>')).title).toBe('Untitled canvas');
    expect((await create(capability, '<p>y</p>', { title: '   ' })).title).toBe('Untitled canvas');
  });

  it('narrows connect-src to a declared host that the egress allow list already permits', async () => {
    const capability = makeCapability();
    const created = await create(capability, '<p>chart</p>', {
      csp: { connectHosts: ['https://api.example.com'], imageHosts: ['https://cdn.cdn.example.com'] },
    });
    expect(created.csp).toContain('connect-src https://api.example.com');
    expect(created.csp).toContain('https://cdn.cdn.example.com');
  });

  it('refuses a declared host outside the host egress allow list, and stores nothing', async () => {
    const capability = makeCapability();
    await expect(create(capability, '<p>x</p>', { csp: { connectHosts: ['https://evil.example'] } })).rejects.toThrow(
      /not in this host's egress allow list/,
    );
    const listed = JSON.parse(await toolNamed(capability, 'canvas_list').execute({}, context())) as { canvases: unknown[] };
    expect(listed.canvases).toEqual([]);
  });

  it('refuses a declared remote script', async () => {
    const capability = makeCapability();
    await expect(create(capability, '<p>x</p>', { csp: { scriptHosts: ['https://cdn.example.com'] } })).rejects.toThrow(
      /remote script/,
    );
  });

  it('has no egress at all when the host configured none', async () => {
    const capability = createCanvasCapability({ dataDir });
    const created = await create(capability, '<p>x</p>');
    expect(created.csp).toContain("connect-src 'none'");
    await expect(create(capability, '<p>x</p>', { csp: { connectHosts: ['https://api.example.com'] } })).rejects.toThrow(
      /egress allow list/,
    );
  });

  it('refuses an over-size document with a clear message', async () => {
    const capability = makeCapability({ maxDocumentBytes: 512 });
    await expect(create(capability, `<p>${'x'.repeat(4096)}</p>`)).rejects.toThrow(/over this host's 512 B limit/);
    await expect(create(capability, `<p>${'x'.repeat(4096)}</p>`)).rejects.toThrow(/nothing was truncated/);
  });

  it('refuses arguments it does not understand instead of ignoring them', async () => {
    const capability = makeCapability();
    await expect(toolNamed(capability, 'canvas_create').execute({ html: '<p>x</p>', remote: true }, context())).rejects.toThrow(
      /invalid arguments/,
    );
    await expect(toolNamed(capability, 'canvas_create').execute({}, context())).rejects.toThrow(/invalid arguments/);
  });
});

describe('canvas_read, canvas_list and canvas_delete', () => {
  it('returns the exact bytes a renderer receives', async () => {
    const capability = makeCapability();
    const created = await create(capability, '<h1>hello</h1>');
    const html = await toolNamed(capability, 'canvas_read').execute({ id: created.id }, context());

    expect(html.startsWith('<!DOCTYPE html><!--guhbot-canvas:csp-->')).toBe(true);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<h1>hello</h1>');
    // Reading the served bytes back and creating again is stable.
    expect((await create(capability, html)).id).toBe(created.id);
  });

  it('reports a missing canvas rather than returning empty HTML', async () => {
    const capability = makeCapability();
    await expect(toolNamed(capability, 'canvas_read').execute({ id: '0'.repeat(64) }, context())).rejects.toThrow(/no canvas/);
    await expect(toolNamed(capability, 'canvas_delete').execute({ id: '0'.repeat(64) }, context())).rejects.toThrow(/no canvas/);
    await expect(toolNamed(capability, 'canvas_read').execute({ id: '../../etc/passwd' }, context())).rejects.toThrow(/canvas id/);
  });

  it('lists newest first and then deletes', async () => {
    let clock = 1_700_000_000_000;
    const capability = makeCapability({ now: () => (clock += 1000) });
    const first = await create(capability, '<p>one</p>', { title: 'one' });
    const second = await create(capability, '<p>two</p>', { title: 'two' });

    const listed = JSON.parse(await toolNamed(capability, 'canvas_list').execute({}, context())) as {
      canvases: { id: string; title: string; url: string }[];
    };
    expect(listed.canvases.map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(listed.canvases[0]?.url).toContain(second.id);

    const deleted = JSON.parse(await toolNamed(capability, 'canvas_delete').execute({ id: first.id }, context())) as {
      deleted: boolean;
    };
    expect(deleted).toEqual({ deleted: true, id: first.id });
    const after = JSON.parse(await toolNamed(capability, 'canvas_list').execute({}, context())) as { canvases: unknown[] };
    expect(after.canvases).toHaveLength(1);
  });
});

describe('artifact tools', () => {
  it('writes a file into the artifact directory and lists it', async () => {
    const capability = makeCapability();
    const written = JSON.parse(
      await toolNamed(capability, 'artifact_write').execute({ path: 'reports/q3.md', content: '# q3' }, context()),
    ) as { path: string; bytes: number; modifiedAt: string };

    expect(written.path).toBe('reports/q3.md');
    expect(written.bytes).toBe(4);
    expect(Number.isNaN(Date.parse(written.modifiedAt))).toBe(false);
    expect(await readFile(join(dataDir, 'artifacts', 'reports', 'q3.md'), 'utf8')).toBe('# q3');

    const listed = JSON.parse(await toolNamed(capability, 'artifact_list').execute({}, context())) as {
      artifacts: { path: string; bytes: number }[];
    };
    expect(listed.artifacts.map((entry) => entry.path)).toEqual(['reports/q3.md']);
  });

  it('refuses a path outside the jail', async () => {
    const capability = makeCapability();
    await expect(
      toolNamed(capability, 'artifact_write').execute({ path: '../../escape.txt', content: 'x' }, context()),
    ).rejects.toThrow(/outside the artifact directory/);
    await expect(access(join(dataDir, 'escape.txt'))).rejects.toThrow();
  });

  it('refuses to clobber an existing artifact without overwrite', async () => {
    const capability = makeCapability();
    const tool = toolNamed(capability, 'artifact_write');
    await tool.execute({ path: 'a.txt', content: 'first' }, context());
    await expect(tool.execute({ path: 'a.txt', content: 'second' }, context())).rejects.toThrow(/overwrite: true/);
    await tool.execute({ path: 'a.txt', content: 'second', overwrite: true }, context());
    expect(await readFile(join(dataDir, 'artifacts', 'a.txt'), 'utf8')).toBe('second');
  });

  it('decodes base64 and refuses content that is not base64', async () => {
    const capability = makeCapability();
    const tool = toolNamed(capability, 'artifact_write');
    await tool.execute({ path: 'pixel.bin', content: Buffer.from('PNG').toString('base64'), encoding: 'base64' }, context());
    expect(await readFile(join(dataDir, 'artifacts', 'pixel.bin'), 'utf8')).toBe('PNG');

    await expect(tool.execute({ path: 'bad.bin', content: 'not base64!!', encoding: 'base64' }, context())).rejects.toThrow(
      /not valid base64/,
    );
  });

  it('keeps canvases and artifacts in separate stores', async () => {
    const capability = makeCapability();
    await create(capability, '<p>x</p>');

    const before = JSON.parse(await toolNamed(capability, 'artifact_list').execute({}, context())) as { artifacts: unknown[] };
    expect(before.artifacts).toEqual([]);

    await toolNamed(capability, 'artifact_write').execute({ path: 'data.csv', content: 'a,b\n' }, context());
    const canvases = JSON.parse(await toolNamed(capability, 'canvas_list').execute({}, context())) as { canvases: unknown[] };
    expect(canvases.canvases).toHaveLength(1);
    await expect(access(join(dataDir, 'artifacts', 'data.csv'))).resolves.toBeUndefined();
  });
});

describe('after dispose', () => {
  it('refuses every canvas tool, and disposing twice is not an error', async () => {
    const capability = makeCapability();
    const created = await create(capability, '<p>x</p>');

    await capability.dispose?.();
    await expect(capability.dispose?.()).resolves.toBeUndefined();

    await expect(toolNamed(capability, 'canvas_list').execute({}, context())).rejects.toThrow(/released/);
    await expect(toolNamed(capability, 'canvas_read').execute({ id: created.id }, context())).rejects.toThrow(/released/);
  });
});
