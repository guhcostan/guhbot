import type { Capability } from '@guhbot/agent';
import { AllowList } from './allow-list.js';
import { DEFAULT_OSASCRIPT_PATH, runOsascript } from './applescript.js';
import { ChatDatabase, DEFAULT_DATABASE_PATH } from './chat-db.js';
import { buildMessagesMethods } from './methods.js';
import type { MessagesCapabilityOptions } from './options.js';
import { buildMessagesTools, type MessagesToolRuntime } from './tools.js';

/**
 * macOS Messages as a capability.
 *
 * The shape of the safety model, in one place:
 *
 *  - **Nothing is readable by default.** `allowed` is the complete access
 *    model; with an empty list this capability contributes no tools and reports
 *    `messages: false`. There is no "read the whole database" mode.
 *  - **Sending is never silent.** `messages_send` sets `requiresApproval` and
 *    offers no option to change that; the approval request carries the recipient
 *    and the exact text.
 *  - **The database is read, never taken.** One read-only handle on Apple's
 *    file, closed by `dispose()`. No copy, no writes, no WAL sidecars.
 *  - **Unsupported platforms still boot.** On anything but darwin the factory
 *    returns a valid, inert capability with a reason for diagnostics. It never
 *    throws at construction.
 */

export type { AppleScriptRunResult, AppleScriptService } from './applescript.js';
export type { AttachmentView, ConversationView, MessageView } from './chat-db.js';
export type { MessagesCapabilityOptions, AppleScriptRunner } from './options.js';

export interface MessagesCapability extends Capability {
  /** Why this capability is inert, or null when it is active. */
  readonly reason: string | null;
  /** Most recent failure, bounded and content-free. Never message text. */
  readonly lastError: string | null;
  /** True while a `chat.db` handle is open. Exposed so a host can assert disposal. */
  isDatabaseOpen(): boolean;
  /** The current allow list, in configuration order. */
  allowedEntries(): string[];
}

export function createMessagesCapability(options: MessagesCapabilityOptions = {}): MessagesCapability {
  const platform = options.platform ?? process.platform;
  const supported = platform === 'darwin';
  const allowList = new AllowList(options.allowed ?? []);
  const database = new ChatDatabase(options.databasePath ?? DEFAULT_DATABASE_PATH);
  const runAppleScript = options.runAppleScript ?? runOsascript;
  const timeoutMs = options.osascriptTimeoutMs ?? 20_000;
  const osascriptPath = options.osascriptPath ?? DEFAULT_OSASCRIPT_PATH;

  let lastError: string | null = null;

  const enabled = (): boolean => supported && allowList.size() > 0;
  const reason = (): string | null => {
    if (!supported) {
      return `macOS Messages is only available on darwin; this host reports ${platform}`;
    }
    if (allowList.size() === 0) {
      return 'no Messages conversations are allowed yet; the user must add a chat GUID or handle with messages.addAllowed';
    }
    return null;
  };

  const runtime: MessagesToolRuntime = {
    allowList,
    database,
    runAppleScript,
    // `auto` lets Messages pick the transport, which is the only choice that
    // works for a contact whose service the host has not looked up.
    service: 'auto',
    osascriptPath,
    timeoutMs,
    recordDiagnostic: (message) => {
      lastError = message;
    },
  };

  return {
    name: 'messages',
    summary: 'Reads allow-listed macOS Messages conversations and sends iMessage/SMS with human approval.',
    // A getter, not a snapshot: the allow list can change through
    // `messages.addAllowed`, and the flag has to keep telling the truth.
    get flags() {
      return { messages: enabled() };
    },
    tools: () => (enabled() ? buildMessagesTools(runtime) : []),
    methods: buildMessagesMethods({
      allowList,
      database,
      supported,
      platform,
      enabled,
      reason,
      lastError: () => lastError,
      persist: (entries) => options.onAllowListChanged?.(entries),
    }),
    dispose: async () => {
      // Idempotent by construction: closing an already-closed handle is a no-op.
      database.close();
    },
    get reason() {
      return reason();
    },
    get lastError() {
      return lastError;
    },
    isDatabaseOpen: () => database.isOpen(),
    allowedEntries: () => allowList.entries(),
  };
}
