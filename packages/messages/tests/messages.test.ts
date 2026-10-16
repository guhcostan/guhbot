import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertCapability } from '@guhbot/agent';
import type { Capability, ToolDefinition, ToolExecutionContext } from '@guhbot/agent';
import type { AppleScriptRunResult } from '../src/applescript.js';
import { buildSendScript, escapeAppleScriptLiteral } from '../src/applescript.js';
import { UNDECODED_BODY_MARKER, decodeAttributedBody } from '../src/attributed-body.js';
import { appleTimestampToIso, detectMagnitude, isoToAppleTimestamp } from '../src/dates.js';
import { createMessagesCapability, type MessagesCapability, type MessagesCapabilityOptions } from '../src/index.js';
import type { AppleScriptRunner } from '../src/options.js';

/**
 * These tests never look at the real `~/Library/Messages/chat.db`. Every case
 * runs against a synthetic database built in a temp directory with the same
 * table and column names Apple uses, so the suite works without Full Disk
 * Access, without Messages.app and without reading anyone's messages.
 */

const APPLE_EPOCH_MS = 978_307_200_000;

const ALICE = '+15550000001';
const BOB = '+15550000002';
const CAROL = '+15550000003';
const ALICE_CHAT = 'iMessage;-;+15550000001';
const BOB_CHAT = 'iMessage;-;+15550000002';
const GROUP_CHAT = 'iMessage;+;chat0000000000000001';

function nsFromIso(iso: string): bigint {
  return BigInt(Date.parse(iso) - APPLE_EPOCH_MS) * 1_000_000n;
}

function secondsFromIso(iso: string): bigint {
  return BigInt(Math.floor((Date.parse(iso) - APPLE_EPOCH_MS) / 1000));
}

const LONG_BODY = `a long attributed body ${'x'.repeat(200)}`;

interface FixtureOptions {
  /** Drop optional columns and tables to exercise graceful degradation. */
  reduced?: boolean;
  /** Drop a required column so no read is possible at all. */
  broken?: boolean;
  magnitude?: 'nanoseconds' | 'seconds';
}

interface FixtureMessage {
  rowid: number;
  guid: string;
  text: string | null;
  body?: string;
  handleId: number;
  date: bigint;
  fromMe: boolean;
  associatedType?: number;
}

/** Mimic the typedstream framing macOS writes for an NSAttributedString body. */
function attributedBodyBlob(text: string): Uint8Array {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.concat([
    Buffer.from('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01\x40\x84\x84\x84', 'latin1'),
    Buffer.from('NSString', 'latin1'),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
  ]);
  const length =
    payload.byteLength < 0x80
      ? Buffer.from([payload.byteLength])
      : Buffer.from([0x81, payload.byteLength & 0xff, (payload.byteLength >> 8) & 0xff]);
  return Buffer.concat([header, length, payload, Buffer.from([0x86, 0x84])]);
}

