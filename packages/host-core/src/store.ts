import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  Agent,
  Approval,
  ApprovalKind,
  ApprovalStatus,
  Automation,
  AutomationTrigger,
  Device,
  DeviceClass,
  DevicePlatform,
  Entry,
  EntryKind,
  EntryRole,
  Group,
  McpServer,
  McpTransport,
  Routine,
  RoutineStep,
  Run,
  RunStatus,
  SecretMeta,
  Task,
  TaskStatus,
} from '@guhbot/protocol';
import { newId, nowIso } from './ids.js';

/**
 * Persistence.
 *
 * Deliberately SQLite via `node:sqlite`: no native module to rebuild, one file
 * to back up, and it runs identically on a laptop and in a container. The store
 * owns all SQL; nothing above this file writes a query.
 *
 * Conventions that matter:
 *  - Booleans are stored as INTEGER 0/1 and converted at the boundary.
 *  - Structured values are stored as JSON TEXT, never as a SQLite JSON type.
 *  - `entries.seq` is per-agent and allocated inside the same transaction as the
 *    insert, so concurrent runs on one agent cannot produce a duplicate or a gap.
 *    Clients rely on that to resync with `afterSeq`.
 */

const SCHEMA_VERSION = 1;

export interface StoreOptions {
  /** Directory holding `data.db`. Created if missing. */
  dataDir: string;
}

type Row = Record<string, string | number | bigint | null | Uint8Array>;

