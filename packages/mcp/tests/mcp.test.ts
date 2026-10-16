import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCapability, collectContributions, type ToolDefinition, type ToolExecutionContext } from '@guhbot/agent';
import { Host } from '@guhbot/host-core';
import {
  McpManager,
  createMcpCapability,
  createSseParser,
  isSecretLikeEnvName,
  parseJsonRpcMessage,
  parseToolEntry,
  flattenContentBlocks,
  type McpCapability,
  type McpCapabilityOptions,
  type McpServerConfig,
} from '../src/index.js';

/**
 * These tests drive the real transports. The stdio tests spawn the fixture in
 * `tests/fixtures/fake-stdio-server.mjs`; the HTTP tests bind a loopback server
 * on an ephemeral port. Nothing here reaches the network.
 *
 * The properties that matter most are the security ones: the stdio opt-in, the
 * child environment, name namespacing, and that a child process dies with the
 * capability.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-stdio-server.mjs', import.meta.url));

const tempDirs: string[] = [];
const capabilities: McpCapability[] = [];
const hosts: Host[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const capability of capabilities.splice(0)) await capability.dispose();
  for (const host of hosts.splice(0)) await host.close();
  for (const server of servers.splice(0)) await closeServer(server);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guhbot-mcp-'));
  tempDirs.push(dir);
  return dir;
}

function stdioServer(name: string, options: { args?: string[]; env?: Record<string, string> } = {}): McpServerConfig {
  return {
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE, ...(options.args ?? [])],
    ...(options.env === undefined ? {} : { env: options.env }),
  };
}

async function mount(options: McpCapabilityOptions): Promise<McpCapability> {
  const capability = createMcpCapability(options);
  capabilities.push(capability);
  await capability.ready();
  return capability;
}

function toolContext(): ToolExecutionContext {
  return { readSecret: () => null, cwd: process.cwd(), signal: new AbortController().signal, note: () => undefined };
}

function toolNamed(capability: McpCapability, name: string): ToolDefinition {
  const tool = capability.tools().find((candidate) => candidate.name === name);
  if (!tool) {
    const available = capability.tools().map((candidate) => candidate.name).join(', ');
    throw new Error(`no tool ${name}; available: ${available}`);
  }
  return tool;
}

function toolNames(capability: McpCapability): string[] {
  return capability.tools().map((tool) => tool.name).sort();
}

async function call(capability: McpCapability, name: string, args: unknown = {}): Promise<string> {
  return toolNamed(capability, name).execute(args, toolContext());
}

interface Diagnostics {
  inboundResponses: unknown[];
  clientNotifications: string[];
  calls: string[];
  cursors: (string | null)[];
}

async function diagnostics(capability: McpCapability, server: string): Promise<Diagnostics> {
  return JSON.parse(await call(capability, `${server}__diagnostics`)) as Diagnostics;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Assert a pid is really gone, allowing for the OS reaping it asynchronously. */
async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(20);
  }
  throw new Error(`process ${pid} is still alive`);
}

