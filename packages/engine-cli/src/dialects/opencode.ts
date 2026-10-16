import { blockedFromText } from '../classify.js';
import { asString, at, flattenNumbers, mergeNumbers, numberAt, stringAt, truncate } from '../json.js';
import type { CliDialect, CliRunSink, CliTurnState } from '../runner.js';

/**
 * OpenCode, `opencode run --format json`.
 *
 * Observed on v2.0.25:
 *
 *   {"type":"step_start","sessionID":...,"part":{"type":"step-start"}}
 *   {"type":"text","part":{"type":"text","text":"hello"}}
 *   {"type":"tool_use","part":{"type":"tool","tool":"shell","state":{...}}}
 *   {"type":"step_finish","part":{"cost":0.00085,"tokens":{...},"reason":"tool-calls"}}
 *   {"type":"error","error":{"type":"provider.no-route","message":"..."}}
 *
 * A `text` part is a whole step's prose rather than a token stream, so the
 * deltas are chunky. Cost is per step and is summed, which is the only place
 * OpenCode reports spend at all.
 */
export function createOpencodeDialect(): CliDialect {
  return {
    id: 'opencode-json',
    requiresOutput: true,

    onEvent(event, state, sink) {
      const sessionId = asString(event['sessionID']);
      if (sessionId !== null) state.sessionId = sessionId;

      switch (asString(event['type'])) {
        case 'text': {
          const text = stringAt(event, 'part.text');
          if (text !== null && text.length > 0) sink.text(text);
          return;
        }
        case 'tool_use': {
          const tool = stringAt(event, 'part.tool') ?? 'tool';
          const input = at(event, 'part.state.input');
          sink.toolCall(tool, safeJson(input));
          const output = at(event, 'part.state.output');
          if (typeof output === 'string' && output.length > 0) sink.toolResult(tool, output);
          return;
        }
        case 'step_finish': {
          const cost = numberAt(event, 'part.cost');
          if (cost !== null) state.costUsd = (state.costUsd ?? 0) + cost;
          state.usage = mergeNumbers(state.usage, flattenNumbers(at(event, 'part.tokens')));
          return;
        }
        case 'error': {
          const message = stringAt(event, 'error.message') ?? 'the CLI reported an error';
          const type = stringAt(event, 'error.type');
          // A structured error whose text reads like a refusal is a refusal;
          // `provider.no-route` (a model that does not exist) is not.
          const blocked = blockedFromText(`${type ?? ''} ${message}`);
          if (blocked !== null) state.blocked = { ...blocked, cliText: message };
          else state.error = { message, type };
          return;
        }
        default:
          return;
      }
    },

    onLine(line, state) {
      state.warning = truncate(line, 300);
    },
  };
}

function safeJson(value: unknown): string {
  if (value === undefined) return '{}';
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '{}';
  }
}
