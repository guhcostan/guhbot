import { chatGuidHandle, isChatGuid, isDirectChatGuid, isPhoneLike, normalizeIdentifier } from './identifiers.js';

/**
 * The per-conversation opt-in.
 *
 * Nothing in this capability reads or sends without an entry here. The list is
 * deliberately the *whole* access model: there is no "read everything" mode and
 * no tool that widens the list on behalf of the model — `messages.addAllowed`
 * is a `person` RPC method, so it needs a device the user unlocked.
 *
 * An entry is a chat GUID or a handle. A one to one chat GUID and its handle
 * are two spellings of the same conversation, so allowing either allows both;
 * a group GUID has no handle and must be listed explicitly.
 */
export class AllowList {
  private raw: string[];
  private readonly keys = new Set<string>();

  constructor(entries: readonly string[] = []) {
    this.raw = [];
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      if (this.raw.some((existing) => normalizeIdentifier(existing) === normalizeIdentifier(trimmed))) continue;
      this.raw.push(trimmed);
    }
    this.reindex();
  }

  entries(): string[] {
    return [...this.raw];
  }

  size(): number {
    return this.raw.length;
  }

  /** True for an exact entry, a differently formatted phone number, or the
   * handle of an allowed one to one chat. */
  has(value: string): boolean {
    if (this.keys.has(normalizeIdentifier(value))) return true;
    const handle = chatGuidHandle(value);
    return handle !== null && this.keys.has(normalizeIdentifier(handle));
  }

  isConversationAllowed(conversation: {
    guid: string;
    identifier: string | null;
    handles: readonly string[];
  }): boolean {
    if (this.has(conversation.guid)) return true;
    if (conversation.identifier !== null && this.has(conversation.identifier)) return true;
    // Allowing a person must never open every group they are in: a group is
    // reachable only through its own GUID, which has to be listed explicitly.
    if (isChatGuid(conversation.guid) && !isDirectChatGuid(conversation.guid)) return false;
    return conversation.handles.some((handle) => this.has(handle));
  }

  /** Returns false when an equivalent entry was already present. */
  add(entry: string): boolean {
    const trimmed = entry.trim();
    if (trimmed.length === 0) return false;
    if (this.has(trimmed)) return false;
    this.raw.push(trimmed);
    this.reindex();
    return true;
  }

  remove(entry: string): boolean {
    const before = this.raw.length;
    this.raw = this.raw.filter((existing) => !this.matchesEntry(existing, entry));
    if (this.raw.length === before) return false;
    this.reindex();
    return true;
  }

  /**
   * The literal strings to compare against `chat.guid` in SQL.
   *
   * SQL compares text, so a phone number the user typed with spaces would never
   * match the digits-only form Apple stores; both spellings are included.
   */
  chatGuidCandidates(): string[] {
    return dedupe(this.raw.filter((entry) => isChatGuid(entry)));
  }

  /** Literal strings to compare against `handle.id` / `chat.chat_identifier`. */
  handleCandidates(): string[] {
    const candidates: string[] = [];
    for (const entry of this.raw) {
      if (isChatGuid(entry)) {
        const handle = chatGuidHandle(entry);
        if (handle !== null) candidates.push(handle);
        continue;
      }
      candidates.push(entry);
      if (isPhoneLike(entry)) {
        const digits = entry.replace(/[^0-9]/g, '');
        candidates.push(digits, `+${digits}`);
      }
    }
    return dedupe(candidates);
  }

  private matchesEntry(existing: string, candidate: string): boolean {
    if (normalizeIdentifier(existing) === normalizeIdentifier(candidate)) return true;
    const handle = chatGuidHandle(existing);
    return handle !== null && normalizeIdentifier(handle) === normalizeIdentifier(candidate);
  }

  private reindex(): void {
    this.keys.clear();
    for (const entry of this.raw) {
      this.keys.add(normalizeIdentifier(entry));
      const handle = chatGuidHandle(entry);
      if (handle !== null) this.keys.add(normalizeIdentifier(handle));
    }
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