describe('stdio transport', () => {
  it('completes the handshake, paginates tools/list and routes calls by the original name', async () => {
    const capability = await mount({ allowStdio: true, servers: [stdioServer('files')] });

    expect(toolNames(capability)).toEqual([
      'files__add',
      'files__boom',
      'files__diagnostics',
      'files__die',
      'files__echo',
      'files__env_names',
      'files__hang',
      'files__pid',
      'files__rich',
      'files__slow',
      'files__weird_name_v2',
    ]);

    // The fixture only knows `echo`; reaching it proves the mapping from the
    // exposed name back to the server's own name.
    expect(await call(capability, 'files__echo', { text: 'hello' })).toBe('hello');
    expect(await call(capability, 'files__add', { a: 20, b: 22 })).toBe('42');
    // `weird/name.v2` is not a valid identifier, so it is exposed sanitized and
    // must still reach the original tool.
    expect(await call(capability, 'files__weird_name_v2')).toBe('weird-ok');

    const observed = await diagnostics(capability, 'files');
    expect(observed.cursors).toEqual([null, 'page-2']);
    expect(observed.clientNotifications).toContain('notifications/initialized');
  });

  it('never answers or awaits a notification', async () => {
    const capability = await mount({ allowStdio: true, servers: [stdioServer('files')] });

    // `slow` emits a notification and answers 60ms later: a client that awaited
    // the notification would hang here (and the inbound response counter in the
    // fixture would record a reply).
    expect(await call(capability, 'files__slow')).toBe('slow-ok');

    const observed = await diagnostics(capability, 'files');
    expect(observed.inboundResponses).toEqual([]);
  });

  it('skips malformed tools/list entries instead of throwing', async () => {
    const capability = await mount({
      allowStdio: true,
      servers: [stdioServer('broken', { args: ['--mode=malformed'] }), stdioServer('notarray', { args: ['--mode=not-array'] })],
    });

    expect(toolNames(capability)).toEqual([]);
    // The handshake worked, so the server is reachable; only discovery failed.
    expect(capability.states().map((state) => state.status)).toEqual(['connected', 'connected']);
    expect(capability.states().every((state) => state.toolCount === 0)).toBe(true);
  });

  it('reports a clear error when the server dies mid-call', async () => {
    const capability = await mount({ allowStdio: true, servers: [stdioServer('dying')] });

    await expect(call(capability, 'dying__die')).rejects.toThrow(/dying.*exited with code 0/s);
    expect(capability.states()[0]?.status).toBe('error');
  });

  it('times out a request that is never answered', async () => {
    const capability = await mount({ allowStdio: true, requestTimeoutMs: 250, servers: [stdioServer('files')] });

    await expect(call(capability, 'files__hang')).rejects.toThrow(/timed out answering tools\/call/);
  });

  it('flattens content blocks without inlining binary payloads', async () => {
    const capability = await mount({ allowStdio: true, servers: [stdioServer('files')] });

    const output = await call(capability, 'files__rich');
    expect(output).toContain('caption');
    expect(output).toContain('inline note');
    expect(output).toContain('[image: image/png, ~15000 bytes omitted]');
    expect(output).toContain('[resource: file:///tmp/blob.bin');
    expect(output).toContain('[unsupported content block: surprise]');
    expect(output).not.toContain('AAAAAAAAAA');
    expect(output.length).toBeLessThan(11_000);
  });

  it('surfaces isError results as failed tool calls', async () => {
    const capability = await mount({ allowStdio: true, servers: [stdioServer('files')] });

    expect(await call(capability, 'files__boom')).toBe('Error: MCP tool "files__boom" failed: kaboom');
  });

  it('terminates the child process on dispose, escalating to SIGKILL', async () => {
    const capability = await mount({
      allowStdio: true,
      killGraceMs: 150,
      servers: [stdioServer('lifetime'), stdioServer('stubborn', { args: ['--ignore-sigterm'] })],
    });

    const pidOf = async (server: string): Promise<number> => Number(await call(capability, `${server}__pid`));
    const lifetimePid = await pidOf('lifetime');
    const stubbornPid = await pidOf('stubborn');
    expect(process.kill(lifetimePid, 0)).toBe(true);
    expect(process.kill(stubbornPid, 0)).toBe(true);

    await capability.dispose();

    await expectProcessGone(lifetimePid);
    await expectProcessGone(stubbornPid);
  });

  // The strongest form of the leak guarantee: the host that spawned the server
  // exits without ever disposing, and the server must still die. Needs the
  // built package, because the child host imports it from `dist`.
  const distEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  it.skipIf(!existsSync(distEntry))('kills a leaked child when the host process exits without disposing', async () => {
    const script = join(tempDir(), 'leaking-host.mjs');
    writeFileSync(
      script,
      [
        "import { pathToFileURL } from 'node:url';",
        'const [fixture, distEntry] = process.argv.slice(2);',
        'const { createMcpCapability } = await import(pathToFileURL(distEntry).href);',
        'const capability = createMcpCapability({',
        '  allowStdio: true,',
        "  servers: [{ name: 'leak', transport: 'stdio', command: process.execPath, args: [fixture, '--ignore-sigterm'] }],",
        '});',
        'await capability.ready();',
        "const tool = capability.tools().find((candidate) => candidate.name === 'leak__pid');",
        "const pid = await tool.execute({}, { readSecret: () => null, cwd: process.cwd(), signal: new AbortController().signal, note: () => undefined });",
        'process.stdout.write(`PID:${pid}\\n`);',
        '// Prove the child really is running before the exit hook is the only hope.',
        'try { process.kill(pid, 0); } catch { process.exit(3); }',
        '// Deliberately no dispose(): the exit hook is the only thing left.',
        'process.exit(0);',
      ].join('\n'),
    );

    const host = spawn(process.execPath, [script, FIXTURE, distEntry], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    host.stdout.setEncoding('utf8');
    host.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const exitCode = await new Promise<number | null>((resolve) => host.once('exit', resolve));

    expect(exitCode).toBe(0);
    const match = /PID:(\d+)/.exec(stdout);
    expect(match).not.toBeNull();
    await expectProcessGone(Number(match?.[1]));
  });
});

describe('stdio security', () => {
  it('refuses to configure a stdio server without allowStdio', () => {
    expect(() => createMcpCapability({ servers: [stdioServer('files')] })).toThrow(/allowStdio: true to opt in/);
    expect(() => createMcpCapability({ servers: [stdioServer('files')] })).toThrow(/arbitrary code execution/);
  });

  it('refuses a runtime stdio connect without allowStdio even when the manager started clean', async () => {
    const manager = new McpManager({ servers: [] });
    await expect(manager.addServer(stdioServer('files'))).rejects.toThrow(/allowStdio: true to opt in/);
    await manager.dispose();
  });

  it('never forwards the host environment to the child', async () => {
    process.env.MCP_TEST_FAKE_TOKEN = 'super-secret-value';
    process.env.MCP_TEST_UNRELATED = 'not-in-the-allow-list';
    try {
      const capability = await mount({
        allowStdio: true,
        servers: [stdioServer('envcheck', { env: { MCP_FIXTURE_GREETING: 'hello' } })],
      });

      const names = await call(capability, 'envcheck__env_names');
      expect(names.split(',')).toContain('MCP_FIXTURE_GREETING');
      expect(names).not.toContain('MCP_TEST_FAKE_TOKEN');
      expect(names).not.toContain('MCP_TEST_UNRELATED');
      expect(names).not.toContain('super-secret-value');
    } finally {
      delete process.env.MCP_TEST_FAKE_TOKEN;
      delete process.env.MCP_TEST_UNRELATED;
    }
  });

  it('recognises secret-looking variable names', () => {
    for (const name of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'APP_SECRET', 'DB_PASSWORD', 'AWS_ACCESS_KEY_ID', 'AWS_REGION']) {
      expect(isSecretLikeEnvName(name)).toBe(true);
    }
    for (const name of ['PATH', 'HOME', 'LANG', 'MCP_FIXTURE_GREETING']) {
      expect(isSecretLikeEnvName(name)).toBe(false);
    }
  });

  it('rejects a server name containing the reserved separator', () => {
    expect(() => createMcpCapability({ servers: [stdioServer('files__evil')] })).toThrow(/reserved separator/);
  });

  it('keeps two servers with the same tool name apart and never crosses them', async () => {
    const capability = await mount({ allowStdio: true, servers: [stdioServer('alpha'), stdioServer('beta')] });

    expect(toolNames(capability)).toContain('alpha__echo');
    expect(toolNames(capability)).toContain('beta__echo');
    expect(await call(capability, 'alpha__echo', { text: 'from-alpha' })).toBe('from-alpha');
    expect(await call(capability, 'beta__echo', { text: 'from-beta' })).toBe('from-beta');

    // Each server saw its own echo and its own diagnostics call, nothing else.
    expect((await diagnostics(capability, 'alpha')).calls).toEqual(['echo', 'diagnostics']);
    expect((await diagnostics(capability, 'beta')).calls).toEqual(['echo', 'diagnostics']);
  });

  it('refuses a non-http(s) URL before making any request', () => {
    expect(() => createMcpCapability({ servers: [{ name: 'web', transport: 'http', url: 'file:///etc/passwd' }] })).toThrow(
      /must use http or https, got "file"/,
    );
    expect(() => createMcpCapability({ servers: [{ name: 'ws', transport: 'sse', url: 'ws://example.test/sse' }] })).toThrow(
      /must use http or https, got "ws"/,
    );
  });

  it('refuses a name that collides once normalized', () => {
    expect(() =>
      createMcpCapability({ allowStdio: true, servers: [stdioServer('my-server'), stdioServer('my_server')] }),
    ).toThrow(/both map to the tool namespace/);
  });
});