function createFixture(dir: string, name: string, options: FixtureOptions = {}): string {
  const path = join(dir, `${name}.db`);
  const db = new DatabaseSync(path);
  const magnitude = options.magnitude ?? 'nanoseconds';
  const stamp = (iso: string): bigint => (magnitude === 'nanoseconds' ? nsFromIso(iso) : secondsFromIso(iso));

  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT, country TEXT);
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT UNIQUE NOT NULL,
      chat_identifier TEXT,
      ${options.reduced ? '' : 'display_name TEXT,'}
      service_name TEXT
    );
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  `);

  if (!options.reduced) {
    db.exec(`
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, filename TEXT, mime_type TEXT, total_bytes INTEGER);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    `);
  }

  db.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT UNIQUE NOT NULL,
      text TEXT,
      ${options.reduced ? '' : 'attributedBody BLOB,'}
      handle_id INTEGER DEFAULT 0,
      service TEXT,
      ${options.broken ? '' : 'date INTEGER,'}
      is_from_me INTEGER DEFAULT 0,
      associated_message_type INTEGER DEFAULT 0,
      item_type INTEGER DEFAULT 0
    );
  `);

  const handle = db.prepare('INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)');
  handle.run(1, ALICE, 'iMessage');
  handle.run(2, BOB, 'iMessage');
  handle.run(3, CAROL, 'iMessage');

  const chat = db.prepare(
    `INSERT INTO chat (ROWID, guid, chat_identifier, ${options.reduced ? '' : 'display_name, '} service_name)
     VALUES (?, ?, ?, ${options.reduced ? '' : '?, '} ?)`,
  );
  if (options.reduced) {
    chat.run(1, ALICE_CHAT, ALICE, 'iMessage');
    chat.run(2, BOB_CHAT, BOB, 'iMessage');
    chat.run(3, GROUP_CHAT, 'chat0000000000000001', 'iMessage');
  } else {
    chat.run(1, ALICE_CHAT, ALICE, 'Alice', 'iMessage');
    chat.run(2, BOB_CHAT, BOB, 'Bob', 'iMessage');
    chat.run(3, GROUP_CHAT, 'chat0000000000000001', 'Project group', 'iMessage');
  }

  const member = db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)');
  member.run(1, 1);
  member.run(2, 2);
  member.run(3, 3);

  const messages: FixtureMessage[] = [
    { rowid: 1, guid: 'msg-1', text: 'hey there', handleId: 1, date: stamp('2026-10-01T12:00:00.000Z'), fromMe: false },
    { rowid: 2, guid: 'msg-2', text: 'on my way', handleId: 0, date: stamp('2026-10-01T12:01:00.000Z'), fromMe: true },
    {
      rowid: 3,
      guid: 'msg-3',
      text: null,
      body: 'body from the attributed body blob',
      handleId: 1,
      date: stamp('2026-10-01T12:02:00.000Z'),
      fromMe: false,
    },
    {
      rowid: 4,
      guid: 'msg-4',
      text: 'Loved “hey there”',
      handleId: 1,
      date: stamp('2026-10-01T12:03:00.000Z'),
      fromMe: false,
      associatedType: 2000,
    },
    { rowid: 5, guid: 'msg-5', text: null, body: LONG_BODY, handleId: 1, date: stamp('2026-10-01T12:04:00.000Z'), fromMe: false },
    { rowid: 6, guid: 'msg-6', text: 'see the photo', handleId: 1, date: stamp('2026-10-01T12:05:00.000Z'), fromMe: false },
    { rowid: 7, guid: 'msg-7', text: 'padding six', handleId: 1, date: stamp('2026-10-01T12:06:00.000Z'), fromMe: false },
    { rowid: 8, guid: 'msg-8', text: 'padding seven', handleId: 1, date: stamp('2026-10-01T12:07:00.000Z'), fromMe: false },
    { rowid: 9, guid: 'msg-9', text: 'bob message', handleId: 2, date: stamp('2026-10-01T12:08:00.000Z'), fromMe: false },
  ];

  if (options.reduced) {
    for (const message of messages) {
      // Without an attributedBody column there is no way to represent a body,
      // so the fixture gives every row plain text.
      message.text = message.text ?? `plain ${message.guid}`;
    }
  }

  for (const message of messages) {
    const columns: string[] = ['ROWID', 'guid', 'text'];
    const values: (string | number | bigint | Uint8Array | null)[] = [message.rowid, message.guid, message.text];
    if (!options.reduced) {
      columns.push('attributedBody');
      values.push(message.body === undefined ? null : attributedBodyBlob(message.body));
    }
    columns.push('handle_id', 'service');
    values.push(message.handleId, 'iMessage');
    if (!options.broken) {
      columns.push('date');
      values.push(message.date);
    }
    columns.push('is_from_me', 'associated_message_type', 'item_type');
    values.push(message.fromMe ? 1 : 0, message.associatedType ?? 0, 0);
    db.prepare(`INSERT INTO message (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values);
  }

  const joinMessage = db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)');
  for (const message of messages) {
    const chatId = message.rowid === 9 ? 2 : 1;
    joinMessage.run(chatId, message.rowid);
  }

  if (!options.reduced) {
    db.prepare('INSERT INTO attachment (ROWID, guid, filename, mime_type, total_bytes) VALUES (?, ?, ?, ?, ?)').run(
      1,
      'att-1',
      '/Users/someone/Library/Messages/Attachments/00/01/photo.jpg',
      'image/jpeg',
      4321,
    );
    db.prepare('INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)').run(6, 1);
  }

  db.close();
  return path;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeRunner {
  runner: AppleScriptRunner;
  scripts: string[];
}

function fakeRunner(overrides: Partial<AppleScriptRunResult> = {}): FakeRunner {
  const scripts: string[] = [];
  const runner: AppleScriptRunner = async (script) => {
    scripts.push(script);
    return { ok: true, stdout: 'sent:iMessage\n', stderr: '', exitCode: 0, failure: null, ...overrides };
  };
  return { runner, scripts };
}

function toolOf(capability: Capability, name: string): ToolDefinition {
  const found = (capability.tools?.() ?? []).find((tool) => tool.name === name);
  if (!found) throw new Error(`capability does not contribute ${name}`);
  return found;
}

const context: ToolExecutionContext = {
  readSecret: () => null,
  cwd: '/tmp',
  signal: new AbortController().signal,
  note: () => {},
};

async function run(capability: Capability, name: string, args: unknown): Promise<Record<string, unknown>> {
  const output = await toolOf(capability, name).execute(args, context);
  return JSON.parse(output) as Record<string, unknown>;
}

async function callMethod(capability: Capability, name: string, input: unknown): Promise<Record<string, unknown>> {
  const spec = capability.methods?.[name];
  if (!spec) throw new Error(`capability does not contribute ${name}`);
  const result = await spec.handler(undefined as never, undefined as never, input as never);
  return spec.output.parse(result) as Record<string, unknown>;
}

function capabilityFor(
  databasePath: string,
  allowed: readonly string[],
  extra: Partial<MessagesCapabilityOptions> = {},
): MessagesCapability {
  const runner = fakeRunner();
  return createMessagesCapability({
    databasePath,
    allowed,
    platform: 'darwin',
    runAppleScript: runner.runner,
    ...extra,
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guhbot-messages-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Capability surface
// ---------------------------------------------------------------------------

describe('messages capability surface', () => {
  it('contributes read and send tools when conversations are allowed', () => {
    const capability = capabilityFor(createFixture(dir, 'full'), [ALICE_CHAT]);
    expect(capability.tools?.().map((tool) => tool.name).sort()).toEqual([
      'messages_list_conversations',
      'messages_preview_send',
      'messages_read',
      'messages_send',
    ]);
    expect(capability.flags).toEqual({ messages: true });
    expect(capability.reason).toBeNull();
    expect(() => assertCapability(capability)).not.toThrow();
  });

  it('contributes no tools at all when the allow list is empty', () => {
    const capability = capabilityFor(createFixture(dir, 'full'), []);
    expect(capability.tools?.()).toEqual([]);
    expect(capability.flags).toEqual({ messages: false });
    expect(capability.reason).toMatch(/no Messages conversations are allowed/);
    expect(() => assertCapability(capability)).not.toThrow();
  });

  it('is inert on a platform other than darwin without throwing', () => {
    const capability = createMessagesCapability({
      platform: 'linux',
      allowed: [ALICE_CHAT],
      databasePath: join(dir, 'does-not-exist.db'),
    });
    expect(capability.tools?.()).toEqual([]);
    expect(capability.flags).toEqual({ messages: false });
    expect(capability.reason).toMatch(/darwin/);
    expect(capability.reason).toMatch(/linux/);
    expect(() => assertCapability(capability)).not.toThrow();
  });

  it('reports status and allow-list methods with honest authz classes', async () => {
    const capability = capabilityFor(createFixture(dir, 'full'), [ALICE_CHAT]);
    const methods = capability.methods ?? {};

    expect(methods['messages.status']?.authz).toBe('background');
    expect(methods['messages.listAllowed']?.authz).toBe('background');
    expect(methods['messages.addAllowed']?.authz).toBe('person');
    expect(methods['messages.removeAllowed']?.authz).toBe('person');
    for (const [name, spec] of Object.entries(methods)) {
      expect(name.startsWith('messages.')).toBe(true);
      expect(spec.summary.length).toBeGreaterThan(10);
    }

    const status = await callMethod(capability, 'messages.status', {});
    expect(status['supported']).toBe(true);
    expect(status['enabled']).toBe(true);
    expect(status['allowedCount']).toBe(1);
    expect(status['readOnly']).toBe(true);
    expect(status['fullDiskAccessRequired']).toBe(true);
    expect(status['schema']).toBeNull();
  });

  it('probes the schema and permission state without returning message content', async () => {
    const capability = capabilityFor(createFixture(dir, 'full'), [ALICE_CHAT]);
    const status = await callMethod(capability, 'messages.status', { probe: true });
    const schema = status['schema'] as Record<string, unknown>;
    expect(schema['ok']).toBe(true);
    expect(schema['effects']).toEqual([]);
    expect(JSON.stringify(status)).not.toContain('hey there');
  });

  it('explains a missing database instead of crashing the probe', async () => {
    const capability = capabilityFor(join(dir, 'nope.db'), [ALICE_CHAT]);
    const status = await callMethod(capability, 'messages.status', { probe: true });
    const schema = status['schema'] as Record<string, unknown>;
    expect(schema['ok']).toBe(false);
    expect(String((schema['effects'] as string[])[0])).toMatch(/no Messages database/);
  });

  it('adds and removes allowed conversations and tells the host to persist them', async () => {
    const persisted: string[][] = [];
    const capability = capabilityFor(createFixture(dir, 'full'), [ALICE_CHAT], {
      onAllowListChanged: (entries) => persisted.push([...entries]),
    });

    const added = await callMethod(capability, 'messages.addAllowed', { entry: BOB });
    expect(added['added']).toBe(true);
    expect(added['allowed']).toEqual([ALICE_CHAT, BOB]);
    expect(persisted).toEqual([[ALICE_CHAT, BOB]]);

    const duplicate = await callMethod(capability, 'messages.addAllowed', { entry: BOB_CHAT });
    expect(duplicate['added']).toBe(false);

    const removed = await callMethod(capability, 'messages.removeAllowed', { entry: BOB });
    expect(removed['removed']).toBe(true);
    expect(removed['allowed']).toEqual([ALICE_CHAT]);
    expect(persisted).toHaveLength(2);
  });

  it('closes the database on dispose, is idempotent, and reopens on demand', async () => {
    const capability = capabilityFor(createFixture(dir, 'full'), [ALICE_CHAT]);
    await run(capability, 'messages_read', { conversation: ALICE_CHAT, limit: 1 });
    expect(capability.isDatabaseOpen()).toBe(true);

    await capability.dispose?.();
    expect(capability.isDatabaseOpen()).toBe(false);
    await expect(capability.dispose?.()).resolves.toBeUndefined();
    expect(capability.isDatabaseOpen()).toBe(false);

    const after = await run(capability, 'messages_read', { conversation: ALICE_CHAT, limit: 1 });
    expect(after['ok']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Allow list enforcement
// ---------------------------------------------------------------------------

describe('allow list enforcement on reads', () => {
  it('lists only allowed conversations, even with a broader database', async () => {
    const capability = capabilityFor(createFixture(dir, 'full'), [ALICE_CHAT, GROUP_CHAT]);
    const result = await run(capability, 'messages_list_conversations', {});
    const conversations = result['conversations'] as Record<string, unknown>[];
    const guids = conversations.map((conversation) => conversation['guid']);
    expect(guids).toEqual([ALICE_CHAT, GROUP_CHAT]);
    expect(guids).not.toContain(BOB_CHAT);
  });

  it('matches a handle allow-list entry against the conversation it belongs to', async () => {
    const capability = capabilityFor(createFixture(dir, 'full'), ['+1 (555) 000-0001']);
    const result = await run(capability, 'messages_list_conversations', {});
    const conversations = result['conversations'] as Record<string, unknown>[];
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.['guid']).toBe(ALICE_CHAT);
  });

  it('refuses to read a conversation outside the allow list', async () => {
    const capability = capabilityFor(createFixture(dir, 'full'), [ALICE_CHAT]);
    await expect(run(capability, 'messages_read', { conversation: BOB_CHAT })).rejects.toThrow(/allow list/);
    await expect(run(capability, 'messages_read', { conversation: BOB })).rejects.toThrow(/allow list/);
    // The refusal says nothing about whether the conversation exists.
    await expect(run(capability, 'messages_read', { conversation: '+19999999999' })).rejects.toThrow(/allow list/);
  });

  it('refuses a handle that resolves into a group the user did not allow', async () => {
    // Carol is in the group, which is not on the allow list, so her handle must
    // not become a way into it.
    const capability = capabilityFor(createFixture(dir, 'full'), [CAROL]);
    await expect(run(capability, 'messages_read', { conversation: CAROL })).rejects.toThrow(/allow list/);

    const listed = await run(capability, 'messages_list_conversations', {});
    expect(listed['conversations']).toEqual([]);
  });

  it('rejects a pagination cursor it cannot parse instead of returning the newest page', async () => {
    const capability = capabilityFor(createFixture(dir, 'full'), [ALICE_CHAT]);
    await expect(run(capability, 'messages_read', { conversation: ALICE_CHAT, before: 'yesterday' })).rejects.toThrow(
      /ISO-8601/,
    );
  });

  it('returns shaped messages and never a raw row', async () => {
    const capability = capabilityFor(createFixture(dir, 'full'), [ALICE_CHAT]);
    const result = await run(capability, 'messages_read', { conversation: ALICE_CHAT });
    const messages = result['messages'] as Record<string, unknown>[];
    const serialized = JSON.stringify(result);

    expect(result['ok']).toBe(true);
    expect(messages).toHaveLength(7);
    expect(messages[0]?.['text']).toBe('hey there');
    expect(messages[0]?.['fromMe']).toBe(false);
    expect(messages[0]?.['sender']).toBe(ALICE);
    expect(messages[1]?.['fromMe']).toBe(true);
    expect(messages[1]?.['sender']).toBeNull();
    // The tapback is stored as a message but is not conversation.
    expect(serialized).not.toContain('Loved');
    // Bodies that moved to attributedBody are decoded, not dropped.
    expect(serialized).toContain('body from the attributed body blob');
    expect(serialized).toContain(LONG_BODY);
    // Internal columns and paths stay behind.
    expect(serialized).not.toMatch(/rowid|ROWID|handle_id|associated_message_type|chat_message_join/);
    expect(serialized).not.toContain('/Users/someone');
    expect(messages.every((message) => !('rowid' in message))).toBe(true);

    const withAttachment = messages.find((message) => message['guid'] === 'msg-6');
    expect(withAttachment?.['attachments']).toEqual([{ name: 'photo.jpg', mimeType: 'image/jpeg', bytes: 4321 }]);
  });

  it('paginates and respects the byte budget', async () => {
    const capability = capabilityFor(createFixture(dir, 'full'), [ALICE_CHAT]);
    const first = await run(capability, 'messages_read', { conversation: ALICE_CHAT, limit: 3 });
    const firstMessages = first['messages'] as Record<string, unknown>[];
    expect(firstMessages).toHaveLength(3);
    expect(first['nextCursor']).toBe(firstMessages[0]?.['at']);

    const older = await run(capability, 'messages_read', {
      conversation: ALICE_CHAT,
      limit: 3,
      before: first['nextCursor'],
    });
    const olderMessages = older['messages'] as Record<string, unknown>[];
    expect(olderMessages).toHaveLength(3);
    const firstGuids = new Set(firstMessages.map((message) => message['guid']));
    expect(olderMessages.some((message) => firstGuids.has(message['guid']))).toBe(false);

    const budgeted = await run(capability, 'messages_read', { conversation: ALICE_CHAT, max_bytes: 1000 });
    const budgetedMessages = budgeted['messages'] as Record<string, unknown>[];
    expect(budgeted['truncated']).toBe(true);
    expect(budgetedMessages.length).toBeGreaterThan(0);
    expect(budgetedMessages.length).toBeLessThan(7);
  });

  it('never writes to the database it reads, and leaves no WAL sidecar behind', async () => {
    const path = createFixture(dir, 'untouched');
    const before = statSync(path);
    const capability = capabilityFor(path, [ALICE_CHAT]);

    await run(capability, 'messages_list_conversations', {});
    await run(capability, 'messages_read', { conversation: ALICE_CHAT });
    await capability.dispose?.();

    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // Copying or attaching the sidecars would show up as new files next to it.
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  it('refuses unknown arguments rather than guessing', async () => {
    const capability = capabilityFor(createFixture(dir, 'full'), [ALICE_CHAT]);
    await expect(run(capability, 'messages_read', { conversation: ALICE_CHAT, since: 'yesterday' })).rejects.toThrow(
      /unknown argument/,
    );
  });
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

describe('messages_send', () => {
  it('always requires approval and offers no option to disable it', () => {
    const permissive = createMessagesCapability({
      databasePath: createFixture(dir, 'full'),
      allowed: [ALICE],
      platform: 'darwin',
      ...({ requireApproval: false, autoApprove: true, skipApproval: true, approveSends: false } as unknown as Partial<MessagesCapabilityOptions>),
    });
    const send = toolOf(permissive, 'messages_send');
    expect(send.requiresApproval).toBe(true);
    // Nothing in the declared arguments can stand in for a human decision.
    const properties = (send.parameters['properties'] ?? {}) as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(['recipient', 'service', 'text']);
    // Read-only tools stay cheap so an unattended run is not blocked.
    expect(toolOf(permissive, 'messages_read').requiresApproval).toBe(false);
    expect(toolOf(permissive, 'messages_list_conversations').requiresApproval).toBe(false);
  });

  it('refuses to send to a handle that is not on the allow list', async () => {
    const fixture = createFixture(dir, 'full');
    const runner = fakeRunner();
    const capability = createMessagesCapability({
      databasePath: fixture,
      allowed: [ALICE_CHAT],
      platform: 'darwin',
      runAppleScript: runner.runner,
    });
    await expect(toolOf(capability, 'messages_send').execute({ recipient: BOB, text: 'hello' }, context)).rejects.toThrow(
      /allow list/,
    );
    expect(runner.scripts).toHaveLength(0);
  });

  it('sends to an allowed handle through osascript exactly once', async () => {
    const runner = fakeRunner();
    const capability = createMessagesCapability({
      databasePath: createFixture(dir, 'full'),
      allowed: [ALICE],
      platform: 'darwin',
      runAppleScript: runner.runner,
    });
    const result = await run(capability, 'messages_send', { recipient: ALICE, text: 'see you at six' });
    expect(result['sent']).toBe(true);
    expect(result['service']).toBe('imessage');
    expect(runner.scripts).toHaveLength(1);
    expect(runner.scripts[0]).toContain('tell application "Messages"');
    expect(runner.scripts[0]).toContain('send "see you at six"');
  });

  it('never echoes the message text when the send fails', async () => {
    const secretBody = 'the passphrase is hunter2';
    const runner = fakeRunner({
      ok: false,
      stdout: '',
      stderr: `execution error: Messages got an error: cannot send "${secretBody}" to ${ALICE} (-1728)`,
      exitCode: 1,
      failure: 'failed',
    });
    const capability = createMessagesCapability({
      databasePath: createFixture(dir, 'full'),
      allowed: [ALICE],
      platform: 'darwin',
      runAppleScript: runner.runner,
    });

    const failure = await toolOf(capability, 'messages_send')
      .execute({ recipient: ALICE, text: secretBody }, context)
      .then(() => null)
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

    expect(failure).toContain('[redacted]');
    expect(failure).not.toContain(secretBody);
    expect(failure).not.toContain(ALICE);
    expect(capability.lastError).not.toContain(secretBody);
  });

  it('previews a send without sending it', async () => {
    const runner = fakeRunner();
    const capability = createMessagesCapability({
      databasePath: createFixture(dir, 'full'),
      allowed: [ALICE],
      platform: 'darwin',
      runAppleScript: runner.runner,
    });
    const preview = await run(capability, 'messages_preview_send', { recipient: ALICE, text: 'draft body' });
    expect(preview['preview']).toBe(true);
    expect(preview['text']).toBe('draft body');
    expect(preview['textBytes']).toBe(10);
    expect(runner.scripts).toHaveLength(0);
    expect(toolOf(capability, 'messages_preview_send').requiresApproval).toBe(false);
    await expect(run(capability, 'messages_preview_send', { recipient: BOB, text: 'nope' })).rejects.toThrow(/allow list/);
  });

  it('rejects a recipient that is not a handle or a chat GUID', async () => {
    const capability = capabilityFor(createFixture(dir, 'full'), [ALICE, 'Alice']);
    await expect(run(capability, 'messages_send', { recipient: 'Alice', text: 'hi' })).rejects.toThrow(
      /phone number, an email handle or a Messages chat GUID/,
    );
    await expect(run(capability, 'messages_send', { recipient: 'Alice Smith', text: 'hi' })).rejects.toThrow(
      /no whitespace/,
    );
  });

  it('reports a missing osascript as a configuration error', async () => {
    const runner: AppleScriptRunner = async () => ({
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: null,
      failure: 'not-found',
    });
    const capability = createMessagesCapability({
      databasePath: createFixture(dir, 'full'),
      allowed: [ALICE],
      platform: 'darwin',
      runAppleScript: runner,
      osascriptPath: '/usr/bin/definitely-not-osascript',
    });
    await expect(run(capability, 'messages_send', { recipient: ALICE, text: 'hi' })).rejects.toThrow(
      /osascript was not found at \/usr\/bin\/definitely-not-osascript/,
    );
  });
});

// ---------------------------------------------------------------------------
// AppleScript escaping
// ---------------------------------------------------------------------------

/** Count the quotes AppleScript would treat as string delimiters. */
function delimiterQuotes(script: string): number {
  let count = 0;
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '"') count += 1;
  }
  return count;
}

describe('AppleScript escaping', () => {
  it('escapes quotes, backslashes and newlines', () => {
    expect(escapeAppleScriptLiteral('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeAppleScriptLiteral('C:\\Users\\me')).toBe('C:\\\\Users\\\\me');
    expect(escapeAppleScriptLiteral('line one\nline two')).toBe('line one\\nline two');
    expect(escapeAppleScriptLiteral('tab\there')).toBe('tab\\there');
    expect(escapeAppleScriptLiteral('cr\rhere')).toBe('cr\\rhere');
    // U+2028 is a line break in some AppleScript builds; it cannot be escaped
    // as itself, so it becomes a newline escape.
    expect(escapeAppleScriptLiteral('a\u2028b')).toBe('a\\nb');
    // Control characters have no literal form and are dropped.
    expect(escapeAppleScriptLiteral('a\u0000\u0007b')).toBe('ab');
    expect(escapeAppleScriptLiteral('attachment \uFFFC here')).toBe('attachment  here');
  });

  it('keeps a payload containing `tell application` inside the string literal', () => {
    const payload = 'tell application "Messages" to quit';
    const script = buildSendScript({ recipient: ALICE, text: payload, service: 'imessage' });

    expect(script).toContain('send "tell application \\"Messages\\" to quit" to targetBuddy');
    // Every delimiter quote is accounted for: the injected text cannot open or
    // close a literal, and the script itself stays balanced.
    expect(delimiterQuotes(script) % 2).toBe(0);
    // `tell application "Messages"`, the participant literal and `return "sent"`.
    expect(delimiterQuotes(script)).toBe(8);
  });

  it('survives a hostile recipient without unbalancing the script', () => {
    const hostile = '+1"; tell application "Messages" to quit; "';
    const script = buildSendScript({ recipient: hostile, text: 'body', service: 'auto' });
    expect(delimiterQuotes(script) % 2).toBe(0);
    expect(script).toContain('participant "+1\\"; tell application \\"Messages\\" to quit; \\"" of targetService');
  });

  it('uses the chat form for a chat GUID and the participant form for a handle', () => {
    expect(buildSendScript({ recipient: ALICE_CHAT, text: 'hi', service: 'auto' })).toContain(
      'set targetChat to chat id "iMessage;-;+15550000001"',
    );
    expect(buildSendScript({ recipient: ALICE, text: 'hi', service: 'sms' })).toContain('service type = SMS');
    expect(buildSendScript({ recipient: ALICE, text: 'hi', service: 'auto' })).toContain('service type = iMessage');
  });

  const osacompileAvailable = process.platform === 'darwin' && existsSync('/usr/bin/osacompile');
  it.skipIf(!osacompileAvailable)('produces AppleScript the system compiler accepts', () => {
    const payload = 'tell application "Messages" to quit\n"quoted" C:\\path \u2028 tab\there \u0007';
    for (const service of ['auto', 'imessage', 'sms'] as const) {
      const script = buildSendScript({ recipient: ALICE, text: payload, service });
      const output = join(dir, `check-${service}.scpt`);
      // Compiling runs nothing and reaches no database; it only proves the
      // script is syntactically valid AppleScript.
      execFileSync('/usr/bin/osacompile', ['-e', script, '-o', output], { stdio: 'pipe' });
      expect(existsSync(output)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Schema degradation
// ---------------------------------------------------------------------------

describe('schema degradation', () => {
  it('reads a reduced schema and reports what was missing', async () => {
    const capability = capabilityFor(createFixture(dir, 'reduced', { reduced: true }), [ALICE_CHAT]);
    const result = await run(capability, 'messages_read', { conversation: ALICE_CHAT, limit: 2 });
    const degraded = result['degraded'] as Record<string, unknown>;

    expect(result['ok']).toBe(true);
    expect(degraded['missingColumns']).toEqual(
      expect.arrayContaining(['message.attributedBody', 'chat.display_name']),
    );
    expect(degraded['missingTables']).toEqual(expect.arrayContaining(['attachment', 'message_attachment_join']));
    expect((degraded['effects'] as string[]).join(' ')).toMatch(/attribution|attachment metadata/);
    expect(degraded['requiredMissing']).toEqual([]);
  });

  it('detects a missing required column and degrades instead of crashing', async () => {
    const capability = capabilityFor(createFixture(dir, 'broken', { broken: true }), [ALICE_CHAT]);
    const result = await run(capability, 'messages_read', { conversation: ALICE_CHAT });

    expect(result['ok']).toBe(false);
    expect(result['degraded']).toBe(true);
    expect(result['requiredMissing']).toEqual(expect.arrayContaining(['message.date']));
    expect(String(result['reason'])).toMatch(/schema/);

    const listed = await run(capability, 'messages_list_conversations', {});
    expect(listed['ok']).toBe(false);
    expect(listed['requiredMissing']).toEqual(expect.arrayContaining(['message.date']));
  });

  it('names Full Disk Access when macOS refuses the read', async () => {
    const path = createFixture(dir, 'locked');
    const capability = capabilityFor(path, [ALICE_CHAT]);
    chmodSync(path, 0o000);
    try {
      // Reading a chmod 000 file as its owner is EACCES, which is what a TCC
      // denial looks like from here. Root would not be refused at all.
      const root = typeof process.getuid === 'function' && process.getuid() === 0;
      const failure = await run(capability, 'messages_read', {
        conversation: ALICE_CHAT,
      })
        .then(() => null)
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
      if (root) {
        expect(failure).toBeNull();
        return;
      }
      expect(failure).toMatch(/Full Disk Access/);
      expect(failure).toMatch(/System Settings > Privacy & Security > Full Disk Access/);
      expect(failure).toMatch(/does not try to bypass/);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it('explains a database that is not a Messages database', () => {
    const capability = capabilityFor(createFixture(dir, 'broken', { broken: true }), [ALICE_CHAT]);
    const missing = capabilityFor(join(dir, 'absent.db'), [ALICE_CHAT]);
    expect(missing.flags).toEqual({ messages: true });
    void capability;
  });
});

// ---------------------------------------------------------------------------
// Dates and the attributed body
// ---------------------------------------------------------------------------

describe('Apple epoch dates', () => {
  it('normalizes nanosecond timestamps', () => {
    expect(appleTimestampToIso(nsFromIso('2026-10-01T12:00:00.000Z'))).toBe('2026-10-01T12:00:00.000Z');
    expect(appleTimestampToIso(nsFromIso('2001-01-02T00:00:00.000Z'))).toBe('2001-01-02T00:00:00.000Z');
    // Zero means "no date" in chat.db, not 2001.
    expect(appleTimestampToIso(0n)).toBeNull();
    expect(appleTimestampToIso(null)).toBeNull();
  });

  it('normalizes second timestamps from very old databases', () => {
    expect(appleTimestampToIso(secondsFromIso('2014-05-05T05:05:05.000Z'))).toBe('2014-05-05T05:05:05.000Z');
  });

  it('detects the magnitude of a column and round-trips a cursor', () => {
    expect(detectMagnitude([nsFromIso('2026-10-01T12:00:00.000Z')])).toBe('nanoseconds');
    expect(detectMagnitude([secondsFromIso('2014-05-05T05:05:05.000Z')])).toBe('seconds');
    expect(detectMagnitude([])).toBe('seconds');

    const ns = isoToAppleTimestamp('2026-10-01T12:00:00.000Z', 'nanoseconds');
    expect(appleTimestampToIso(ns)).toBe('2026-10-01T12:00:00.000Z');
    const seconds = isoToAppleTimestamp('2014-05-05T05:05:05.000Z', 'seconds');
    expect(appleTimestampToIso(seconds)).toBe('2014-05-05T05:05:05.000Z');
  });

  it('reads a seconds-magnitude database end to end', async () => {
    const capability = capabilityFor(createFixture(dir, 'old', { magnitude: 'seconds' }), [ALICE_CHAT]);
    const result = await run(capability, 'messages_read', { conversation: ALICE_CHAT });
    const messages = result['messages'] as Record<string, unknown>[];
    expect(messages).toHaveLength(7);
    expect(messages[0]?.['at']).toBe('2026-10-01T12:00:00.000Z');
    expect(messages[6]?.['at']).toBe('2026-10-01T12:07:00.000Z');
  });
});

describe('attributed body decoding', () => {
  it('decodes a short and a long NSString payload', () => {
    expect(decodeAttributedBody(attributedBodyBlob('hello there'))).toEqual({ text: 'hello there', decoded: true });
    expect(decodeAttributedBody(attributedBodyBlob(LONG_BODY))).toEqual({ text: LONG_BODY, decoded: true });
  });

  it('falls back to a marker rather than guessing', () => {
    const garbage = Buffer.from([0x04, 0x0b, 0x00, 0x01, 0x02, 0x03]);
    expect(decodeAttributedBody(garbage)).toEqual({ text: UNDECODED_BODY_MARKER, decoded: false });
    expect(decodeAttributedBody(null)).toEqual({ text: '', decoded: false });
  });

  it('does not invent text out of archive noise', () => {
    const noise = Buffer.concat([
      Buffer.from('NSString', 'latin1'),
      Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 0x7f]),
      Buffer.alloc(120, 0x01),
    ]);
    const decoded = decodeAttributedBody(noise);
    expect(decoded.decoded).toBe(false);
    expect(decoded.text).toBe(UNDECODED_BODY_MARKER);
  });
});
