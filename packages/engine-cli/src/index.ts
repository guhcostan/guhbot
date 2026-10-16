/**
 * @guhbot/engine-cli — agents the user already has.
 *
 * Requiring a model API key excludes everyone who already pays for a Claude Code
 * or Codex subscription, which is most of the audience for this category. This
 * package closes that gap: each engine drives an installed CLI through the same
 * `RunExecutor` seam the built-in loop uses, so a run started here still lands in
 * the transcript, still respects the host's working directory, and still reports
 * what it cost.
 *
 * ```ts
 * const engines = createCliEngines({ commands: { codex: '/usr/local/bin/codex' } });
 * const registry = createEngineRegistry(engines);
 * const engine = registry.require('claude-code');
 * const executor = engine.createExecutor({ cwd: '/work' });
 * ```
 *
 * Two rules hold for every engine here:
 *
 *  - **A refusal is a failure.** A rate-limited CLI exits zero having said
 *    nothing. Reporting that as a successful empty answer is a lie, so a
 *    structured refusal signal fails the turn with something the user can act on.
 *  - **The child gets an allowlist, not `process.env`.** An agent CLI runs
 *    untrusted content and commands; it is not entitled to the host's keys.
 */

export { buildCliEnv, isSecretLikeCliEnvName } from './env.js';
export { createProcessSpawn, processSpawn, CliSpawnError } from './spawn.js';
export {
  blockedFromText,
  describeBlocked,
  rateLimitSignal,
  readRateLimitInfo,
  summarizeRateLimit,
} from './classify.js';
export type { BlockedKind, BlockedSignal, RateLimitInfo } from './classify.js';
export { CliRunError, createTurnState, runCliTurn } from './runner.js';
export type { CliDialect, CliRunSink, CliTurnRequest, CliTurnResult, CliTurnState } from './runner.js';
export {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  createCliEngine,
  createExecEngine,
  expandTemplate,
  resolveRuntime,
} from './engine.js';
export type { CliEngine, CliEngineRuntime, CliEngineSpec, ExecEngineTemplate, ExecFormat } from './engine.js';
export { CLAUDE_CODE_SPEC, CODEX_SPEC, OPENCODE_SPEC, createCliEngines } from './engines.js';
export type { CliEngineId, CliEngineOptions } from './engines.js';
export { buildCliPrompt } from './prompt.js';
export { createEngineRegistry } from './registry.js';
export type { EngineRegistry, EngineStatus } from './registry.js';
export { createClaudeDialect, createCodexDialect, createOpencodeDialect, createTextDialect } from './dialects/index.js';
export { asBoolean, asNumber, asObject, asString, at, flattenNumbers, mergeNumbers } from './json.js';
export type { JsonObject } from './json.js';
