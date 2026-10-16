import type { ToolDefinition } from '@guhbot/agent';
import type { AllowList } from './allow-list.js';
import { buildSendScript, type AppleScriptService } from './applescript.js';
import type { ChatDatabase, ChatTarget, MessageView } from './chat-db.js';
import { isChatGuid } from './identifiers.js';
import type { AppleScriptRunner } from './options.js';
import type { Degradation } from './schema.js';

/**
 * The model-facing surface.
 *
 * Reads are shaped here and nowhere else: no `ROWID`, no raw column, no
 * attachment bytes, no other conversation's metadata ever reaches a result. A
 * conversation outside the allow list is refused with the same message whether
 * or not it exists, so a refusal cannot be used to enumerate the database.
 */

export interface MessagesToolRuntime {
  readonly allowList: AllowList;
  readonly database: ChatDatabase;
  readonly runAppleScript: AppleScriptRunner;
  readonly service: AppleScriptService;
  readonly osascriptPath: string;
  readonly timeoutMs: number;
  /** Bounded, content-free diagnostic surfaced by `messages.status`; null clears it. */
  readonly recordDiagnostic: (message: string | null) => void;
}

const LIST_CONVERSATIONS = 'messages_list_conversations';
const READ = 'messages_read';
const PREVIEW_SEND = 'messages_preview_send';
const SEND = 'messages_send';

const DEFAULT_CONVERSATION_LIMIT = 20;
const DEFAULT_MESSAGE_LIMIT = 25;
const DEFAULT_MAX_BYTES = 64_000;
const MAX_TEXT_CHARS = 4_000;
const MAX_PARTICIPANTS = 25;

const SERVICES: readonly AppleScriptService[] = ['auto', 'imessage', 'sms'];

export function buildMessagesTools(runtime: MessagesToolRuntime): ToolDefinition[] {
  return [listConversationsTool(runtime), readTool(runtime), previewSendTool(runtime), sendTool(runtime)];
}

function listConversationsTool(runtime: MessagesToolRuntime): ToolDefinition {
  return {
    name: LIST_CONVERSATIONS,
    description:
      'List recent macOS Messages conversations this host is allowed to read, newest first. ' +
      'Only conversations on the host Messages allow list are returned. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many conversations to return (default 20).' },
      },
      additionalProperties: false,
    },
    requiresApproval: false,
    execute: async (rawArgs) => {
      const args = asObject(rawArgs, LIST_CONVERSATIONS);
      rejectUnknown(args, ['limit'], LIST_CONVERSATIONS);
      const limit = optionalInteger(args, 'limit', LIST_CONVERSATIONS, 1, 50, DEFAULT_CONVERSATION_LIMIT);

      const availability = runtime.database.availability();
      if (!availability.ok) return degradedJson(LIST_CONVERSATIONS, availability.degraded);

      const conversations = runtime.database.listConversations(runtime.allowList, limit);
      runtime.recordDiagnostic(null);
      return json({
        ok: true,
        conversations,
        ...(availability.degraded ? { degraded: availability.degraded } : {}),
      });
    },
  };
}

function readTool(runtime: MessagesToolRuntime): ToolDefinition {
  return {
    name: READ,
    description:
      'Read recent messages from one macOS Messages conversation you are allowed to read. ' +
      'Pass a conversation GUID from messages_list_conversations, or a phone number or email handle. ' +
      'Returns oldest-first, newest page last; pass nextCursor back as "before" for the previous page. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        conversation: {
          type: 'string',
          description: 'Chat GUID from messages_list_conversations, or a handle such as "+15551234567" or "person@example.com".',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum messages to return (default 25).' },
        before: {
          type: 'string',
          description: 'ISO-8601 timestamp from nextCursor; returns messages strictly older than it.',
        },
        max_bytes: { type: 'integer', minimum: 1000, maximum: 262_144, description: 'Byte budget for the result (default 64000).' },
      },
      required: ['conversation'],
      additionalProperties: false,
    },
    requiresApproval: false,
    execute: async (rawArgs) => {
      const args = asObject(rawArgs, READ);
      rejectUnknown(args, ['conversation', 'limit', 'before', 'max_bytes'], READ);
      const conversation = requireString(args, 'conversation', READ, 512);
      const limit = optionalInteger(args, 'limit', READ, 1, 100, DEFAULT_MESSAGE_LIMIT);
      const before = optionalString(args, 'before', READ, 64);
      // A cursor we cannot parse would silently fall back to the newest page,
      // which reads as "these are older messages" when they are not.
      if (before !== null && Number.isNaN(Date.parse(before))) {
        throw new Error(`${READ}: "before" must be an ISO-8601 timestamp from a previous nextCursor`);
      }
      const maxBytes = optionalInteger(args, 'max_bytes', READ, 1_000, 262_144, DEFAULT_MAX_BYTES);

      const availability = runtime.database.availability();
      if (!availability.ok) return degradedJson(READ, availability.degraded);

      const chat = resolveAllowedChat(runtime, conversation);
      const page = runtime.database.readMessages(chat, { limit, before });
      const { kept, truncated } = applyByteBudget(page.messages, maxBytes);
      // The query returns newest first; a transcript reads oldest first, and the
      // cursor has to be the oldest message actually returned.
      const messages = kept.reverse();
      const oldest = messages[0];
      runtime.recordDiagnostic(null);

      return json({
        ok: true,
        conversation: {
          guid: chat.guid,
          name: chat.name,
          service: chat.service,
          identifier: chat.identifier,
          // A large group would otherwise dump every member's handle into the
          // transcript of an unrelated conversation.
          handles: chat.handles.slice(0, MAX_PARTICIPANTS),
        },
        messages,
        count: messages.length,
        truncated,
        nextCursor: (page.hasMore || truncated) && oldest ? oldest.at : null,
        ...(availability.degraded ? { degraded: availability.degraded } : {}),
      });
    },
  };
}

