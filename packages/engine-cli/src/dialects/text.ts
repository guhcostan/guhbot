import { numberAt, truncate, type JsonObject } from '../json.js';
import type { CliDialect } from '../runner.js';

/**
 * Any tool that just prints prose.
 *
 * This is the fallback dialect for the template-driven `ExecEngine`: a wrapper
 * script, a home-grown agent, or a CLI whose JSON format we have not taught the
 * package yet. stdout lines become the answer as they arrive, and a JSON object
 * that happens to carry `total_cost_usd` still reports cost.
 */
export function createTextDialect(): CliDialect {
  return {
    id: 'text',
    // A tool that prints nothing succeeded at doing nothing, which is a
    // legitimate outcome for a scripted command.
    requiresOutput: false,

    onEvent(event: JsonObject, state) {
      const cost = numberAt(event, 'total_cost_usd');
      if (cost !== null) state.costUsd = cost;
    },

    onLine(line, state, sink) {
      if (line.trim().length === 0) return;
      sink.text(`${line}\n`);
      state.warning = truncate(line, 300);
    },
  };
}
