import { firstText, rateLimitSignal, readRateLimitInfo } from '../classify.js';
import { asArray, asBoolean, asNumber, asObject, asString, at, flattenNumbers, numberAt, truncate, type JsonObject } from '../json.js';
import type { CliDialect, CliRunSink, CliTurnState } from '../runner.js';

/**
 * Claude Code, `--output-format stream-json --verbose`.
 *
 * Observed on 2.1.293 (see the recorded fixtures in `tests/fixtures/`):
 *
 *   {"type":"system","subtype":"init",...}                    bookkeeping, skip
 *   {"type":"system","subtype":"hook_started"|...,...}        noise, skip
 *   {"type":"rate_limit_event","rate_limit_info":{...}}       the important one
 *   {"type":"assistant","message":{...,"content":[...]}}      the answer
 *   {"type":"result","total_cost_usd":...,"usage":{...}}      the totals
 *
 * Nothing here is a stable contract. Every read is optional and typed, because
 * a version bump that renames a field must degrade to a worse answer rather than
 * a crash.
 */
export function createClaudeDialect(): CliDialect {
  // Per-turn state. Two concurrent turns of this engine get two dialects, so a
  // buffer here can never be seen by another run.
  const buffer: StreamBuffer = { text: '', toolIds: new Set(), pending: new Map() };

  return {
    id: 'claude-stream-json',
    requiresOutput: true,

    onEvent(event, state, sink) {
      switch (asString(event['type'])) {
        case 'system':
          // init, hook lifecycle, commands_changed: transport bookkeeping. The
          // init line alone can be hundreds of kilobytes of tool catalogue.
          return;
        case 'rate_limit_event':
          handleRateLimit(event, state);
          return;
        case 'assistant':
          handleAssistant(event, state, sink, buffer);
          return;
        case 'stream_event':
          handleStreamEvent(event, sink, buffer);
          return;
        case 'result':
          handleResult(event, state, sink);
          return;
        default:
          // `user` echoes tool results back; anything unrecognised is a newer
          // event type that is not an answer.
          return;
      }
    },

    onLine(line, state) {
      state.warning = truncate(line, 300);
    },
  };
}

function handleRateLimit(event: JsonObject, state: CliTurnState): void {
  const info =
    readRateLimitInfo(event['rate_limit_info']) ?? readRateLimitInfo(at(event, 'api_error_params.rate_limit_info'));
  if (info === null) return;
  state.rateLimit = info;
}

interface StreamBuffer {
  /** Text emitted from partial-message events for the message in flight. */
  text: string;
  /** Ids of tool calls already recorded from partial-message events. */
  toolIds: Set<string>;
  /** Tool blocks being streamed, keyed by content-block index. */
  pending: Map<number, { id: string | null; name: string; json: string }>;
}

function handleAssistant(event: JsonObject, state: CliTurnState, sink: CliRunSink, buffer: StreamBuffer): void {
  const message = asObject(event['message']);
  if (message === null) return;

  const model = asString(message['model']);
  const text = textFromBlocks(message['content']);
  const errorName = firstText(event, ['api_error', 'error']);

  // A refusal arrives shaped like an assistant message: model `<synthetic>`,
  // zero tokens, and the refusal text in `content`. It is not the agent's answer
  // and must never be emitted as one.
  if (errorName !== null || model === '<synthetic>' || asBoolean(event['is_api_error_message']) === true) {
    if (text !== null) state.rateLimitText = text;
    const name = errorName ?? 'an API error';
    const kind = errorKind(name, text);
    if (kind === 'rate-limit') {
      state.blocked = rateLimitSignal(
        state.rateLimit ?? { status: 'rejected', limitType: null, resetsAt: null, usingOverage: null },
        text ?? state.rateLimitText,
      ) ?? { kind: 'rate-limit', detail: `the CLI reported ${name}`, cliText: text };
      return;
    }
    if (kind === 'signed-out') {
      state.blocked = { kind: 'signed-out', detail: `the CLI reported ${name}`, cliText: text };
      return;
    }
    state.error = { message: text === null ? name : `${name}: ${text}`, type: errorName };
    return;
  }

  if (model !== null) state.model = model;

  // With `--include-partial-messages` everything arrives twice: text as deltas
  // and then inside the finished message, tool calls at `content_block_stop` and
  // then inside the same message. The streamed copy is the one the user already
  // saw, so the finished copy is dropped when it matches.
  if (text !== null && text.length > 0 && !(buffer.text.length > 0 && text === buffer.text)) sink.text(text);

  for (const block of asArray(message['content'])) {
    const record = asObject(block);
    if (record === null || asString(record['type']) !== 'tool_use') continue;
    const id = asString(record['id']);
    if (id !== null && buffer.toolIds.has(id)) continue;
    const name = asString(record['name']) ?? 'tool';
    const input = record['input'];
    sink.toolCall(name, input === undefined ? '{}' : safeJson(input));
  }
}

