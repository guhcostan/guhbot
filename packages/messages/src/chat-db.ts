import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { AllowList } from './allow-list.js';
import { decodeAttributedBody } from './attributed-body.js';
import { appleTimestampToIso, detectMagnitude, isoToAppleTimestamp, type AppleDateMagnitude } from './dates.js';
import { degradationOf, readSchema, type Degradation, type MessagesSchema } from './schema.js';

/**
 * Read-only access to `~/Library/Messages/chat.db`.
 *
 * The database belongs to another program that is running right now, so this
 * class never copies it, never attaches its WAL sidecars, never writes and never
 * mutates: it opens the file `SQLITE_OPEN_READONLY`, then sets `query_only` as a
 * second, connection-level guarantee. The `-wal` and `-shm` files stay where
 * Messages.app put them; SQLite reads them in place when it needs to.
 *
 * Every query is built from an introspected schema and every result is shaped
 * here, so a caller cannot accidentally hand a raw row to a model.
 */

export const DEFAULT_DATABASE_PATH = join(homedir(), 'Library', 'Messages', 'chat.db');

export type SqlValue = string | number | bigint | null;
type Row = Record<string, string | number | bigint | Uint8Array | null>;

export interface ConversationView {
  guid: string;
  name: string | null;
  identifier: string | null;
  service: string | null;
  handles: string[];
  lastMessageAt: string | null;
  messageCount: number;
}

export interface ChatTarget {
  guid: string;
  identifier: string | null;
  service: string | null;
  name: string | null;
  handles: string[];
}

export interface AttachmentView {
  name: string;
  mimeType: string | null;
  bytes: number | null;
}

export interface MessageView {
  guid: string | null;
  at: string | null;
  fromMe: boolean | null;
  sender: string | null;
  text: string;
  attachments: AttachmentView[];
}

export interface MessagePage {
  messages: MessageView[];
  hasMore: boolean;
}

export type Availability = { ok: true; degraded: Degradation | null } | { ok: false; degraded: Degradation };

export class MessagesDatabaseError extends Error {
  readonly code: 'missing' | 'permission' | 'unreadable';

  constructor(code: MessagesDatabaseError['code'], message: string) {
    super(message);
    this.name = 'MessagesDatabaseError';
    this.code = code;
  }
}

export class ChatDatabase {
  readonly databasePath: string;
  private connection: DatabaseSync | null = null;
  private schemaReport: MessagesSchema | null = null;
  private magnitudeCache: AppleDateMagnitude | null = null;

  constructor(databasePath: string = DEFAULT_DATABASE_PATH) {
    this.databasePath = databasePath;
  }

  isOpen(): boolean {
    return this.connection !== null;
  }

  /** Path with the home directory collapsed: diagnostics should not leak it. */
  pathLabel(): string {
    const home = homedir();
    if (home.length > 0 && this.databasePath.startsWith(`${home}/`)) {
      return `~${this.databasePath.slice(home.length)}`;
    }
    return this.databasePath;
  }

  close(): void {
    const connection = this.connection;
    this.connection = null;
    this.schemaReport = null;
    this.magnitudeCache = null;
    if (connection === null) return;
    try {
      connection.close();
    } catch {
      // Closing a handle that a failed open already tore down is not an error.
    }
  }

  get schema(): MessagesSchema {
    if (this.schemaReport === null) this.schemaReport = readSchema(this.open());
    return this.schemaReport;
  }

