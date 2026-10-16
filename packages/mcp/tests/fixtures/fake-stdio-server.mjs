#!/usr/bin/env node
/**
 * Test double: a local MCP server speaking newline-delimited JSON-RPC on
 * stdin/stdout.
 *
 * It is deliberately awkward in the ways a real server is awkward: it emits
 * notifications that must not be answered, paginates `tools/list`, includes
 * malformed entries a client has to skip, offers a tool whose name is not a
 * valid identifier, and can hang or die in the middle of a call.
 *
 * Modes (argv):
 *   --mode=malformed   every tools/list entry is unusable
 *   --mode=not-array   tools/list returns a non-array `tools` field
 *   --ignore-sigterm   keeps running after SIGTERM, to exercise SIGKILL
 */
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const modeArg = argv.find((value) => value.startsWith('--mode='));
const mode = modeArg === undefined ? 'normal' : modeArg.slice('--mode='.length);
const ignoreSigterm = argv.includes('--ignore-sigterm');

if (ignoreSigterm) process.on('SIGTERM', () => undefined);

/** Responses the client sent us. A correct client never sends one. */
const inboundResponses = [];
/** Notifications the client sent us (it should send notifications/initialized). */
const clientNotifications = [];
/** Tool names the client called, in order. */
const calls = [];
/** Cursors the client sent to tools/list, in order. */
const cursors = [];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const PAGE_ONE = [
  {
    name: 'echo',
    description: 'Echo the text argument back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  { name: 42, description: 'malformed: name is not a string' },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
  },
  null,
  { name: 'env.names', description: 'Names of the environment variables this process can see.' },
  { description: 'malformed: no name at all' },
  { name: 'pid', description: 'The process id of this server.' },
];

const PAGE_TWO = [
  { name: 'weird/name.v2', description: 'A tool name that is not a valid identifier.' },
  { name: 'diagnostics', description: 'What this server observed from the client.' },
  { name: 'boom', description: 'Report a tool-level error.' },
  { name: 'rich', description: 'Return text, image, resource and unknown content blocks.' },
  { name: 'slow', description: 'Emit a notification, then answer later.' },
  { name: 'hang', description: 'Never answer.' },
  { name: 'die', description: 'Exit without answering.' },
];

function toolsFor(cursor) {
  if (mode === 'malformed') {
    return { tools: [null, 7, { description: 'no name' }, { name: '' }] };
  }
  if (mode === 'not-array') {
    return { tools: { echo: true } };
  }
  if (cursor === 'page-2') return { tools: PAGE_TWO };
  return { tools: PAGE_ONE, nextCursor: 'page-2' };
}

function callResult(name, args) {
  if (name === 'echo') return { content: [{ type: 'text', text: String(args.text) }] };
  if (name === 'weird/name.v2') return { content: [{ type: 'text', text: 'weird-ok' }] };
  if (name === 'add') return { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] };
  if (name === 'env.names') return { content: [{ type: 'text', text: Object.keys(process.env).sort().join(',') }] };
  if (name === 'pid') return { content: [{ type: 'text', text: String(process.pid) }] };
  if (name === 'diagnostics') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ inboundResponses, clientNotifications, calls, cursors }),
        },
      ],
    };
  }
  if (name === 'boom') return { isError: true, content: [{ type: 'text', text: 'kaboom' }] };
  if (name === 'rich') {
    return {
      content: [
        { type: 'text', text: 'caption' },
        { type: 'image', data: 'A'.repeat(20_000), mimeType: 'image/png' },
        {
          type: 'resource',
          resource: { uri: 'file:///tmp/blob.bin', mimeType: 'application/octet-stream', blob: 'B'.repeat(20_000) },
        },
        { type: 'resource', resource: { uri: 'mem://note', mimeType: 'text/plain', text: 'inline note' } },
        { type: 'surprise', data: 'x' },
      ],
    };
  }
  return null;
}

function handle(request) {
  const { id, method, params } = request;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'fake-mcp-server', version: '1.0.0' },
    });
    return;
  }

  if (method === 'tools/list') {
    const cursor = typeof params?.cursor === 'string' ? params.cursor : null;
    cursors.push(cursor);
    if (cursor === null) notify('notifications/message', { level: 'debug', data: 'listing tools' });
    respond(id, toolsFor(cursor));
    return;
  }

  if (method === 'tools/call') {
    const name = typeof params?.name === 'string' ? params.name : '';
    const args = params?.arguments ?? {};
    calls.push(name);

    if (name === 'hang') return;
    if (name === 'die') process.exit(0);
    if (name === 'slow') {
      notify('notifications/message', { level: 'info', data: 'working on it' });
      setTimeout(() => respond(id, { content: [{ type: 'text', text: 'slow-ok' }] }), 60);
      return;
    }

    const result = callResult(name, args);
    if (result === null) {
      fail(id, -32602, `unknown tool ${name}`);
      return;
    }
    respond(id, result);
    return;
  }

  fail(id, -32601, `unknown method ${String(method)}`);
}

const lines = createInterface({ input: process.stdin });

lines.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message === null || typeof message !== 'object') return;

  // A response is something only the client sends. Recording it proves whether
  // the client broke the rule about never answering a notification.
  if ('result' in message || 'error' in message) {
    inboundResponses.push(message);
    return;
  }
  if (message.id === undefined || message.id === null) {
    clientNotifications.push(message.method);
    return;
  }
  handle(message);
});

notify('notifications/message', { level: 'info', data: 'fake-stdio-server ready' });