function previewSendTool(runtime: MessagesToolRuntime): ToolDefinition {
  return {
    name: PREVIEW_SEND,
    description:
      'Show exactly what messages_send would deliver, without sending anything. ' +
      'Use it to show the user the recipient and the final text before asking for approval.',
    parameters: sendParameters(),
    requiresApproval: false,
    execute: async (rawArgs) => {
      const request = parseSendRequest(rawArgs, PREVIEW_SEND);
      assertAllowedRecipient(runtime, request.recipient);
      // Building the script here proves the send would be well formed, so the
      // preview and the send cannot disagree about escaping.
      buildSendScript(request);
      return json({
        preview: true,
        recipient: request.recipient,
        service: request.service,
        text: request.text,
        textBytes: Buffer.byteLength(request.text, 'utf8'),
        note: 'Nothing was sent. Call messages_send with these exact values to deliver it.',
      });
    },
  };
}

function sendTool(runtime: MessagesToolRuntime): ToolDefinition {
  return {
    name: SEND,
    description:
      'Send an iMessage or SMS as the user. Always requires user approval: the approval request carries the ' +
      'recipient and the exact text. Refuses any recipient outside the host Messages allow list.',
    parameters: sendParameters(),
    // Non-negotiable. The approval is what turns "the model decided to message
    // someone" into a decision a human made; there is no option to skip it.
    requiresApproval: true,
    execute: async (rawArgs, context) => {
      const request = parseSendRequest(rawArgs, SEND);
      assertAllowedRecipient(runtime, request.recipient);

      const result = await runtime.runAppleScript(buildSendScript(request), {
        signal: context.signal,
        timeoutMs: runtime.timeoutMs,
        osascriptPath: runtime.osascriptPath,
      });

      if (!result.ok) {
        const detail = redact(
          result.stderr.trim().length > 0 ? result.stderr.trim() : 'no output',
          [request.text, request.recipient],
        ).slice(0, 400);
        const reason =
          result.failure === 'not-found'
            ? `osascript was not found at ${runtime.osascriptPath}`
            : result.failure === 'timeout'
              ? `osascript did not finish within ${runtime.timeoutMs} ms, so the message may or may not have been sent`
              : result.failure === 'aborted'
                ? 'the run was cancelled before osascript returned, so the message may or may not have been sent'
                : `Messages.app rejected the send: ${detail}`;
        runtime.recordDiagnostic(`messages_send failed (${result.failure ?? 'failed'}): ${reason}`);
        throw new Error(reason);
      }

      runtime.recordDiagnostic(null);
      return json({
        sent: true,
        recipient: request.recipient,
        service: reportedService(result.stdout, request.service),
        sentAt: new Date().toISOString(),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Send plumbing
// ---------------------------------------------------------------------------

function sendParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      recipient: {
        type: 'string',
        description: 'Handle ("+15551234567", "person@example.com") or chat GUID. Must be on the host Messages allow list.',
      },
      text: { type: 'string', description: 'Exact message body to deliver.' },
      service: { type: 'string', enum: [...SERVICES], description: 'Transport; "auto" tries iMessage then SMS (default).' },
    },
    required: ['recipient', 'text'],
    additionalProperties: false,
  };
}

interface SendRequest {
  recipient: string;
  text: string;
  service: AppleScriptService;
}

function parseSendRequest(rawArgs: unknown, tool: string): SendRequest {
  const args = asObject(rawArgs, tool);
  rejectUnknown(args, ['recipient', 'text', 'service'], tool);
  const recipient = requireString(args, 'recipient', tool, 256);
  const text = requireString(args, 'text', tool, 20_000);
  const rawService = args['service'];
  let service: AppleScriptService = 'auto';
  if (rawService !== undefined) {
    if (typeof rawService !== 'string' || !SERVICES.includes(rawService as AppleScriptService)) {
      throw new Error(`${tool}: "service" must be one of ${SERVICES.join(', ')}`);
    }
    service = rawService as AppleScriptService;
  }

  if (/\s/.test(recipient)) {
    throw new Error(`${tool}: "recipient" must be a single handle or chat GUID with no whitespace`);
  }
  if (!looksSendable(recipient)) {
    throw new Error(
      `${tool}: "recipient" must be a phone number, an email handle or a Messages chat GUID — got ${JSON.stringify(recipient)}`,
    );
  }
  return { recipient, text, service };
}

function looksSendable(recipient: string): boolean {
  if (isChatGuid(recipient)) return true;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) return true;
  return /^\+?[0-9][0-9\-\s().]{3,}$/.test(recipient);
}

function assertAllowedRecipient(runtime: MessagesToolRuntime, recipient: string): void {
  if (runtime.allowList.has(recipient)) return;
  // Deliberately identical whether or not the conversation exists: a refusal
  // must not become a way to ask the database who the user talks to.
  throw new Error(
    `refused: ${JSON.stringify(recipient)} is not on this host's Messages allow list, so this capability will not ` +
      'message it. The user can allow it with messages.addAllowed.',
  );
}

function reportedService(stdout: string, requested: AppleScriptService): string {
  const reported = stdout.trim();
  if (reported === 'sent:iMessage') return 'imessage';
  if (reported === 'sent:SMS') return 'sms';
  return requested === 'auto' ? 'messages' : requested;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveAllowedChat(runtime: MessagesToolRuntime, conversation: string): ChatTarget {
  if (!runtime.allowList.has(conversation)) {
    throw new Error(
      `refused: ${JSON.stringify(conversation)} is not on this host's Messages allow list. ` +
        'Call messages_list_conversations for the conversations this host may read.',
    );
  }
  const chat = runtime.database.resolveConversation(conversation);
  if (chat === null) {
    throw new Error(`no conversation matches ${JSON.stringify(conversation)} in this Mac's Messages database`);
  }
  // The input was allowed, but a handle can resolve to a group the user never
  // allowed; the resolved conversation has to stand on its own.
  if (!runtime.allowList.isConversationAllowed(chat)) {
    throw new Error(`refused: the conversation ${JSON.stringify(chat.guid)} is not on this host's Messages allow list`);
  }
  return chat;
}

function applyByteBudget(
  views: readonly MessageView[],
  maxBytes: number,
): { kept: MessageView[]; truncated: boolean } {
  const kept: MessageView[] = [];
  let bytes = 0;
  for (const view of views) {
    const sized = capText(view);
    const size = Buffer.byteLength(JSON.stringify(sized), 'utf8');
    // One message always fits: a budget below a single row should make the
    // result terse, not empty.
    if (kept.length > 0 && bytes + size > maxBytes) return { kept, truncated: true };
    kept.push(sized);
    bytes += size;
  }
  return { kept, truncated: false };
}

function capText(view: MessageView): MessageView {
  if (view.text.length <= MAX_TEXT_CHARS) return view;
  return {
    ...view,
    text: `${view.text.slice(0, MAX_TEXT_CHARS)}… [message truncated at ${MAX_TEXT_CHARS} characters]`,
  };
}

function degradedJson(tool: string, degraded: Degradation): string {
  return json({
    ok: false,
    degraded: true,
    tool,
    reason:
      'the Messages database schema is missing something this capability requires, so no read was attempted. ' +
      'This is a schema Apple changed, not a permission problem.',
    requiredMissing: degraded.requiredMissing,
    missingTables: degraded.missingTables,
    missingColumns: degraded.missingColumns,
    effects: degraded.effects,
  });
}

function redact(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    // Replacing one or two character needles would shred the message for no
    // privacy gain; a real body or handle is always longer.
    if (secret.trim().length < 3) continue;
    redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function asObject(rawArgs: unknown, tool: string): Record<string, unknown> {
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    throw new Error(`${tool}: arguments must be a JSON object`);
  }
  return rawArgs as Record<string, unknown>;
}

function rejectUnknown(args: Record<string, unknown>, accepted: readonly string[], tool: string): void {
  const unknown = Object.keys(args).filter((key) => !accepted.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${tool}: unknown argument(s) ${unknown.join(', ')}; accepted: ${accepted.join(', ')}`);
  }
}

function requireString(args: Record<string, unknown>, key: string, tool: string, maxLength: number): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`${tool}: "${key}" is required and must be a string`);
  if (value.length === 0) throw new Error(`${tool}: "${key}" must not be empty`);
  if (value.length > maxLength) throw new Error(`${tool}: "${key}" must be at most ${maxLength} characters`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string, tool: string, maxLength: number): string | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${tool}: "${key}" must be a string`);
  if (value.length > maxLength) throw new Error(`${tool}: "${key}" must be at most ${maxLength} characters`);
  return value;
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  tool: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${tool}: "${key}" must be an integer`);
  if (value < min || value > max) throw new Error(`${tool}: "${key}" must be between ${min} and ${max}`);
  return value;
}
