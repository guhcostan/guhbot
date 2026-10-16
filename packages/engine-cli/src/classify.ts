import { classifyCliFailure } from '@guhbot/agent';
import { asBoolean, asNumber, asObject, asString, truncate, type JsonObject } from './json.js';

/**
 * Why a turn could not run, and what the user should do about it.
 *
 * This is the single most important classification in the package. An agent CLI
 * that has hit its weekly limit does not always fail loudly: Claude Code emits a
 * `rate_limit_event`, then a synthetic assistant message with zero tokens, then
 * exits — sometimes zero, sometimes one, depending on the version. A driver that
 * only looks at the exit code reports "the agent said nothing", which is a lie
 * to the user and hides the one piece of information that would let them act.
 *
 * So a structured signal, when the CLI provides one, wins over the exit code and
 * over any text heuristic.
 */
export type BlockedKind = 'rate-limit' | 'signed-out' | 'quota' | 'other';

export interface BlockedSignal {
  readonly kind: BlockedKind;
  /** One clause describing the condition, without a trailing full stop. */
  readonly detail: string;
  /** What the CLI itself printed, when it printed something usable. */
  readonly cliText: string | null;
}

/** The rate-limit shape Claude Code puts on `rate_limit_event`. */
export interface RateLimitInfo {
  readonly status: string | null;
  readonly limitType: string | null;
  /** ISO timestamp the limit lifts, when the CLI told us one. */
  readonly resetsAt: string | null;
  readonly usingOverage: boolean | null;
}

export function describeBlocked(engineName: string, signal: BlockedSignal): string {
  const lead =
    signal.kind === 'signed-out'
      ? `${engineName} is not signed in`
      : signal.kind === 'rate-limit'
        ? `${engineName} is rate limited`
        : signal.kind === 'quota'
          ? `${engineName} is out of quota`
          : `${engineName} refused to run`;
  const advice =
    signal.kind === 'signed-out'
      ? ' Run it once in a terminal to sign in, then retry.'
      : ' Nothing was produced for this turn.';
  const said =
    signal.cliText !== null && signal.cliText.trim().length > 0
      ? ` The CLI said: ${withFullStop(truncate(signal.cliText.trim(), 200))}`
      : '';
  return `${lead}: ${signal.detail}.${said}${advice}`;
}

function withFullStop(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * Classify a turn that failed without telling us anything structured.
 *
 * `classifyCliFailure` reads the argument order in the text, which is the only
 * evidence available from a process that exited non-zero and printed prose. The
 * mapping back into a `BlockedSignal` keeps every failure message in one voice.
 */
export function blockedFromText(text: string): BlockedSignal | null {
  const { blocked } = classifyCliFailure(null, text);
  if (blocked === null) return null;
  const cliText = text.trim().length > 0 ? text.trim() : null;
  if (/rate.?limit|too many requests|429|weekly limit|usage limit/i.test(text)) {
    return { kind: 'rate-limit', detail: 'the account has hit its rate limit', cliText };
  }
  if (/quota|billing|payment/i.test(text)) {
    return { kind: 'quota', detail: 'the account is out of quota', cliText };
  }
  if (/not logged in|not signed in|log ?in|unauthori[sz]ed|authentication|invalid api key|401/i.test(text)) {
    return { kind: 'signed-out', detail: 'the CLI reported that it is not authenticated', cliText };
  }
  return { kind: 'other', detail: blocked, cliText };
}

/** Parse a `rate_limit_info` object, wherever the CLI nested it. */
export function readRateLimitInfo(value: unknown): RateLimitInfo | null {
  const record = asObject(value);
  if (record === null) return null;
  return {
    status: asString(record['status']),
    limitType: asString(record['rateLimitType']),
    resetsAt: toIsoInstant(record['resetsAt']),
    usingOverage: asBoolean(record['isUsingOverage']),
  };
}

/**
 * Turn a rejected rate limit into a blocking signal, or null when it is not a
 * refusal.
 *
 * `status: "rejected"` is the refusal. Other statuses (`allowed`,
 * `allowed_warning`) are informational: the CLI told us it is close to a limit
 * and then did the work anyway, and failing that turn would be wrong.
 */
export function rateLimitSignal(info: RateLimitInfo, cliText: string | null): BlockedSignal | null {
  if (info.status !== 'rejected') return null;
  const window = limitTypeLabel(info.limitType);
  const reset = info.resetsAt === null ? null : `resets at ${info.resetsAt}`;
  const detail = [window, reset].filter((part) => part !== null).join('; ');
  return {
    kind: 'rate-limit',
    detail: detail.length > 0 ? `the ${detail}` : 'the CLI reported a rejected rate limit',
    cliText,
  };
}

/** A one-line summary of the most recent rate-limit event, for probe reporting. */
export function summarizeRateLimit(info: RateLimitInfo): string {
  const window = limitTypeLabel(info.limitType);
  const status = info.status ?? 'unknown';
  return info.resetsAt === null ? `${window} ${status}` : `${window} ${status}, resets at ${info.resetsAt}`;
}

function limitTypeLabel(limitType: string | null): string {
  switch (limitType) {
    case 'seven_day':
      return 'weekly limit';
    case 'seven_day_opus':
    case 'seven_day_sonnet':
      return `weekly limit (${limitType.slice('seven_day_'.length)})`;
    case 'five_hour':
      return '5-hour limit';
    case 'daily':
      return 'daily limit';
    default:
      return limitType === null ? 'rate limit' : `${limitType} limit`;
  }
}

/**
 * Coerce a reset timestamp to ISO.
 *
 * The value is documented nowhere. Claude Code currently sends Unix seconds;
 * a future version could send milliseconds or an ISO string, and mistaking one
 * for the other produces a date in 1970 or 55000, so the magnitude is checked
 * rather than assumed.
 */
function toIsoInstant(value: unknown): string | null {
  const text = asString(value);
  if (text !== null) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const numeric = asNumber(value);
  if (numeric === null || numeric <= 0) return null;
  const milliseconds = numeric > 1e12 ? numeric : numeric * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The first non-empty string among `keys` of a record. */
export function firstText(record: JsonObject, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== null && value.trim().length > 0) return value;
  }
  return null;
}