  availability(): Availability {
    const schema = this.schema;
    const degraded = degradationOf(schema);
    if (schema.ok) return { ok: true, degraded };
    // `degradationOf` is never empty when a required column is missing; the
    // fallback only satisfies the type.
    return { ok: false, degraded: degraded ?? { requiredMissing: schema.requiredMissing, missingTables: schema.missingTables, missingColumns: schema.missingColumns, effects: schema.effects } };
  }

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  listConversations(allowList: AllowList, limit: number): ConversationView[] {
    const schema = this.schema;
    const guids = allowList.chatGuidCandidates();
    const handles = allowList.handleCandidates();

    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (guids.length > 0) {
      clauses.push(`c.guid IN (${placeholders(guids.length)})`);
      params.push(...guids);
    }
    if (handles.length > 0) {
      if (schema.has('chat', 'chat_identifier')) {
        clauses.push(`c.chat_identifier IN (${placeholders(handles.length)})`);
        params.push(...handles);
      }
      if (this.chatHandleJoinUsable()) {
        clauses.push(
          `c.ROWID IN (SELECT chj.chat_id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE h.id IN (${placeholders(handles.length)}))`,
        );
        params.push(...handles);
      }
    }
    // An allow list of nothing but malformed entries matches nothing; returning
    // early keeps the query honest instead of building `WHERE ()`.
    if (clauses.length === 0) return [];

    const rows = this.statement(
      `SELECT c.ROWID AS chatRowid,
              c.guid AS chatGuid,
              ${schema.column('chat', 'display_name', 'displayName', 'c')},
              ${schema.column('chat', 'chat_identifier', 'identifier', 'c')},
              ${schema.column('chat', 'service_name', 'serviceName', 'c')},
              (SELECT MAX(m.date) FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id
                WHERE cmj.chat_id = c.ROWID) AS lastDate,
              (SELECT COUNT(*) FROM chat_message_join cmj WHERE cmj.chat_id = c.ROWID) AS messageCount
       FROM chat c
       WHERE (${clauses.join(' OR ')})
       ORDER BY lastDate DESC, c.ROWID DESC
       LIMIT ?`,
    ).all(...params, limit) as Row[];

    const handlesByChat = this.handlesFor(rows.map((row) => row['chatRowid']));

    return rows
      .map((row) => this.conversationView(row, handlesByChat))
      .filter((conversation) => allowList.isConversationAllowed(conversation));
  }