describe('tool approval policy', () => {
  it('requires approval by default and can be relaxed explicitly', async () => {
    const strict = await mount({ allowStdio: true, servers: [stdioServer('files')] });
    expect(strict.tools().every((tool) => tool.requiresApproval)).toBe(true);

    const relaxed = await mount({ allowStdio: true, requireApproval: false, servers: [stdioServer('files')] });
    expect(relaxed.tools().every((tool) => !tool.requiresApproval)).toBe(true);
  });
});

describe('http transports', () => {
  it('discovers and calls tools over streamable HTTP with a JSON response', async () => {
    const server = await startStreamableHttpServer();
    const capability = await mount({ servers: [{ name: 'web', transport: 'http', url: server.url }] });

    expect(toolNames(capability)).toEqual(['web__ping']);
    expect(await call(capability, 'web__ping', { value: 7 })).toBe('pong:{"value":7}');

    // The session id the server handed back on initialize must be echoed.
    const toolsList = server.requests.find((request) => request.method === 'tools/list');
    expect(toolsList?.headers['mcp-session-id']).toBe('sess-1');
  });

  it('accepts an SSE response body to a POST', async () => {
    const server = await startStreamableHttpServer({ sse: true });
    const capability = await mount({ servers: [{ name: 'web', transport: 'http', url: server.url }] });

    expect(toolNames(capability)).toEqual(['web__ping']);
    expect(await call(capability, 'web__ping')).toBe('pong:{}');
  });

  it('speaks the legacy SSE transport', async () => {
    const server = await startLegacySseServer();
    const capability = await mount({ servers: [{ name: 'legacy', transport: 'sse', url: `${server.url}/sse` }] });

    expect(toolNames(capability)).toEqual(['legacy__ping']);
    expect(await call(capability, 'legacy__ping', { via: 'sse' })).toBe('pong:{"via":"sse"}');
    expect(server.requests.some((request) => request.method === 'tools/call')).toBe(true);
  });

  it('reports an unreachable HTTP server as an error state, not a crash', async () => {
    const capability = await mount({ servers: [{ name: 'gone', transport: 'http', url: 'http://127.0.0.1:1/mcp' }] });

    const state = capability.states()[0];
    expect(state?.status).toBe('error');
    expect(state?.error).toBeTruthy();
  });
});