function bool(value: unknown): boolean {
  return value === 1 || value === 1n || value === true;
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  /** Directory for agent-produced artifacts, alongside the database. */
  readonly artifactsDir: string;

  constructor(options: StoreOptions) {
    this.dataDir = options.dataDir;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.artifactsDir = join(this.dataDir, 'artifacts');
    mkdirSync(this.artifactsDir, { recursive: true, mode: 0o700 });

    this.db = new DatabaseSync(join(this.dataDir, 'data.db'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Migrations
  // -------------------------------------------------------------------------

  private migrate(): void {
    // `meta` is read before any migration runs, so it cannot itself be part of a
    // migration. Create it unconditionally, then decide what still needs doing.
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

    const current = this.getMeta('schema_version');
    const version = current === null ? 0 : Number(current);
    if (version === SCHEMA_VERSION) return;
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `database schema is version ${version} but this build understands ${SCHEMA_VERSION}. ` +
          'Refusing to open: a newer host has already migrated this data directory.',
      );
    }

    this.db.exec('BEGIN');
    try {
      if (version < 1) this.applyV1();
      this.setMetaInternal('schema_version', String(SCHEMA_VERSION));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private applyV1(): void {
    this.db.exec(`
      CREATE TABLE agents (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        status            TEXT NOT NULL,
        instructions      TEXT NOT NULL DEFAULT '',
        model             TEXT,
        avatar_url        TEXT,
        hidden            INTEGER NOT NULL DEFAULT 0,
        drafting_disabled INTEGER NOT NULL DEFAULT 0,
        notify_on_updates INTEGER NOT NULL DEFAULT 1,
        unread_count      INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE TABLE groups (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE group_members (
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (group_id, agent_id)
      );

      CREATE TABLE entries (
        id         TEXT PRIMARY KEY,
        agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        run_id     TEXT,
        role       TEXT NOT NULL,
        kind       TEXT NOT NULL,
        content    TEXT NOT NULL,
        tool_name  TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (agent_id, seq)
      );
      CREATE INDEX idx_entries_agent_seq ON entries (agent_id, seq);

      CREATE TABLE runs (
        id              TEXT PRIMARY KEY,
        agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        status          TEXT NOT NULL,
        prompt_entry_id TEXT,
        error           TEXT,
        started_at      TEXT NOT NULL,
        ended_at        TEXT
      );
      CREATE INDEX idx_runs_agent_started ON runs (agent_id, started_at DESC);

      CREATE TABLE devices (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        platform     TEXT NOT NULL,
        class        TEXT NOT NULL,
        token_salt   BLOB NOT NULL,
        token_hash   BLOB NOT NULL,
        paired_at    TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at   TEXT
      );
      CREATE INDEX idx_devices_hash ON devices (token_hash);

      CREATE TABLE pairings (
        id         TEXT PRIMARY KEY,
        code_hash  TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        claimed_at TEXT,
        attempts   INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE approvals (
        id              TEXT PRIMARY KEY,
        agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        run_id          TEXT,
        kind            TEXT NOT NULL,
        status          TEXT NOT NULL,
        summary         TEXT NOT NULL,
        detail          TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL,
        expires_at      TEXT,
        resolved_at     TEXT,
        resolution_note TEXT
      );
      CREATE INDEX idx_approvals_status ON approvals (status, created_at DESC);

      CREATE TABLE secrets (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        scope      TEXT,
        sealed     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE mcp_servers (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        transport      TEXT NOT NULL,
        target         TEXT NOT NULL,
        auth_state     TEXT NOT NULL DEFAULT 'none',
        enabled        INTEGER NOT NULL DEFAULT 1,
        disabled_tools TEXT NOT NULL DEFAULT '[]',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE TABLE routines (
        id         TEXT PRIMARY KEY,
        agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        status     TEXT NOT NULL,
        steps      TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE automations (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        trigger     TEXT NOT NULL,
        cron        TEXT,
        prompt      TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT,
        last_run_at TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id         TEXT PRIMARY KEY,
        agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        status     TEXT NOT NULL,
        pinned     INTEGER NOT NULL DEFAULT 0,
        read       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // -------------------------------------------------------------------------
  // meta
  // -------------------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return row ? str(row['value']) : null;
  }

  setMeta(key: string, value: string): void {
    this.setMetaInternal(key, value);
  }

  private setMetaInternal(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** Stable per-data-directory host identity, minted on first use. */
  hostId(): string {
    const existing = this.getMeta('host_id');
    if (existing !== null) return existing;
    const id = newId('host');
    this.setMeta('host_id', id);
    return id;
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  private mapAgent(row: Row): Agent {
    return {
      id: str(row['id']),
      name: str(row['name']),
      status: str(row['status']) as Agent['status'],
      instructions: str(row['instructions']),
      model: nullableStr(row['model']),
      avatarUrl: nullableStr(row['avatar_url']),
      hidden: bool(row['hidden']),
      draftingDisabled: bool(row['drafting_disabled']),
      notifyOnUpdates: bool(row['notify_on_updates']),
      unreadCount: num(row['unread_count']),
      createdAt: str(row['created_at']),
      updatedAt: str(row['updated_at']),
    };
  }

  createAgent(input: { name: string; instructions?: string | undefined; model?: string | null | undefined }): Agent {
    const now = nowIso();
    const id = newId('ag');
    this.db
      .prepare(
        `INSERT INTO agents (id, name, status, instructions, model, hidden, drafting_disabled, notify_on_updates, unread_count, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, 0, 0, 1, 0, ?, ?)`,
      )
      .run(id, input.name, input.instructions ?? '', input.model ?? null, now, now);
    return this.getAgent(id)!;
  }

  getAgent(id: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapAgent(row) : null;
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all() as Row[];
    return rows.map((r) => this.mapAgent(r));
  }

  updateAgent(
    id: string,
    patch: {
      [K in 'name' | 'instructions' | 'model' | 'status' | 'hidden' | 'draftingDisabled' | 'notifyOnUpdates' | 'unreadCount']?: Agent[K] | undefined;
    },
  ): Agent | null {
    const existing = this.getAgent(id);
    if (!existing) return null;
    // Drop explicit `undefined` so a caller cannot blank a column by omission.
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Agent>;
    const next: Agent = { ...existing, ...defined, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE agents SET name = ?, status = ?, instructions = ?, model = ?, hidden = ?, drafting_disabled = ?, notify_on_updates = ?, unread_count = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.status,
        next.instructions,
        next.model,
        next.hidden ? 1 : 0,
        next.draftingDisabled ? 1 : 0,
        next.notifyOnUpdates ? 1 : 0,
        next.unreadCount,
        next.updatedAt,
        id,
      );
    return this.getAgent(id);
  }

  deleteAgents(ids: string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const before = this.db.prepare('SELECT COUNT(*) AS n FROM agents').get() as Row;
    this.db.prepare(`DELETE FROM agents WHERE id IN (${placeholders})`).run(...ids);
    const after = this.db.prepare('SELECT COUNT(*) AS n FROM agents').get() as Row;
    return num(before['n']) - num(after['n']);
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  private mapGroup(row: Row): Group {
    const members = this.db
      .prepare('SELECT agent_id FROM group_members WHERE group_id = ? ORDER BY position ASC')
      .all(str(row['id'])) as Row[];
    return {
      id: str(row['id']),
      name: str(row['name']),
      memberIds: members.map((m) => str(m['agent_id'])),
      createdAt: str(row['created_at']),
      updatedAt: str(row['updated_at']),
    };
  }

  createGroup(name: string, memberIds: string[]): Group {
    const id = newId('gr');
    const now = nowIso();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, now, now);
      this.setGroupMembersInternal(id, memberIds);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getGroup(id)!;
  }

  getGroup(id: string): Group | null {
    const row = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapGroup(row) : null;
  }

  listGroups(): Group[] {
    const rows = this.db.prepare('SELECT * FROM groups ORDER BY created_at ASC').all() as Row[];
    return rows.map((r) => this.mapGroup(r));
  }

  setGroupMembers(groupId: string, memberIds: string[]): Group | null {
    if (!this.getGroup(groupId)) return null;
    this.db.exec('BEGIN');
    try {
      this.setGroupMembersInternal(groupId, memberIds);
      this.db.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').run(nowIso(), groupId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getGroup(groupId);
  }

  private setGroupMembersInternal(groupId: string, memberIds: string[]): void {
    this.db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
    const insert = this.db.prepare('INSERT INTO group_members (group_id, agent_id, position) VALUES (?, ?, ?)');
    memberIds.forEach((agentId, index) => insert.run(groupId, agentId, index));
  }

  // -------------------------------------------------------------------------
  // Entries
  // -------------------------------------------------------------------------

  private mapEntry(row: Row): Entry {
    return {
      id: str(row['id']),
      agentId: str(row['agent_id']),
      seq: num(row['seq']),
      runId: nullableStr(row['run_id']),
      role: str(row['role']) as EntryRole,
      kind: str(row['kind']) as EntryKind,
      content: str(row['content']),
      toolName: nullableStr(row['tool_name']),
      createdAt: str(row['created_at']),
    };
  }

  /**
   * Append an entry, allocating the next `seq` for the agent.
   *
   * The max+1 read and the insert share one transaction. `BEGIN IMMEDIATE`
   * takes the write lock up front, which is what prevents two runs on the same
   * agent from both reading the same max.
   */
  appendEntry(input: {
    agentId: string;
    role: EntryRole;
    kind: EntryKind;
    content: string;
    runId?: string | null;
    toolName?: string | null;
  }): Entry {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM entries WHERE agent_id = ?')
        .get(input.agentId) as Row;
      const seq = num(row['maxSeq']) + 1;
      const id = newId('en');
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO entries (id, agent_id, seq, run_id, role, kind, content, tool_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.agentId, seq, input.runId ?? null, input.role, input.kind, input.content, input.toolName ?? null, now);
      this.db.exec('COMMIT');
      return {
        id,
        agentId: input.agentId,
        seq,
        runId: input.runId ?? null,
        role: input.role,
        kind: input.kind,
        content: input.content,
        toolName: input.toolName ?? null,
        createdAt: now,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Entries with `seq > afterSeq`, oldest first. Powers client resync. */
  listEntries(agentId: string, options: { afterSeq?: number; limit: number; beforeSeq?: number }): Entry[] {
    const after = options.afterSeq ?? -1;
    if (options.beforeSeq !== undefined) {
      const rows = this.db
        .prepare('SELECT * FROM entries WHERE agent_id = ? AND seq > ? AND seq < ? ORDER BY seq ASC LIMIT ?')
        .all(agentId, after, options.beforeSeq, options.limit) as Row[];
      return rows.map((r) => this.mapEntry(r));
    }
    const rows = this.db
      .prepare('SELECT * FROM entries WHERE agent_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(agentId, after, options.limit) as Row[];
    return rows.map((r) => this.mapEntry(r));
  }

  /** The newest `limit` entries, returned oldest-first for direct rendering. */
  listRecentEntries(agentId: string, limit: number): Entry[] {
    const rows = this.db
      .prepare('SELECT * FROM entries WHERE agent_id = ? ORDER BY seq DESC LIMIT ?')
      .all(agentId, limit) as Row[];
    return rows.map((r) => this.mapEntry(r)).reverse();
  }

  countEntries(agentId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM entries WHERE agent_id = ?').get(agentId) as Row;
    return num(row['n']);
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  private mapRun(row: Row): Run {
    return {
      id: str(row['id']),
      agentId: str(row['agent_id']),
      status: str(row['status']) as RunStatus,
      promptEntryId: nullableStr(row['prompt_entry_id']),
      error: nullableStr(row['error']),
      startedAt: str(row['started_at']),
      endedAt: nullableStr(row['ended_at']),
    };
  }

  createRun(agentId: string, promptEntryId: string | null): Run {
    const id = newId('rn');
    const now = nowIso();
    this.db
      .prepare('INSERT INTO runs (id, agent_id, status, prompt_entry_id, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, agentId, 'queued', promptEntryId, now);
    return this.getRun(id)!;
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapRun(row) : null;
  }

  updateRun(id: string, patch: { status?: RunStatus; error?: string | null; endedAt?: string | null }): Run | null {
    const existing = this.getRun(id);
    if (!existing) return null;
    const next: Run = {
      ...existing,
      status: patch.status ?? existing.status,
      error: patch.error === undefined ? existing.error : patch.error,
      endedAt: patch.endedAt === undefined ? existing.endedAt : patch.endedAt,
    };
    this.db
      .prepare('UPDATE runs SET status = ?, error = ?, ended_at = ? WHERE id = ?')
      .run(next.status, next.error, next.endedAt, id);
    return this.getRun(id);
  }

  listRuns(options: { agentId?: string; limit: number }): Run[] {
    if (options.agentId !== undefined) {
      const rows = this.db
        .prepare('SELECT * FROM runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?')
        .all(options.agentId, options.limit) as Row[];
      return rows.map((r) => this.mapRun(r));
    }
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(options.limit) as Row[];
    return rows.map((r) => this.mapRun(r));
  }

  /** Runs left mid-flight by a previous process. Used at boot to fail them cleanly. */
  listUnfinishedRuns(): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE status IN ('queued','running','waiting-approval')")
      .all() as Row[];
    return rows.map((r) => this.mapRun(r));
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  private mapDevice(row: Row): Device {
    return {
      id: str(row['id']),
      name: str(row['name']),
      platform: str(row['platform']) as DevicePlatform,
      class: str(row['class']) as DeviceClass,
      pairedAt: str(row['paired_at']),
      lastSeenAt: nullableStr(row['last_seen_at']),
      revokedAt: nullableStr(row['revoked_at']),
    };
  }

  createDevice(input: {
    name: string;
    platform: DevicePlatform;
    deviceClass: DeviceClass;
    tokenSalt: Buffer;
    tokenHash: Buffer;
  }): Device {
    const id = newId('dv');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO devices (id, name, platform, class, token_salt, token_hash, paired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.platform, input.deviceClass, input.tokenSalt, input.tokenHash, now);
    return this.getDevice(id)!;
  }

  getDevice(id: string): Device | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapDevice(row) : null;
  }

  listDevices(): Device[] {
    const rows = this.db.prepare('SELECT * FROM devices ORDER BY paired_at ASC').all() as Row[];
    return rows.map((r) => this.mapDevice(r));
  }

  /** Look up a device by raw token. Returns null when unknown or revoked. */
  findDeviceByToken(token: string, verify: (token: string, salt: Buffer, expected: Buffer) => boolean): Device | null {
    const rows = this.db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL').all() as Row[];
    for (const row of rows) {
      const salt = row['token_salt'];
      const hash = row['token_hash'];
      if (!(salt instanceof Uint8Array) || !(hash instanceof Uint8Array)) continue;
      if (verify(token, Buffer.from(salt), Buffer.from(hash))) return this.mapDevice(row);
    }
    return null;
  }

  touchDevice(id: string): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(nowIso(), id);
  }

  setDeviceClass(id: string, deviceClass: DeviceClass): Device | null {
    this.db.prepare('UPDATE devices SET class = ? WHERE id = ?').run(deviceClass, id);
    return this.getDevice(id);
  }

  revokeDevice(id: string): boolean {
    const info = this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), id);
    return num(info.changes) > 0;
  }

  // -------------------------------------------------------------------------
  // Pairings
  // -------------------------------------------------------------------------

  createPairing(codeHash: string, expiresAt: string): string {
    const id = newId('pr');
    this.db
      .prepare('INSERT INTO pairings (id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, codeHash, nowIso(), expiresAt);
    return id;
  }

  /**
   * Redeem a pairing. Returns the pairing id on success.
   *
   * Increments `attempts` on every call and refuses once a code has been tried
   * too many times, which is what keeps an 8-digit code from being brute-forced
   * by a device already on the network.
   */
  claimPairing(pairingId: string, codeHash: string, maxAttempts = 10): { ok: true } | { ok: false; reason: 'unknown' | 'expired' | 'claimed' | 'too-many-attempts' } {
    const row = this.db.prepare('SELECT * FROM pairings WHERE id = ?').get(pairingId) as Row | undefined;
    if (!row) return { ok: false, reason: 'unknown' };
    if (row['claimed_at'] !== null && row['claimed_at'] !== undefined) return { ok: false, reason: 'claimed' };
    if (Date.parse(str(row['expires_at'])) < Date.now()) return { ok: false, reason: 'expired' };

    const attempts = num(row['attempts']);
    if (attempts >= maxAttempts) return { ok: false, reason: 'too-many-attempts' };

    if (str(row['code_hash']) !== codeHash) {
      this.db.prepare('UPDATE pairings SET attempts = attempts + 1 WHERE id = ?').run(pairingId);
      return { ok: false, reason: 'unknown' };
    }

    this.db.prepare('UPDATE pairings SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL').run(nowIso(), pairingId);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  private mapApproval(row: Row): Approval {
    return {
      id: str(row['id']),
      agentId: str(row['agent_id']),
      runId: nullableStr(row['run_id']),
      kind: str(row['kind']) as ApprovalKind,
      status: str(row['status']) as ApprovalStatus,
      summary: str(row['summary']),
      detail: str(row['detail']),
      createdAt: str(row['created_at']),
      expiresAt: nullableStr(row['expires_at']),
      resolvedAt: nullableStr(row['resolved_at']),
      resolutionNote: nullableStr(row['resolution_note']),
    };
  }

  createApproval(input: {
    agentId: string;
    runId: string | null;
    kind: ApprovalKind;
    summary: string;
    detail: string;
    ttlSeconds: number | null;
  }): Approval {
    const id = newId('ap');
    const now = nowIso();
    const expiresAt = input.ttlSeconds === null ? null : new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO approvals (id, agent_id, run_id, kind, status, summary, detail, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(id, input.agentId, input.runId, input.kind, input.summary, input.detail, now, expiresAt);
    return this.getApproval(id)!;
  }

  getApproval(id: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapApproval(row) : null;
  }

  listApprovals(options: { agentId?: string; status: 'pending' | 'resolved' }): Approval[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.status === 'pending') {
      clauses.push("status = 'pending'");
    } else {
      clauses.push("status IN ('granted','denied','expired','cancelled')");
    }
    if (options.agentId !== undefined) {
      clauses.push('agent_id = ?');
      params.push(options.agentId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM approvals WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 200`)
      .all(...params) as Row[];
    return rows.map((r) => this.mapApproval(r));
  }

  resolveApproval(id: string, granted: boolean, note: string | null): Approval | null {
    const existing = this.getApproval(id);
    if (!existing || existing.status !== 'pending') return existing;
    // A pending request past its deadline is expired, not granted — resolving at
    // the last moment must not silently resurrect a stale request.
    const expired = existing.expiresAt !== null && Date.parse(existing.expiresAt) < Date.now();
    const status: ApprovalStatus = expired ? 'expired' : granted ? 'granted' : 'denied';
    this.db
      .prepare('UPDATE approvals SET status = ?, resolved_at = ?, resolution_note = ? WHERE id = ?')
      .run(status, nowIso(), note, id);
    return this.getApproval(id);
  }

  expireStaleApprovals(): number {
    const info = this.db
      .prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?")
      .run(nowIso(), nowIso());
    return num(info.changes);
  }

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------

  private mapSecret(row: Row): SecretMeta {
    return {
      id: str(row['id']),
      name: str(row['name']),
      scope: nullableStr(row['scope']),
      createdAt: str(row['created_at']),
      updatedAt: str(row['updated_at']),
    };
  }

  /** Insert or replace by name. Returns metadata only — never the value. */
  putSecret(name: string, sealed: string, scope: string | null): SecretMeta {
    const now = nowIso();
    const existing = this.db.prepare('SELECT * FROM secrets WHERE name = ?').get(name) as Row | undefined;
    if (existing) {
      this.db.prepare('UPDATE secrets SET sealed = ?, scope = ?, updated_at = ? WHERE name = ?').run(sealed, scope, now, name);
      return this.mapSecret(this.db.prepare('SELECT * FROM secrets WHERE name = ?').get(name) as Row);
    }
    const id = newId('sec');
    this.db
      .prepare('INSERT INTO secrets (id, name, scope, sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, scope, sealed, now, now);
    return this.mapSecret(this.db.prepare('SELECT * FROM secrets WHERE id = ?').get(id) as Row);
  }

  listSecrets(): SecretMeta[] {
    const rows = this.db.prepare('SELECT * FROM secrets ORDER BY name ASC').all() as Row[];
    return rows.map((r) => this.mapSecret(r));
  }

  deleteSecret(id: string): boolean {
    const info = this.db.prepare('DELETE FROM secrets WHERE id = ?').run(id);
    return num(info.changes) > 0;
  }

  /**
   * Read a sealed value. This is the ONLY method that returns a secret's
   * contents, it returns the ciphertext rather than the plaintext, and it is
   * intentionally not reachable from the RPC layer.
   */
  readSealedSecret(name: string): string | null {
    const row = this.db.prepare('SELECT sealed FROM secrets WHERE name = ?').get(name) as Row | undefined;
    return row ? str(row['sealed']) : null;
  }

  // -------------------------------------------------------------------------
  // MCP servers
  // -------------------------------------------------------------------------

  private mapMcpServer(row: Row): McpServer {
    let disabledTools: string[] = [];
    try {
      const parsed = JSON.parse(str(row['disabled_tools']));
      if (Array.isArray(parsed)) disabledTools = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      disabledTools = [];
    }
    return {
      id: str(row['id']),
      name: str(row['name']),
      transport: str(row['transport']) as McpTransport,
      target: str(row['target']),
      authState: str(row['auth_state']) as McpServer['authState'],
      enabled: bool(row['enabled']),
      disabledTools,
      createdAt: str(row['created_at']),
      updatedAt: str(row['updated_at']),
    };
  }

  createMcpServer(input: { name: string; transport: McpTransport; target: string }): McpServer {
    const id = newId('mcp');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO mcp_servers (id, name, transport, target, auth_state, enabled, disabled_tools, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'none', 1, '[]', ?, ?)`,
      )
      .run(id, input.name, input.transport, input.target, now, now);
    return this.getMcpServer(id)!;
  }

  getMcpServer(id: string): McpServer | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapMcpServer(row) : null;
  }

  listMcpServers(): McpServer[] {
    const rows = this.db.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC').all() as Row[];
    return rows.map((r) => this.mapMcpServer(r));
  }

  setMcpDisabledTools(id: string, disabledTools: string[]): McpServer | null {
    this.db
      .prepare('UPDATE mcp_servers SET disabled_tools = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(disabledTools), nowIso(), id);
    return this.getMcpServer(id);
  }

  removeMcpServer(id: string): boolean {
    const info = this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    return num(info.changes) > 0;
  }

  // -------------------------------------------------------------------------
  // Routines
  // -------------------------------------------------------------------------

  private mapRoutine(row: Row): Routine {
    let steps: RoutineStep[] = [];
    try {
      const parsed = JSON.parse(str(row['steps']));
      if (Array.isArray(parsed)) steps = parsed as RoutineStep[];
    } catch {
      steps = [];
    }
    return {
      id: str(row['id']),
      agentId: str(row['agent_id']),
      name: str(row['name']),
      status: str(row['status']) as Routine['status'],
      steps,
      createdAt: str(row['created_at']),
      updatedAt: str(row['updated_at']),
    };
  }

  createRoutine(agentId: string, name: string): Routine {
    const id = newId('rt');
    const now = nowIso();
    this.db
      .prepare("INSERT INTO routines (id, agent_id, name, status, steps, created_at, updated_at) VALUES (?, ?, ?, 'recording', '[]', ?, ?)")
      .run(id, agentId, name, now, now);
    return this.getRoutine(id)!;
  }

  getRoutine(id: string): Routine | null {
    const row = this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapRoutine(row) : null;
  }

  listRoutines(agentId?: string): Routine[] {
    const rows =
      agentId === undefined
        ? (this.db.prepare('SELECT * FROM routines ORDER BY created_at DESC').all() as Row[])
        : (this.db.prepare('SELECT * FROM routines WHERE agent_id = ? ORDER BY created_at DESC').all(agentId) as Row[]);
    return rows.map((r) => this.mapRoutine(r));
  }

  appendRoutineStep(routineId: string, step: RoutineStep): Routine | null {
    const routine = this.getRoutine(routineId);
    if (!routine) return null;
    if (routine.status !== 'recording') return routine;
    const steps = [...routine.steps, step];
    this.db.prepare('UPDATE routines SET steps = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(steps), nowIso(), routineId);
    return this.getRoutine(routineId);
  }

  finishRoutine(routineId: string, status: Routine['status']): Routine | null {
    this.db.prepare('UPDATE routines SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), routineId);
    return this.getRoutine(routineId);
  }

  // -------------------------------------------------------------------------
  // Automations
  // -------------------------------------------------------------------------

  private mapAutomation(row: Row): Automation {
    return {
      id: str(row['id']),
      agentId: str(row['agent_id']),
      name: str(row['name']),
      trigger: str(row['trigger']) as AutomationTrigger,
      cron: nullableStr(row['cron']),
      prompt: str(row['prompt']),
      enabled: bool(row['enabled']),
      nextRunAt: nullableStr(row['next_run_at']),
      lastRunAt: nullableStr(row['last_run_at']),
      createdAt: str(row['created_at']),
      updatedAt: str(row['updated_at']),
    };
  }

  createAutomation(input: {
    agentId: string;
    name: string;
    trigger: AutomationTrigger;
    cron: string | null;
    prompt: string;
  }): Automation {
    const id = newId('au');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO automations (id, agent_id, name, trigger, cron, prompt, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, input.agentId, input.name, input.trigger, input.cron, input.prompt, now, now);
    return this.getAutomation(id)!;
  }

  getAutomation(id: string): Automation | null {
    const row = this.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapAutomation(row) : null;
  }

  listAutomations(agentId?: string): Automation[] {
    const rows =
      agentId === undefined
        ? (this.db.prepare('SELECT * FROM automations ORDER BY created_at DESC').all() as Row[])
        : (this.db.prepare('SELECT * FROM automations WHERE agent_id = ? ORDER BY created_at DESC').all(agentId) as Row[]);
    return rows.map((r) => this.mapAutomation(r));
  }

  setAutomationEnabled(id: string, enabled: boolean): Automation | null {
    this.db.prepare('UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, nowIso(), id);
    return this.getAutomation(id);
  }

  markAutomationRun(id: string): void {
    this.db.prepare('UPDATE automations SET last_run_at = ? WHERE id = ?').run(nowIso(), id);
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  private mapTask(row: Row): Task {
    return {
      id: str(row['id']),
      agentId: str(row['agent_id']),
      title: str(row['title']),
      status: str(row['status']) as TaskStatus,
      pinned: bool(row['pinned']),
      read: bool(row['read']),
      createdAt: str(row['created_at']),
      updatedAt: str(row['updated_at']),
    };
  }

  createTask(agentId: string, title: string): Task {
    const id = newId('tk');
    const now = nowIso();
    this.db
      .prepare("INSERT INTO tasks (id, agent_id, title, status, pinned, read, created_at, updated_at) VALUES (?, ?, ?, 'open', 0, 0, ?, ?)")
      .run(id, agentId, title, now, now);
    return this.getTask(id)!;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapTask(row) : null;
  }

  listTasks(agentId: string): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at ASC').all(agentId) as Row[];
    return rows.map((r) => this.mapTask(r));
  }

  setTaskStatus(id: string, status: TaskStatus): Task | null {
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
    return this.getTask(id);
  }
}
