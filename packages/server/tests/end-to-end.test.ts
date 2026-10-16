import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentLoop, OpenAiCompatibleProvider, builtinTools } from '@guhbot/agent';
import { Host } from '@guhbot/host-core';
import { GuhbotClient, HostServer } from '../src/index.js';
import type { Entry, Approval } from '@guhbot/protocol';

/**
 * Full-stack integration: a real HTTP server speaking the OpenAI wire format, the
 * real agent loop, real tools writing real files, the real WebSocket transport,
 * and a real paired client observing all of it.
 *
 * This is the test that answers "does the product actually work end to end".
 * Nothing is stubbed except the model's *words* — the transports, the database,
 * the tool execution and the authorization path are all the production code.
 */

let dataDir: string;
let model: Server;
let modelPort = 0;
let approvals: { approve: boolean } = { approve: true };
/** Turns the fake model will replay, in order. */
let turns: { content?: string; toolCall?: { name: string; arguments: string } }[] = [];
let requestsSeen: { messages: { role: string; content: unknown }[] }[] = [];

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'guhbot-e2e-full-'));
  turns = [];
  requestsSeen = [];
  approvals = { approve: true };

  model = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: { role: string; content: unknown }[];
      };
      requestsSeen.push(body);

      const turn = turns.shift() ?? { content: 'Nothing left to do.' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });

      if (turn.toolCall) {
        res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: turn.toolCall.name, arguments: turn.toolCall.arguments } }] } }] }));
        res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
      } else {
        res.write(sse({ choices: [{ delta: { content: turn.content ?? '' } }] }));
        res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const address = model.address();
  modelPort = typeof address === 'object' && address !== null ? address.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => model.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

async function stack() {
  const workspace = join(dataDir, 'workspace');
  const host = new Host({
    dataDir: join(dataDir, 'host'),
    version: '0.0.0-test',
    mode: 'self-hosted',
    capabilities: { exec: true, filesystem: true },
    executor: new AgentLoop({
      provider: new OpenAiCompatibleProvider({
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        defaultModel: 'fake-model',
      }),
      tools: builtinTools(),
      cwd: workspace,
    }),
  });
  const server = new HostServer({ host, port: 0 });
  const { port } = await server.listen();
  return { host, server, port, workspace };
}

/** Pair a client the way a phone would and return an authenticated client. */
async function pairedPhone(hostUrl: string, host: Host) {
  const info = (await host.dispatch(host.createSession('local'), 'pairing.begin', {})) as {
    pairingId: string;
    code: string;
  };
  const anon = new GuhbotClient({ url: hostUrl, autoReconnect: false });
  await anon.connect();
  await waitFor(() => anon.state === 'ready');
  const claimed = await anon.request('pairing.claim', {
    pairingId: info.pairingId,
    code: info.code,
    deviceName: 'iPhone',
    platform: 'ios',
    requestedClass: 'background',
  });
  await anon.close();

  const phone = new GuhbotClient({ url: hostUrl, token: claimed.token, autoReconnect: false });
  await phone.connect();
  await waitFor(() => phone.state === 'ready');
  return phone;
}

describe('end to end: prompt -> model -> tool -> file -> transcript -> phone', () => {
  it('writes a file through an approved tool call and shows the phone the whole story', async () => {
    const { host, server, port } = await stack();
    const hostUrl = `ws://127.0.0.1:${port}/rpc`;

    // The fake model asks for a real tool call, then summarises.
    turns = [
      { toolCall: { name: 'write_file', arguments: JSON.stringify({ path: 'notes/todo.md', content: '# Todo\n- ship it\n' }) } },
      { content: 'Wrote notes/todo.md with one item.' },
    ];

    const phone = await pairedPhone(hostUrl, host);
    const entries: Entry[] = [];
    const approvalsSeen: Approval[] = [];
    const statuses: string[] = [];
    phone.on('transcript.appended', (p) => entries.push((p as { entry: Entry }).entry));
    phone.on('approval.requested', (p) => approvalsSeen.push((p as { approval: Approval }).approval));
    phone.on('run.updated', (p) => statuses.push((p as { run: { status: string } }).run.status));

    // The desktop, which is where the human is, starts the run and resolves the
    // approval. The phone watches and asks to be told.
    const desktop = host.createSession('local');
    const agent = host.store.createAgent({ name: 'Writer', instructions: 'Be concise.' });

    // The workspace directory does not exist yet; the tool must create parents.
    const workspace = join(dataDir, 'workspace');
    rmSync(join(workspace, 'notes'), { recursive: true, force: true });

    await host.dispatch(desktop, 'runs.start', { agentId: agent.id, prompt: 'Write me a todo' });

    // The run parks on the approval; grant it from the desktop.
    await waitFor(() => approvalsSeen.length > 0);
    expect(approvalsSeen[0]?.kind).toBe('tool-permission');
    expect(approvalsSeen[0]?.summary).toContain('write_file');

    // A background phone must not be able to grant it.
    await expect(
      phone.request('approvals.resolve', { approvalId: approvalsSeen[0]!.id, granted: true }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await host.dispatch(desktop, 'approvals.resolve', { approvalId: approvalsSeen[0]!.id, granted: true });

    await waitFor(() => statuses.includes('succeeded'), 6000);

    // The file genuinely exists on disk with the requested contents.
    void workspace;
    // The tool ran with cwd = <dataDir>/workspace, so the file is there.
    const written = readFileSync(join(dataDir, 'workspace', 'notes', 'todo.md'), 'utf8');
    expect(written).toBe('# Todo\n- ship it\n');

    // The phone saw the entire narrative in order.
    // Four entries: the prompt, the tool call, its result, and the summary.
    const contents = await waitForEntries(phone, agent.id, 4);
    expect(contents).toEqual([
      'Write me a todo',
      '{"path":"notes/todo.md","content":"# Todo\\n- ship it\\n"}',
      'Wrote 17 characters to notes/todo.md.',
      'Wrote notes/todo.md with one item.',
    ]);

    // The second model request carried the tool result back, which is what makes
    // tool calling actually work rather than being a one-shot.
    expect(requestsSeen).toHaveLength(2);
    const second = requestsSeen[1]!;
    expect(second.messages.some((m) => m.role === 'tool')).toBe(true);
    expect(second.messages.some((m) => m.role === 'assistant')).toBe(true);

    await phone.close();
    await server.close();
    await host.close();
  });

  it('does not write the file when the human denies the approval', async () => {
    const { host, server, port } = await stack();
    const hostUrl = `ws://127.0.0.1:${port}/rpc`;
    turns = [
      { toolCall: { name: 'write_file', arguments: JSON.stringify({ path: 'danger.txt', content: 'nope' }) } },
      { content: 'Understood, I did not write anything.' },
    ];

    const phone = await pairedPhone(hostUrl, host);
    const approvalsSeen: Approval[] = [];
    phone.on('approval.requested', (p) => approvalsSeen.push((p as { approval: Approval }).approval));

    const desktop = host.createSession('local');
    const agent = host.store.createAgent({ name: 'Writer' });
    await host.dispatch(desktop, 'runs.start', { agentId: agent.id, prompt: 'write danger.txt' });
    await waitFor(() => approvalsSeen.length > 0);

    await host.dispatch(desktop, 'approvals.resolve', { approvalId: approvalsSeen[0]!.id, granted: false });

    const entries = await waitForEntries(phone, agent.id, 4);
    // The model is told it was refused and is explicitly told not to retry.
    expect(entries.some((e) => e.includes('Refused'))).toBe(true);

    // The decisive assertion: the file was never created.
    expect(() => readFileSync(join(dataDir, 'workspace', 'danger.txt'), 'utf8')).toThrow();

    await phone.close();
    await server.close();
    await host.close();
  });

  it('completes a read-only task unattended, with no approval at all', async () => {
    const { host, server, port } = await stack();
    const hostUrl = `ws://127.0.0.1:${port}/rpc`;

    // Seed a file the agent will read.
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dataDir, 'workspace'), { recursive: true });
    writeFileSync(join(dataDir, 'workspace', 'inventory.txt'), 'apples: 3\npears: 5\n');

    turns = [
      { toolCall: { name: 'read_file', arguments: JSON.stringify({ path: 'inventory.txt' }) } },
      { content: 'You have 3 apples and 5 pears.' },
    ];

    const phone = await pairedPhone(hostUrl, host);
    const approvalsSeen: Approval[] = [];
    phone.on('approval.requested', (p) => approvalsSeen.push((p as { approval: Approval }).approval));
    const statuses: string[] = [];
    phone.on('run.updated', (p) => statuses.push((p as { run: { status: string } }).run.status));

    const desktop = host.createSession('local');
    const agent = host.store.createAgent({ name: 'Reader' });
    await host.dispatch(desktop, 'runs.start', { agentId: agent.id, prompt: 'What is in inventory?' });

    await waitFor(() => statuses.includes('succeeded'), 6000);

    // A read-only tool must not interrupt an unattended run.
    expect(approvalsSeen).toHaveLength(0);
    const entries = await waitForEntries(phone, agent.id, 4);
    expect(entries).toContain('You have 3 apples and 5 pears.');

    await phone.close();
    await server.close();
    await host.close();
  });

  it('interrupts a run in flight and reports it as interrupted, not failed', async () => {
    const { host, server, port } = await stack();
    const hostUrl = `ws://127.0.0.1:${port}/rpc`;

    // A tool that will park on approval, giving us a window to interrupt.
    turns = [
      { toolCall: { name: 'write_file', arguments: JSON.stringify({ path: 'x.txt', content: 'x' }) } },
      { content: 'done' },
    ];

    const phone = await pairedPhone(hostUrl, host);
    const statuses: string[] = [];
    phone.on('run.updated', (p) => statuses.push((p as { run: { status: string } }).run.status));

    const desktop = host.createSession('local');
    const agent = host.store.createAgent({ name: 'Slow' });
    const { run } = (await host.dispatch(desktop, 'runs.start', { agentId: agent.id, prompt: 'go' })) as {
      run: { id: string };
    };

    await waitFor(() => statuses.includes('waiting-approval'), 6000);
    await host.dispatch(desktop, 'runs.interrupt', { runId: run.id });

    // The run ends, and it ends as interrupted rather than failed or succeeded.
    await waitFor(() => statuses.includes('interrupted'), 6000);
    const final = (await phone.request('runs.get', { runId: run.id })) as { status: string; error: string | null };
    expect(final.status).toBe('interrupted');
    // An interruption is a deliberate stop, so it carries no error text.
    expect(final.error).toBeNull();

    await phone.close();
    await server.close();
    await host.close();
  });

  it('refuses a path traversal attempt from the model', async () => {
    const { host, server, port } = await stack();
    const hostUrl = `ws://127.0.0.1:${port}/rpc`;
    turns = [
      { toolCall: { name: 'read_file', arguments: JSON.stringify({ path: '../../../etc/passwd' }) } },
      { content: 'I could not read that.' },
    ];

    const phone = await pairedPhone(hostUrl, host);
    const desktop = host.createSession('local');
    const agent = host.store.createAgent({ name: 'Sneaky' });
    await host.dispatch(desktop, 'runs.start', { agentId: agent.id, prompt: 'read /etc/passwd' });

    const page = await waitForEntries(phone, agent.id, 4);
    // The tool refused, and the refusal was fed back to the model as data rather
    // than crashing the run.
    expect(page.some((e) => e.includes('escapes the working directory'))).toBe(true);
    expect(page).not.toContain('root:x:0:0');

    await phone.close();
    await server.close();
    await host.close();
  });
});

async function waitForEntries(client: GuhbotClient, agentId: string, minimum: number): Promise<string[]> {
  await waitFor(async () => {
    const page = await client.request('transcript.page', { agentId, limit: 50 });
    return page.entries.length >= minimum;
  }, 6000);
  const page = await client.request('transcript.page', { agentId, limit: 50 });
  return page.entries.map((e) => e.content);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}
