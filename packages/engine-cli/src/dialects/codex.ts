import { firstText } from '../classify.js';
import { asObject, asString, flattenNumbers, stringAt, truncate, type JsonObject } from '../json.js';
import type { CliDialect, CliRunSink, CliTurnState } from '../runner.js';

/**
 * Codex, `codex exec --json`.
 *
 * Observed on codex-cli 0.162.1:
 *
 *   {"type":"thread.started","thread_id":...}
 *   {"type":"item.completed","item":{"type":"error","message":...}}      warning
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"1\n"}}  a delta
 *   {"type":"item.started"|"item.completed","item":{"type":"command_execution",...}}
 *   {"type":"turn.completed","usage":{...}}
 *   {"type":"error","message":"..."} / {"type":"turn.failed","error":{...}}
 *
 * `agent_message` items are *already deltas*: a twenty-line answer arrives as
 * twenty completed items. They are emitted as they land, which is what makes the
 * client show progress instead of one minute of nothing.
 */
export function createCodexDialect(): CliDialect {
  // Tool calls seen started but not yet completed, keyed by the item's id.
  const inFlight = new Map<string, string>();

  return {
    id: 'codex-json',
    requiresOutput: true,

    onEvent(event, state, sink) {
      switch (asString(event['type'])) {
        case 'thread.started': {
          const id = asString(event['thread_id']);
          if (id !== null) state.sessionId = id;
          return;
        }
        case 'turn.started':
          return;
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          handleItem(event, state, sink, inFlight);
          return;
        case 'turn.completed': {
          const usage = flattenNumbers(event['usage']);
          if (usage !== null) state.usage = usage;
          return;
        }
        case 'turn.failed': {
          state.error = {
            message: stringAt(event, 'error.message') ?? 'the turn failed with no message',
            type: null,
          };
          return;
        }
        case 'error': {
          // Top-level `error` is fatal; an `item` of type `error` is not. The
          // same word means two different things in this format.
          state.error = { message: firstText(event, ['message']) ?? 'the CLI reported an error', type: null };
          return;
        }
        default:
          return;
      }
    },

    onLine(line, state) {
      // Codex keeps its banner and its logs on stderr. A stray stdout line is
      // noise to skip, but worth remembering if the turn then fails.
      state.warning = truncate(line, 300);
    },
  };
}

function handleItem(
  event: JsonObject,
  state: CliTurnState,
  sink: CliRunSink,
  inFlight: Map<string, string>,
): void {
  const item = asObject(event['item']);
  if (item === null) return;
  const kind = asString(item['type']);
  if (kind === null) return;
  const phase = asString(event['type']);

  if (kind === 'agent_message') {
    // Only the completed copy is trusted. An `item.started` carries an empty
    // text, and a version that streams cumulative text through `item.updated`
    // would otherwise be emitted twice.
    if (phase !== 'item.completed') return;
    const text = asString(item['text']);
    if (text !== null && text.length > 0) sink.text(text);
    return;
  }

  if (kind === 'error') {
    // Non-fatal warnings (an unstable-feature notice, missing model metadata)
    // use the same item type as a real error. `turn.failed` is what fails a turn.
    const message = asString(item['message']);
    if (message !== null && state.warning === null) state.warning = truncate(message, 300);
    return;
  }

  // Reasoning is not the answer.
  if (kind === 'reasoning') return;

  const id = asString(item['id']) ?? `${kind}:${state.sessionId ?? 'session'}`;
  const tool = kind === 'command_execution' ? 'shell' : kind;

  if (phase !== 'item.completed') {
    if (inFlight.has(id)) return;
    inFlight.set(id, tool);
    sink.toolCall(tool, describeItem(item));
    return;
  }

  // Some items complete without ever starting (a cached or instant result).
  if (!inFlight.has(id)) sink.toolCall(tool, describeItem(item));
  inFlight.delete(id);
  sink.toolResult(tool, outputOf(item));
}

/** The interesting inputs of an item, without knowing its type. */
function describeItem(item: JsonObject): string {
  const picked: JsonObject = {};
  for (const key of ['command', 'query', 'path', 'changes', 'server', 'tool', 'arguments', 'input', 'url', 'pattern']) {
    const value = item[key];
    if (value !== undefined && value !== null) picked[key] = value;
  }
  try {
    return JSON.stringify(picked);
  } catch {
    return '{}';
  }
}

function outputOf(item: JsonObject): string {
  return (
    firstText(item, ['aggregated_output', 'output', 'text', 'result', 'message']) ??
    `(${asString(item['status']) ?? 'completed'} with no output)`
  );
}
