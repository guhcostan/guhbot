import { execFile } from 'node:child_process';
import { isChatGuid } from './identifiers.js';

/**
 * Talking to Messages.app through `osascript`.
 *
 * Two rules shape this file:
 *
 *  1. The script always leaves through `execFile` as an argv element. There is
 *     no shell, so nothing in a message body or a handle can become a second
 *     command or a second AppleScript statement.
 *  2. Every value that reaches AppleScript is escaped into a string literal by
 *     {@link escapeAppleScriptLiteral}. The script around it is a fixed
 *     template; only the literal *contents* are substituted.
 *
 * Escaping is enough to make injection impossible, but note that the generated
 * script (and therefore the message text) is visible in this process's argv to
 * any local user who can run `ps`. On a multi-user host, prefer sending to a
 * conversation the user would not mind being visible; a stdin-based runner is
 * the fix if that becomes a requirement.
 */

export type AppleScriptService = 'auto' | 'imessage' | 'sms';

export interface AppleScriptRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  failure: 'not-found' | 'timeout' | 'aborted' | 'failed' | null;
}

export interface AppleScriptRunOptions {
  signal: AbortSignal;
  timeoutMs: number;
  osascriptPath: string;
}

/**
 * Escape a value so it can only ever be *text* inside an AppleScript
 * double-quoted string literal.
 *
 * AppleScript string literals understand `\\`, `\"`, `\n`, `\r` and `\t` and
 * nothing else, so there is no way to escape an arbitrary control character:
 * those are dropped. A line separator (U+2028/U+2029) becomes a newline because
 * some AppleScript builds treat it as a line break in source. The object
 * replacement character that marks an attachment in a stored body is dropped
 * too — it cannot survive a round trip through Messages.
 */
export function escapeAppleScriptLiteral(value: string): string {
  let escaped = '';
  for (const character of value) {
    switch (character) {
      case '\\':
        escaped += '\\\\';
        break;
      case '"':
        escaped += '\\"';
        break;
      case '\n':
        escaped += '\\n';
        break;
      case '\r':
        escaped += '\\r';
        break;
      case '\t':
        escaped += '\\t';
        break;
      case '\u2028':
      case '\u2029':
        escaped += '\\n';
        break;
      default: {
        const code = character.codePointAt(0) ?? 0;
        // C0 controls, DEL and lone surrogates have no representation in an
        // AppleScript literal and no place in a message.
        if (code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)) break;
        if (code === 0xfffc) break;
        escaped += character;
      }
    }
  }
  return escaped;
}

export interface SendScriptInput {
  /** A handle (`+1555…`, `person@example.com`) or a Messages chat GUID. */
  recipient: string;
  text: string;
  service: AppleScriptService;
}

const SERVICE_TYPE: Record<Exclude<AppleScriptService, 'auto'>, string> = {
  imessage: 'iMessage',
  sms: 'SMS',
};

function participantSend(recipient: string, text: string, serviceType: string): string[] {
  return [
    `set targetService to first account whose service type = ${serviceType}`,
    `set targetBuddy to participant "${recipient}" of targetService`,
    `send "${text}" to targetBuddy`,
  ];
}

/**
 * Build the AppleScript that performs one send.
 *
 * `auto` tries iMessage first and falls back to SMS, which is the only way to
 * reach an SMS-only contact without knowing the transport up front. For a chat
 * GUID the transport is already encoded in the GUID, so the service argument is
 * ignored.
 */
export function buildSendScript(input: SendScriptInput): string {
  const recipient = escapeAppleScriptLiteral(input.recipient);
  const text = escapeAppleScriptLiteral(input.text);

  if (isChatGuid(input.recipient)) {
    return [
      'on run',
      '  tell application "Messages"',
      `    set targetChat to chat id "${recipient}"`,
      `    send "${text}" to targetChat`,
      '  end tell',
      '  return "sent"',
      'end run',
    ].join('\n');
  }

  if (input.service === 'auto') {
    return [
      'on run',
      '  tell application "Messages"',
      '    try',
      ...participantSend(recipient, text, SERVICE_TYPE.imessage).map((line) => `      ${line}`),
      '      return "sent:iMessage"',
      '    on error',
      ...participantSend(recipient, text, SERVICE_TYPE.sms).map((line) => `      ${line}`),
      '      return "sent:SMS"',
      '    end try',
      '  end tell',
      'end run',
    ].join('\n');
  }

  return [
    'on run',
    '  tell application "Messages"',
    ...participantSend(recipient, text, SERVICE_TYPE[input.service]).map((line) => `    ${line}`),
    '  end tell',
    '  return "sent"',
    'end run',
  ].join('\n');
}

const DEFAULT_OSASCRIPT_PATH = '/usr/bin/osascript';

export function runOsascript(script: string, options: AppleScriptRunOptions): Promise<AppleScriptRunResult> {
  return new Promise<AppleScriptRunResult>((resolve) => {
    execFile(
      options.osascriptPath,
      ['-e', script],
      {
        timeout: options.timeoutMs,
        maxBuffer: 256 * 1024,
        signal: options.signal,
        env: sanitizedEnv(),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout, stderr, exitCode: 0, failure: null });
          return;
        }
        const rawCode: unknown = (error as { code?: unknown }).code;
        const errno = typeof rawCode === 'string' ? rawCode : null;
        const failure: AppleScriptRunResult['failure'] =
          errno === 'ENOENT'
            ? 'not-found'
            : errno === 'ABORT_ERR'
              ? 'aborted'
              : errno === 'ETIMEDOUT' || (error as { killed?: unknown }).killed === true
                ? 'timeout'
                : 'failed';
        resolve({
          ok: false,
          stdout,
          stderr,
          exitCode: typeof rawCode === 'number' ? rawCode : null,
          failure,
        });
      },
    );
  });
}

/**
 * Strip secret-looking variables before handing the environment to a child.
 *
 * `@guhbot/agent` has the same control for its own tools; it is not exported,
 * and widening another package's surface is not worth six lines here.
 */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(_KEY|_TOKEN|_SECRET|_PASSWORD|^AWS_|^OPENAI_|^ANTHROPIC_|^GITHUB_|^GH_)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

export { DEFAULT_OSASCRIPT_PATH };