  /** Resolve a chat GUID, a `chat_identifier` or a member handle to one chat. */
  resolveConversation(conversation: string): ChatTarget | null {
    const schema = this.schema;
    const lookups: string[] = ['c.guid = ?'];
    const params: SqlValue[] = [conversation];
    if (schema.has('chat', 'chat_identifier')) {
      lookups.push('c.chat_identifier = ?');
      params.push(conversation);
    }
    if (this.chatHandleJoinUsable()) {
      lookups.push(
        'c.ROWID IN (SELECT chj.chat_id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE h.id = ?)',
      );
      params.push(conversation);
    }

    const row = this.statement(
      `SELECT c.ROWID AS chatRowid,
              c.guid AS chatGuid,
              ${schema.column('chat', 'display_name', 'displayName', 'c')},
              ${schema.column('chat', 'chat_identifier', 'identifier', 'c')},
              ${schema.column('chat', 'service_name', 'serviceName', 'c')}
       FROM chat c
       WHERE ${lookups.join(' OR ')}
       -- A handle names a person: prefer their one to one conversation over any
       -- group they happen to be a member of.
       ORDER BY CASE WHEN c.guid LIKE '%;-;%' THEN 0 ELSE 1 END, c.ROWID DESC
       LIMIT 1`,
    ).get(...params) as Row | undefined;
    if (row === undefined) return null;

    const handles = this.handlesFor([row['chatRowid']]).get(String(row['chatRowid'])) ?? [];
    const identifier = nullableStr(row['identifier']);
    return {
      guid: str(row['chatGuid']),
      identifier,
      service: nullableStr(row['serviceName']),
      name: nullableStr(row['displayName']),
      handles: identifier !== null && !handles.includes(identifier) ? [identifier, ...handles] : handles,
    };
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /**
   * The newest `limit + 1` messages of a conversation, newest first. The extra
   * row tells the caller whether an older page exists without a second count.
   */
  readMessages(chat: ChatTarget, options: { limit: number; before: string | null }): MessagePage {
    const schema = this.schema;
    const magnitude = this.magnitude();
    const handleJoin =
      schema.has('handle', 'id') && schema.has('message', 'handle_id')
        ? 'LEFT JOIN handle h ON h.ROWID = m.handle_id'
        : '';

    const where: string[] = ['c.guid = ?'];
    const params: SqlValue[] = [chat.guid];
    if (options.before !== null) {
      const bound = isoToAppleTimestamp(options.before, magnitude);
      if (bound !== null) {
        where.push('m.date < ?');
        params.push(bound);
      }
    }
    if (schema.has('message', 'associated_message_type')) {
      // Tapbacks are stored as messages that reference another one; showing
      // them as ordinary rows turns a conversation into noise.
      where.push('COALESCE(m.associated_message_type, 0) NOT BETWEEN 2000 AND 3999');
    }
    if (schema.has('message', 'item_type')) {
      where.push('COALESCE(m.item_type, 0) = 0');
    }

    const rows = this.statement(
      `SELECT m.ROWID AS rowid,
              ${schema.column('message', 'guid', 'guid', 'm')},
              ${schema.column('message', 'date', 'date', 'm')},
              ${schema.column('message', 'text', 'text', 'm')},
              ${schema.column('message', 'attributedBody', 'attributedBody', 'm')},
              ${schema.column('message', 'is_from_me', 'isFromMe', 'm')},
              ${schema.column('message', 'service', 'service', 'm')},
              ${schema.has('handle', 'id') && schema.has('message', 'handle_id') ? 'h.id AS handle' : 'NULL AS handle'}
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
       ${handleJoin}
       WHERE ${where.join(' AND ')}
       ORDER BY m.date DESC, m.ROWID DESC
       LIMIT ?`,
    ).all(...params, options.limit + 1) as Row[];

    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const attachments = this.attachmentsFor(page.map((row) => row['rowid']));

    return {
      messages: page.map((row) => this.messageView(row, attachments)),
      hasMore,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private open(): DatabaseSync {
    if (this.connection !== null) return this.connection;
    const label = this.pathLabel();

    try {
      statSync(this.databasePath);
    } catch {
      throw new MessagesDatabaseError('missing', `there is no Messages database at ${label}`);
    }
    try {
      accessSync(this.databasePath, constants.R_OK);
    } catch {
      throw new MessagesDatabaseError('permission', fullDiskAccessMessage(label, 'EACCES'));
    }

    let connection: DatabaseSync;
    try {
      connection = new DatabaseSync(this.databasePath, { readOnly: true });
    } catch (error) {
      const errcode = (error as { errcode?: unknown }).errcode;
      if (errcode === 14) throw new MessagesDatabaseError('permission', fullDiskAccessMessage(label, 'SQLITE_CANTOPEN'));
      throw new MessagesDatabaseError('unreadable', `could not open ${label} read-only: ${describe(error)}`);
    }

    try {
      // Two independent read-only guarantees: SQLITE_OPEN_READONLY on the file
      // handle, and `query_only` on the connection.
      connection.exec('PRAGMA query_only = ON');
      connection.exec('PRAGMA busy_timeout = 3000');
      connection.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
    } catch (error) {
      this.connection = null;
      try {
        connection.close();
      } catch {
        // Nothing useful to do; the original failure is what matters.
      }
      throw new MessagesDatabaseError('unreadable', `${label} could not be read as a SQLite database: ${describe(error)}`);
    }

    this.connection = connection;
    return connection;
  }

  /**
   * `node:sqlite` refuses to return an INTEGER that does not fit in a JavaScript
   * number, and a nanosecond Apple timestamp does not. Reading integers as
   * bigint everywhere keeps that from turning into a crash mid-transcript.
   */
  private statement(sql: string): StatementSync {
    const statement = this.open().prepare(sql);
    statement.setReadBigInts(true);
    return statement;
  }

  private magnitude(): AppleDateMagnitude {
    if (this.magnitudeCache !== null) return this.magnitudeCache;
    const row = this.statement('SELECT MAX(date) AS maxDate FROM message').get() as Row | undefined;
    const maxDate = row?.['maxDate'];
    const magnitude = detectMagnitude(typeof maxDate === 'bigint' ? [maxDate] : []);
    this.magnitudeCache = magnitude;
    return magnitude;
  }

  private chatHandleJoinUsable(): boolean {
    const schema = this.schema;
    return (
      schema.hasTable('chat_handle_join') &&
      schema.has('chat_handle_join', 'chat_id') &&
      schema.has('chat_handle_join', 'handle_id') &&
      schema.has('handle', 'id')
    );
  }

  private handlesFor(chatRowids: readonly unknown[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (!this.chatHandleJoinUsable() || chatRowids.length === 0) return map;
    const ids = chatRowids.filter(isBindableId);
    if (ids.length === 0) return map;
    const rows = this.statement(
      `SELECT chj.chat_id AS chatRowid, h.id AS handle
       FROM chat_handle_join chj
       JOIN handle h ON h.ROWID = chj.handle_id
       WHERE chj.chat_id IN (${placeholders(ids.length)})`,
    ).all(...ids) as Row[];
    for (const row of rows) {
      const key = String(row['chatRowid']);
      const handle = nullableStr(row['handle']);
      if (handle === null) continue;
      const list = map.get(key) ?? [];
      if (!list.includes(handle)) list.push(handle);
      map.set(key, list);
    }
    return map;
  }

  private conversationView(row: Row, handlesByChat: Map<string, string[]>): ConversationView {
    const identifier = nullableStr(row['identifier']);
    const handles = handlesByChat.get(String(row['chatRowid'])) ?? [];
    return {
      guid: str(row['chatGuid']),
      name: nullableStr(row['displayName']),
      identifier,
      service: nullableStr(row['serviceName']),
      handles: identifier !== null && !handles.includes(identifier) ? [identifier, ...handles] : handles,
      lastMessageAt: appleTimestampToIso(asBigint(row['lastDate'])),
      messageCount: num(row['messageCount']),
    };
  }

  private messageView(row: Row, attachmentsByMessage: Map<string, AttachmentView[]>): MessageView {
    const fromMe = nullableBool(row['isFromMe']);
    return {
      guid: nullableStr(row['guid']),
      at: appleTimestampToIso(asBigint(row['date'])),
      fromMe,
      // The user's own handle is not part of the conversation they need to see.
      sender: fromMe === true ? null : nullableStr(row['handle']),
      text: this.bodyOf(row),
      attachments: attachmentsByMessage.get(String(row['rowid'])) ?? [],
    };
  }

  private bodyOf(row: Row): string {
    const text = nullableStr(row['text']);
    if (text !== null && text.length > 0) return text;
    const blob = row['attributedBody'];
    if (blob instanceof Uint8Array && blob.byteLength > 0) return decodeAttributedBody(blob).text;
    return '';
  }

  private attachmentsFor(rowids: readonly unknown[]): Map<string, AttachmentView[]> {
    const map = new Map<string, AttachmentView[]>();
    const schema = this.schema;
    if (
      !schema.hasTable('attachment') ||
      !schema.hasTable('message_attachment_join') ||
      !schema.has('message_attachment_join', 'message_id') ||
      !schema.has('message_attachment_join', 'attachment_id') ||
      !schema.has('attachment', 'rowid')
    ) {
      return map;
    }
    const ids = rowids.filter(isBindableId);
    if (ids.length === 0) return map;

    const rows = this.statement(
      `SELECT maj.message_id AS messageId,
              ${schema.column('attachment', 'filename', 'filename', 'a')},
              ${schema.column('attachment', 'mime_type', 'mimeType', 'a')},
              ${schema.column('attachment', 'total_bytes', 'totalBytes', 'a')}
       FROM message_attachment_join maj
       JOIN attachment a ON a.ROWID = maj.attachment_id
       WHERE maj.message_id IN (${placeholders(ids.length)})`,
    ).all(...ids) as Row[];

    for (const row of rows) {
      const key = String(row['messageId']);
      const filename = nullableStr(row['filename']);
      const list = map.get(key) ?? [];
      list.push({
        // A stored filename is an absolute path in the user's library; only the
        // final component is needed to describe the attachment.
        name: filename === null ? 'attachment' : baseName(filename),
        mimeType: nullableStr(row['mimeType']),
        bytes: row['totalBytes'] === null || row['totalBytes'] === undefined ? null : num(row['totalBytes']),
      });
      map.set(key, list);
    }
    return map;
  }
}

function baseName(filename: string): string {
  const withoutQuery = filename.split('?')[0] ?? filename;
  const lastSlash = withoutQuery.lastIndexOf('/');
  const candidate = lastSlash >= 0 ? withoutQuery.slice(lastSlash + 1) : withoutQuery;
  return candidate.startsWith('bp:') ? candidate.slice(3) : candidate;
}

function isBindableId(value: unknown): value is string | number | bigint {
  return value !== null && value !== undefined && !(value instanceof Uint8Array);
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function nullableStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length === 0 ? null : text;
}

function num(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  return Number(value ?? 0);
}

function asBigint(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  return null;
}

function nullableBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return value === 1 || value === 1n || value === true;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const errcode = (error as { errcode?: unknown }).errcode;
  const errstr = (error as { errstr?: unknown }).errstr;
  const suffix = typeof errcode === 'number' ? ` (SQLite ${errcode}${typeof errstr === 'string' ? ` ${errstr}` : ''})` : '';
  return `${error.message}${suffix}`;
}

function fullDiskAccessMessage(label: string, code: string): string {
  return (
    `macOS denied access to ${label} (${code}). The process running this host needs Full Disk Access: ` +
    'open System Settings > Privacy & Security > Full Disk Access, enable the app that starts the host ' +
    '(Terminal, iTerm or the packaged app), then restart it. This host does not try to bypass macOS privacy controls.'
  );
}
