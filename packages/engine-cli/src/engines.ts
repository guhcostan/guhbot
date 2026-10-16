import type { CliSpawn, Engine, EngineRunOptions } from '@guhbot/agent';
import { createClaudeDialect, createCodexDialect, createOpencodeDialect, createTextDialect } from './dialects/index.js';
import { buildCliEnv } from './env.js';
import {
  createCliEngine,
  createExecEngine,
  resolveRuntime,
  type CliEngineRuntime,
  type CliEngineSpec,
  type ExecEngineTemplate,
  type ExecFormat,
} from './engine.js';
import type { CliDialect, CliTurnResult } from './runner.js';

/**
 * The shipped engines.
 *
 * Each one is an argv builder plus a dialect; everything else about how a turn
 * behaves is shared. The three names below were verified against the installed
 * binaries — the event shapes are recorded in `tests/fixtures/` so the driver is
 * tested without a subscription, a network, or the CLI itself.
 */

export type CliEngineId = 'claude-code' | 'codex' | 'opencode';

export interface CliEngineOptions {
  /** Process launcher. Defaults to the real one; tests inject a fixture-backed one. */
  spawn?: CliSpawn;
  /**
   * Extra environment for every engine. Applied *after* the allowlist filter, so
   * naming a credential here is the documented way to give a CLI its own.
   */
  env?: Record<string, string>;
  /**
   * Host environment to filter. Defaults to `process.env`.
   *
   * Passing a host environment other than this process's is how a caller keeps
   * the engine from inheriting anything it did not choose.
   */
  hostEnv?: NodeJS.ProcessEnv;
  /** Executable overrides, for an install that is not on PATH. */
  commands?: Partial<Record<CliEngineId, string>>;
  /** Default ceiling for one turn, per engine unless the run overrides it. */
  turnTimeoutMs?: number;
  /** Ceiling for a `--version` probe. */
  probeTimeoutMs?: number;
  /** How long a child may take to die after SIGTERM before SIGKILL. */
  killGraceMs?: number;
  /** Called once per finished turn, with cost and usage. Nothing secret is passed. */
  onTurnResult?: (result: CliTurnResult) => void;
  /** Additional template-driven engines. */
  exec?: readonly ExecEngineTemplate[];
}

export const CLAUDE_CODE_SPEC: CliEngineSpec = {
  id: 'claude-code',
  name: 'Claude Code',
  requirement: 'Claude Code installed and signed in (`claude` on PATH).',
  command: 'claude',
  versionArgs: ['--version'],
  buildArgs(prompt: string, options: EngineRunOptions): string[] {
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      // `--output-format stream-json` requires `--verbose` in every version seen
      // so far; without it the CLI refuses before printing anything.
      '--verbose',
      // Token-level deltas. Without it a long answer arrives as one finished
      // block and the client shows nothing for a minute. The dialect dedupes the
      // finished copy that follows the deltas, so enabling it cannot double text.
      '--include-partial-messages',
    ];
    if (options.model !== undefined) args.push('--model', options.model);
    if (options.extraArgs !== undefined) args.push(...options.extraArgs);
    return args;
  },
  dialect: createClaudeDialect,
};

export const CODEX_SPEC: CliEngineSpec = {
  id: 'codex',
  name: 'Codex',
  requirement: 'Codex installed and signed in with a ChatGPT plan or an API key (`codex` on PATH).',
  command: 'codex',
  versionArgs: ['--version'],
  buildArgs(prompt: string, options: EngineRunOptions): string[] {
    const args = [
      'exec',
      // Machine-readable events instead of the human transcript.
      '--json',
      // Codex refuses to run outside a directory it trusts, and every directory
      // that is not a git repository is untrusted by default. A host whose
      // working directory is not a checkout would otherwise get a refusal
      // instead of a turn, and the host has already decided which directory this
      // agent may work in, so refusing is not a useful second opinion.
      '--skip-git-repo-check',
    ];
    if (options.model !== undefined) args.push('--model', options.model);
    if (options.extraArgs !== undefined) args.push(...options.extraArgs);
    // `--` so a prompt that begins with a dash is a prompt, not a flag. The
    // prompt is still one argv element; it is never interpolated into a shell.
    args.push('--', prompt);
    return args;
  },
  dialect: createCodexDialect,
};

export const OPENCODE_SPEC: CliEngineSpec = {
  id: 'opencode',
  name: 'OpenCode',
  requirement: 'OpenCode installed and signed in to a model provider (`opencode` on PATH).',
  command: 'opencode',
  versionArgs: ['--version'],
  buildArgs(prompt: string, options: EngineRunOptions): string[] {
    const args = ['run', '--format', 'json'];
    if (options.model !== undefined) args.push('--model', options.model);
    if (options.extraArgs !== undefined) args.push(...options.extraArgs);
    args.push('--', prompt);
    return args;
  },
  dialect: createOpencodeDialect,
};

const SPECS: readonly CliEngineSpec[] = [CLAUDE_CODE_SPEC, CODEX_SPEC, OPENCODE_SPEC];

/**
 * Build every engine this package ships.
 *
 * The three known CLIs come first because their output is the part we have
 * verified; template-driven engines come last as the escape hatch. Nothing is
 * probed here — `probe()` is a separate, explicit call, so constructing the
 * engine list never blocks on a child process.
 */
export function createCliEngines(options: CliEngineOptions = {}): Engine[] {
  const runtime = resolveRuntime({
    // The child never inherits the host's environment wholesale: an allowlist
    // plus whatever the caller configured, exactly as the MCP stdio transport
    // does for a server it spawns.
    env: buildCliEnv(options.env, options.hostEnv ?? process.env),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    ...(options.onTurnResult === undefined ? {} : { onTurnResult: options.onTurnResult }),
  });

  // Re-keyed without the narrow id type: looking an override up by `spec.id`
  // must not need a cast, but callers still get typo protection on the option.
  const overrides: Partial<Record<string, string>> = options.commands ?? {};
  const engines: Engine[] = SPECS.map((spec) => createCliEngine(spec, runtime, overrides[spec.id] ?? spec.command));

  for (const template of options.exec ?? []) {
    engines.push(createExecEngine(template, runtime, (format) => dialectFor(format)));
  }

  return engines;
}

function dialectFor(format: ExecFormat): CliDialect {
  switch (format) {
    case 'claude-stream-json':
      return createClaudeDialect();
    case 'codex-json':
      return createCodexDialect();
    case 'opencode-json':
      return createOpencodeDialect();
    case 'text':
      return createTextDialect();
  }
}

/** Exposed so a caller can build one engine against its own runtime. */
export type { CliEngineRuntime };