function handleStreamEvent(event: JsonObject, sink: CliRunSink, buffer: StreamBuffer): void {
  const inner = asObject(event['event']);
  if (inner === null) return;

  switch (asString(inner['type'])) {
    case 'message_start':
      // A new message: nothing streamed for it yet.
      buffer.text = '';
      buffer.toolIds.clear();
      buffer.pending.clear();
      return;
    case 'content_block_start': {
      const index = asNumber(inner['index']);
      const block = asObject(inner['content_block']);
      if (index !== null && block !== null && asString(block['type']) === 'tool_use') {
        buffer.pending.set(index, {
          id: asString(block['id']),
          name: asString(block['name']) ?? 'tool',
          json: '',
        });
      }
      return;
    }
    case 'content_block_delta': {
      const index = asNumber(inner['index']);
      const delta = asObject(inner['delta']);
      if (delta === null) return;
      switch (asString(delta['type'])) {
        case 'text_delta': {
          const text = asString(delta['text']);
          if (text !== null && text.length > 0) {
            sink.text(text);
            buffer.text += text;
          }
          return;
        }
        case 'input_json_delta': {
          const partial = asString(delta['partial_json']);
          if (index === null || partial === null) return;
          const pending = buffer.pending.get(index);
          if (pending !== undefined) pending.json += partial;
          return;
        }
        default:
          // thinking and signature deltas are reasoning, not the answer.
          return;
      }
    }
    case 'content_block_stop': {
      const index = asNumber(inner['index']);
      if (index === null) return;
      const pending = buffer.pending.get(index);
      if (pending !== undefined) {
        buffer.pending.delete(index);
        if (pending.id !== null) buffer.toolIds.add(pending.id);
        sink.toolCall(pending.name, pending.json.length > 0 ? pending.json : '{}');
      }
      return;
    }
    default:
      return;
  }
}

function handleResult(event: JsonObject, state: CliTurnState, sink: CliRunSink): void {
  const cost = numberAt(event, 'total_cost_usd');
  if (cost !== null) state.costUsd = cost;
  const usage = flattenNumbers(event['usage']);
  if (usage !== null) state.usage = usage;
  const sessionId = asString(event['session_id']);
  if (sessionId !== null) state.sessionId = sessionId;

  const text = firstText(event, ['result']);
  const apiError = asString(event['api_error']);
  if (asBoolean(event['is_error']) === true) {
    if (state.blocked !== null) return;
    const name = apiError ?? asString(event['subtype']) ?? 'an error';
    const kind = errorKind(name, text);
    if (kind === 'rate-limit') {
      state.blocked = rateLimitSignal(
        state.rateLimit ?? { status: 'rejected', limitType: null, resetsAt: null, usingOverage: null },
        text ?? state.rateLimitText,
      ) ?? { kind: 'rate-limit', detail: `the CLI reported ${name}`, cliText: text };
      return;
    }
    if (kind === 'signed-out') {
      state.blocked = { kind: 'signed-out', detail: `the CLI reported ${name}`, cliText: text };
      return;
    }
    state.error = { message: text === null ? name : `${name}: ${text}`, type: apiError };
    return;
  }

  // A version that stops emitting assistant events still lands its answer on the
  // result object. Only used when nothing else produced an answer.
  if (!state.answered && text !== null) sink.text(text);
}

/**
 * Decide what a refusal means.
 *
 * `api_error` is a stable-looking enum (`usage_limit_reached`,
 * `authentication_error`), so it is read first and the prose is only the
 * fallback.
 */
function errorKind(name: string, text: string | null): 'rate-limit' | 'signed-out' | null {
  const haystack = `${name} ${text ?? ''}`;
  if (/usage_limit|rate_limit|rate limit|too many requests|429|quota/i.test(haystack)) return 'rate-limit';
  if (/auth|unauthori|forbidden|invalid.?api.?key|401|403|oauth/i.test(haystack)) return 'signed-out';
  return null;
}

function textFromBlocks(value: unknown): string | null {
  const parts: string[] = [];
  for (const block of asArray(value)) {
    const record = asObject(block);
    if (record === null || asString(record['type']) !== 'text') continue;
    const text = asString(record['text']);
    if (text !== null) parts.push(text);
  }
  return parts.length === 0 ? null : parts.join('');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    // A cyclic or otherwise unserialisable tool input must not end the run.
    return '{}';
  }
}
