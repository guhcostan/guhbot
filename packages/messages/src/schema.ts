import type { DatabaseSync } from 'node:sqlite';

/**
 * Runtime introspection of Apple's schema.
 *
 * `chat.db` is Apple's file, not ours: column sets differ between macOS
 * releases, and an unfamiliar database is a normal condition rather than a bug.
 * Every query in this package is therefore written against a schema report
 * produced here, and a column that does not exist is selected as NULL instead
 * of failing the whole read.
 *
 * `required` is the floor below which no honest read is possible. Everything
 * else is optional and buys a line in `effects`, which travels with the result
 * so the model and the user can see what was degraded.
 */

const WATCHED_TABLES = [
  'message',
  'chat',
  'chat_message_join',
  'handle',
  'chat_handle_join',
  'attachment',
  'message_attachment_join',
] as const;

export type WatchedTable = (typeof WATCHED_TABLES)[number];

const REQUIRED: readonly (readonly [WatchedTable, string])[] = [
  ['message', 'rowid'],
  ['message', 'date'],
  ['chat_message_join', 'message_id'],
  ['chat_message_join', 'chat_id'],
  ['chat', 'rowid'],
  ['chat', 'guid'],
];

/** Optional columns this package knows how to use, reported when absent. */
const OPTIONAL: readonly (readonly [WatchedTable, string])[] = [
  ['message', 'guid'],
  ['message', 'text'],
  ['message', 'attributedBody'],
  ['message', 'is_from_me'],
  ['message', 'handle_id'],
  ['message', 'service'],
  ['message', 'associated_message_type'],
  ['message', 'item_type'],
  ['handle', 'id'],
  ['chat', 'display_name'],
  ['chat', 'chat_identifier'],
  ['chat', 'service_name'],
  ['chat_handle_join', 'chat_id'],
  ['chat_handle_join', 'handle_id'],
  ['message_attachment_join', 'message_id'],
  ['message_attachment_join', 'attachment_id'],
  ['attachment', 'filename'],
  ['attachment', 'mime_type'],
  ['attachment', 'total_bytes'],
];

export interface Degradation {
  /** Required tables or columns that are absent; reads cannot proceed. */
  requiredMissing: string[];
  missingTables: string[];
  missingColumns: string[];
  effects: string[];
}

export interface MessagesSchema extends Degradation {
  /** False when a required table or column is absent; reads must be refused. */
  ok: boolean;
  requiredMissing: string[];
  has(table: WatchedTable, column: string): boolean;
  hasTable(table: WatchedTable): boolean;
  /**
   * `SELECT` expression for a column, or `NULL` when the column is absent.
   * `tableAlias` is the alias the query uses for that table.
   */
  column(table: WatchedTable, column: string, alias: string, tableAlias?: string): string;
}

export function readSchema(db: DatabaseSync): MessagesSchema {
  const present = new Set<string>();
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all();
  for (const row of rows) {
    const name = row['name'];
    if (typeof name === 'string') present.add(name.toLowerCase());
  }

  const columns = new Map<string, Set<string>>();
  for (const table of WATCHED_TABLES) {
    const set = new Set<string>();
    if (present.has(table)) {
      // The table name comes from the constant list above, never from input.
      const info = db.prepare(`PRAGMA table_info(${table})`).all();
      for (const column of info) {
        const name = column['name'];
        if (typeof name === 'string') set.add(name.toLowerCase());
      }
    }
    columns.set(table, set);
  }

  const hasTable = (table: WatchedTable): boolean => present.has(table);
  const has = (table: WatchedTable, column: string): boolean =>
    columns.get(table)?.has(column.toLowerCase()) ?? false;

  const missingTables = WATCHED_TABLES.filter((table) => !present.has(table));
  const requiredMissing: string[] = [];
  for (const [table, column] of REQUIRED) {
    if (!present.has(table)) requiredMissing.push(table);
    else if (!has(table, column)) requiredMissing.push(`${table}.${column}`);
  }

  const missingColumns = OPTIONAL.filter(
    ([table, column]) => present.has(table) && !has(table, column),
  ).map(([table, column]) => `${table}.${column}`);

  const effects: string[] = [];
  if (requiredMissing.length > 0) {
    effects.push(`the database is missing ${requiredMissing.join(', ')}, so messages cannot be read at all`);
  }
  const hasTextColumn = has('message', 'text');
  const hasBodyColumn = has('message', 'attributedBody');
  if (!hasTextColumn && !hasBodyColumn) {
    effects.push('message bodies are unavailable: neither message.text nor message.attributedBody exists');
  } else if (!hasTextColumn) {
    effects.push('message.text is missing, so bodies are decoded from attributedBody and fall back to a marker');
  } else if (!hasBodyColumn) {
    effects.push('message.attributedBody is missing, so messages whose text is NULL have no readable body');
  }
  if (!has('message', 'is_from_me')) {
    effects.push('message.is_from_me is missing, so message direction is reported as unknown');
  }
  if (!has('message', 'handle_id') || !has('handle', 'id')) {
    effects.push('sender handles are unavailable, so messages show no sender');
  }
  if (!has('message', 'guid')) {
    effects.push('message.guid is missing, so messages carry no stable identifier');
  }
  if (!has('message', 'associated_message_type')) {
    effects.push('message.associated_message_type is missing, so tapback reactions may appear as messages');
  }
  if (!has('chat', 'display_name')) {
    effects.push('chat.display_name is missing, so conversations have no display name');
  }
  if (!has('chat', 'chat_identifier') && !hasTable('chat_handle_join')) {
    effects.push('conversations can only be addressed by chat GUID in this schema');
  }
  if (!has('chat', 'service_name')) {
    effects.push('chat.service_name is missing, so the service of a conversation is unknown');
  }
  if (!attachmentTablesUsable(has, hasTable)) {
    effects.push('attachment metadata is unavailable in this schema');
  }

  return {
    ok: requiredMissing.length === 0,
    requiredMissing,
    missingTables,
    missingColumns,
    effects,
    has,
    hasTable,
    column: (table, column, alias, tableAlias) =>
      has(table, column) ? `${tableAlias ?? table}.${column} AS ${alias}` : `NULL AS ${alias}`,
  };
}

function attachmentTablesUsable(
  has: (table: WatchedTable, column: string) => boolean,
  hasTable: (table: WatchedTable) => boolean,
): boolean {
  return (
    hasTable('attachment') &&
    hasTable('message_attachment_join') &&
    has('message_attachment_join', 'message_id') &&
    has('message_attachment_join', 'attachment_id') &&
    has('attachment', 'rowid')
  );
}

/** `Degradation` for a successful read, or null when nothing was degraded. */
export function degradationOf(schema: MessagesSchema): Degradation | null {
  const degraded: Degradation = {
    requiredMissing: schema.requiredMissing,
    missingTables: schema.missingTables,
    missingColumns: schema.missingColumns,
    effects: schema.effects,
  };
  if (
    degraded.requiredMissing.length === 0 &&
    degraded.missingTables.length === 0 &&
    degraded.missingColumns.length === 0 &&
    degraded.effects.length === 0
  ) {
    return null;
  }
  return degraded;
}
