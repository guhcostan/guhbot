import type { AppleScriptRunOptions, AppleScriptRunResult, AppleScriptService } from './applescript.js';

/** Injected in tests so no test can reach Messages.app. */
export type AppleScriptRunner = (script: string, options: AppleScriptRunOptions) => Promise<AppleScriptRunResult>;

export interface MessagesCapabilityOptions {
  /**
   * Conversations this capability may read and send to: chat GUIDs or handles
   * (`+1555…`, `person@example.com`). Empty means the capability contributes no
   * tools at all — there is no "read everything" default.
   */
  allowed?: readonly string[];
  /** Defaults to `~/Library/Messages/chat.db`; pointed at a fixture in tests. */
  databasePath?: string;
  /**
   * Injectable so a non-darwin host can be tested without patching the global.
   * Defaults to `process.platform`.
   */
  platform?: NodeJS.Platform;
  /** Defaults to `/usr/bin/osascript`. */
  osascriptPath?: string;
  /** Defaults to {@link import('./applescript.js').runOsascript}. */
  runAppleScript?: AppleScriptRunner;
  /**
   * Called after `messages.addAllowed` / `messages.removeAllowed`, so the host
   * can persist the list. Durable writes belong to `@guhbot/host-core`, which
   * has no table for this yet; until it does, the list lives in memory and this
   * callback is the seam for storing it.
   */
  onAllowListChanged?: (entries: readonly string[]) => void;
  /** Defaults to 20000. */
  osascriptTimeoutMs?: number;
}

export type { AppleScriptService };
