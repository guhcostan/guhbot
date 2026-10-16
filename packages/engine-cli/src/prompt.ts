import type { RunContext } from '@guhbot/host-core';

/**
 * The prompt handed to a CLI.
 *
 * A CLI engine is one process per turn. Unlike `AgentLoop`, which replays the
 * transcript as chat messages, nothing carries the conversation forward unless
 * the CLI's own session resumption is threaded through — and that needs durable
 * per-agent state, which only `host-core` may write. Until that exists, the
 * recent transcript is rendered into the prompt so that a follow-up ("now do the
 * same for the other file") has something to refer to instead of arriving at a
 * cold session with no idea what "the same" means.
 *
 * The rendering is bounded: a transcript grows without limit and a CLI's context
 * window does not.
 */
export function buildCliPrompt(context: RunContext, maxChars = 20_000): string {
  const history = context.history;
  const end = trailingPromptIndex(history, context.prompt);
  const lines: string[] = [];
  for (const entry of history.slice(0, end)) {
    const text = renderEntry(entry);
    if (text === null) continue;
    lines.push(`${labelFor(entry.role)}: ${text}`);
  }
  if (lines.length === 0) return context.prompt;

  return [
    'Conversation so far (oldest first, most recent last):',
    tailOf(lines.join('\n'), maxChars),
    '',
    'Current request:',
    context.prompt,
  ].join('\n');
}

/**
 * How much of the history to keep.
 *
 * `history` ends with the entry for the prompt of this very run, so that entry
 * is dropped: the prompt is passed as its own argument and repeating it inside
 * the transcript would read as two requests.
 */
function trailingPromptIndex(history: RunContext['history'], prompt: string): number {
  const last = history[history.length - 1];
  if (last === undefined) return 0;
  return last.role === 'user' && last.kind === 'message' && last.content === prompt ? history.length - 1 : history.length;
}

/** Render a stored entry as plain text, or null to skip it. */
function renderEntry(entry: RunContext['history'][number]): string | null {
  switch (entry.kind) {
    case 'message':
    case 'tool-result':
    case 'error':
    case 'status':
      return entry.content;
    case 'tool-call':
      return `[called ${entry.toolName ?? 'tool'} with ${entry.content}]`;
    case 'approval-request':
      return `[requested approval: ${entry.content}]`;
    case 'approval-resolution':
      return `[approval resolved: ${entry.content}]`;
    case 'artifact':
      return `[produced artifact: ${entry.content}]`;
    default:
      return null;
  }
}

function labelFor(role: RunContext['history'][number]['role']): string {
  switch (role) {
    case 'user':
      return 'user';
    case 'agent':
      return 'agent';
    case 'tool':
      return 'tool';
    case 'system':
      return 'system';
    default:
      return 'note';
  }
}

function tailOf(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `… (earlier turns omitted)\n${text.slice(text.length - maxChars)}`;
}
