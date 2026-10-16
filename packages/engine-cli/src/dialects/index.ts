/**
 * The dialects: one interpreter per JSONL format.
 *
 * A dialect's only job is to turn somebody else's event stream into answer text,
 * tool entries, cost and structured refusals. It never touches the child
 * process; the runner owns that. Each engine gets a fresh dialect per turn, so
 * partial-message bookkeeping lives in a closure rather than on shared state —
 * two concurrent runs of the same engine must not see each other's stream.
 */

export { createClaudeDialect } from './claude.js';
export { createCodexDialect } from './codex.js';
export { createOpencodeDialect } from './opencode.js';
export { createTextDialect } from './text.js';