describe('capability surface', () => {
  it('contributes namespaced tools, RPC methods and the mcp flag without colliding with core', async () => {
    const capability = await mount({ allowStdio: true, servers: [stdioServer('files')] });
    const { tools, extraMethods, flags } = collectContributions([capability]);

    expect(() => assertCapability(capability)).not.toThrow();
    expect(flags).toEqual({ mcp: true });
    expect(tools.length).toBeGreaterThan(0);
    expect(Object.keys(extraMethods).sort()).toEqual([
      'mcp.callTool',
      'mcp.connect',
      'mcp.disconnect',
      'mcp.reload',
      'mcp.servers',
      'mcp.setToolState',
      'mcp.tools',
    ]);
    // The protocol registry already owns mcp.list/mcp.add/...; a contribution
    // with those names would be rejected by the registry.
    expect(extraMethods['mcp.list']).toBeUndefined();
    expect(extraMethods['mcp.add']).toBeUndefined();
    expect(extraMethods['mcp.listTools']).toBeUndefined();

    const host = new Host({
      dataDir: tempDir(),
      version: '0.0.0-test',
      mode: 'self-hosted',
      capabilities: flags,
      extraMethods,
    });
    hosts.push(host);
    expect(host.describeMethods().map((method) => method.name)).toContain('mcp.servers');
  });

  it('serves mcp.servers, mcp.tools and mcp.callTool to a local client', async () => {
    const capability = await mount({ allowStdio: true, servers: [stdioServer('files')] });
    const { extraMethods } = collectContributions([capability]);
    const host = new Host({ dataDir: tempDir(), version: '0.0.0-test', mode: 'self-hosted', extraMethods });
    hosts.push(host);
    const session = host.createSession('local');

    const servers = (await host.dispatch(session, 'mcp.servers', {})) as { servers: { name: string; status: string; toolCount: number }[] };
    expect(servers.servers).toHaveLength(1);
    expect(servers.servers[0]?.name).toBe('files');
    expect(servers.servers[0]?.status).toBe('connected');

    const tools = (await host.dispatch(session, 'mcp.tools', { serverName: 'files' })) as { tools: { exposedName: string; enabled: boolean }[] };
    expect(tools.tools.map((tool) => tool.exposedName)).toContain('files__echo');

    const called = (await host.dispatch(session, 'mcp.callTool', {
      serverName: 'files',
      toolName: 'echo',
      args: { text: 'through-rpc' },
    })) as { text: string; isError: boolean };
    expect(called).toEqual({ text: 'through-rpc', isError: false });

    const disabled = (await host.dispatch(session, 'mcp.setToolState', {
      serverName: 'files',
      toolName: 'echo',
      enabled: false,
    })) as { enabled: boolean };
    expect(disabled.enabled).toBe(false);
    expect(toolNames(capability)).not.toContain('files__echo');
    await expect(host.dispatch(session, 'mcp.callTool', { serverName: 'files', toolName: 'echo' })).rejects.toThrow(/is disabled/);
  });

  it('keeps person-class methods away from a background device', async () => {
    const capability = await mount({ allowStdio: true, servers: [stdioServer('files')] });
    const { extraMethods } = collectContributions([capability]);
    const host = new Host({ dataDir: tempDir(), version: '0.0.0-test', mode: 'self-hosted', extraMethods });
    hosts.push(host);
    const background = host.createSession('network');

    await expect(host.dispatch(background, 'mcp.servers', {})).resolves.toBeTruthy();
    await expect(host.dispatch(background, 'mcp.reload', {})).resolves.toBeTruthy();
    await expect(
      host.dispatch(background, 'mcp.connect', { name: 'evil', transport: 'stdio', command: 'node' }),
    ).rejects.toThrow(/human presence/);
    await expect(host.dispatch(background, 'mcp.disconnect', { serverName: 'files' })).rejects.toThrow(/human presence/);
  });

  it('refuses a runtime mcp.connect for stdio when the host did not opt in', async () => {
    const capability = await mount({ servers: [] });
    const { extraMethods } = collectContributions([capability]);
    const host = new Host({ dataDir: tempDir(), version: '0.0.0-test', mode: 'self-hosted', extraMethods });
    hosts.push(host);

    await expect(
      host.dispatch(host.createSession('local'), 'mcp.connect', { name: 'files', transport: 'stdio', command: 'node' }),
    ).rejects.toThrow(/allowStdio: true to opt in/);
  });
});

describe('protocol handling', () => {
  it('classifies JSON-RPC messages by whether they carry an id', () => {
    expect(parseJsonRpcMessage({ jsonrpc: '2.0', method: 'tools/list', params: {} })).toEqual({
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
    });
    expect(parseJsonRpcMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call' })).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
    });
    expect(parseJsonRpcMessage({ jsonrpc: '2.0', id: 3, result: { tools: [] } })).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { tools: [] },
    });
    expect(parseJsonRpcMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'parse error' },
    });
    // Not JSON-RPC 2.0, or not a message at all.
    expect(parseJsonRpcMessage({ id: 1, result: {} })).toBeUndefined();
    expect(parseJsonRpcMessage('hello')).toBeUndefined();
    expect(parseJsonRpcMessage(null)).toBeUndefined();
  });

  it('drops malformed tool entries and keeps the usable ones', () => {
    expect(parseToolEntry({ name: 'ok', description: 'fine', inputSchema: { type: 'object' } })).toEqual({
      name: 'ok',
      description: 'fine',
      parameters: { type: 'object' },
    });
    expect(parseToolEntry({ name: 'no-schema', description: '' })).toEqual({
      name: 'no-schema',
      description: '',
      parameters: { type: 'object', properties: {} },
    });
    expect(parseToolEntry({ name: 42 })).toBeNull();
    expect(parseToolEntry({ name: '   ' })).toBeNull();
    expect(parseToolEntry(null)).toBeNull();
    expect(parseToolEntry({ name: 'bad\nname' })).toBeNull();
  });

  it('parses SSE frames incrementally, including split chunks', () => {
    const events: { event: string; data: string }[] = [];
    const parser = createSseParser((event) => events.push({ event: event.event, data: event.data }));

    parser.push('event: endpoint\ndata: /mes');
    expect(events).toEqual([]);
    parser.push('sages?session=1\n\n: keep-alive\n\ndata: {"a":1}\n');
    parser.push('\ndata: line one\ndata: line two\n\n');
    parser.end();

    expect(events).toEqual([
      { event: 'endpoint', data: '/messages?session=1' },
      { event: 'message', data: '{"a":1}' },
      { event: 'message', data: 'line one\nline two' },
    ]);
  });

  it('never inlines base64 in a flattened result', () => {
    const text = flattenContentBlocks([
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'Q'.repeat(4000), mimeType: 'image/jpeg' },
      { type: 'resource', resource: { uri: 'mem://x', blob: 'R'.repeat(4000) } },
    ]);
    expect(text).toContain('caption');
    expect(text).toContain('[image: image/jpeg, ~3000 bytes omitted]');
    expect(text).toContain('[resource: mem://x (unknown type, ~3000 bytes omitted)]');
    expect(text).not.toContain('QQQQ');
    expect(text).not.toContain('RRRR');
  });
});

// ---------------------------------------------------------------------------
// Loopback MCP servers used by the HTTP tests
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: unknown;
  headers: NodeJS.Dict<string>;
}

interface FakeHttpServer {
  url: string;
  requests: RecordedRequest[];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind a port'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function jsonRpcResult(message: Record<string, unknown>): unknown {
  const params = typeof message.params === 'object' && message.params !== null ? (message.params as Record<string, unknown>) : {};
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-http-server', version: '1.0.0' },
      };
    case 'tools/list':
      return { tools: [{ name: 'ping', description: 'Ping the server.', inputSchema: { type: 'object', properties: {} } }] };
    case 'tools/call':
      return { content: [{ type: 'text', text: `pong:${JSON.stringify(params.arguments ?? {})}` }] };
    default:
      return null;
  }
}

async function startStreamableHttpServer(options: { sse?: boolean } = {}): Promise<FakeHttpServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        res.writeHead(400).end();
        return;
      }
      requests.push({ method: message.method, headers: req.headers });

      if (message.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }

      const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: jsonRpcResult(message) });
      const headers = { 'content-type': options.sse === true ? 'text/event-stream' : 'application/json', 'mcp-session-id': 'sess-1' };
      if (options.sse === true) {
        res.writeHead(200, headers);
        res.write(`event: message\ndata: ${payload}\n\n`);
        res.end();
      } else {
        res.writeHead(200, headers);
        res.end(payload);
      }
    })();
  });
  servers.push(server);
  return { url: await listen(server), requests };
}

async function startLegacySseServer(): Promise<FakeHttpServer> {
  const requests: RecordedRequest[] = [];
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: endpoint\ndata: /messages?session=abc\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      void (async () => {
        const raw = await readBody(req);
        const message = JSON.parse(raw) as Record<string, unknown>;
        requests.push({ method: message.method, headers: req.headers });
        res.writeHead(202).end();
        if (message.method === 'notifications/initialized') return;
        const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: jsonRpcResult(message) });
        for (const stream of streams) stream.write(`event: message\ndata: ${payload}\n\n`);
      })();
      return;
    }

    res.writeHead(404).end();
  });
  servers.push(server);
  return { url: await listen(server), requests };
}
