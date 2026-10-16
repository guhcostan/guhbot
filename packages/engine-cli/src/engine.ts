import { tmpdir } from 'node:os';
import type { CliChild, CliSpawn, Engine, EngineProbe, EngineRunOptions } from '@guhbot/agent';
import type { RunContext, RunExecutor } from '@guhbot/host-core';
import { describeBlocked } from './classify.js';
import { truncate } from './json.js';
import { buildCliPrompt } from './prompt.js';
import { CliRunError, runCliTurn, type CliDialect, type CliTurnResult } from './runner.js';
import { CliSpawnError, processSpawn } from './spawn.js';

/**
 * The spine every CLI engine shares.
 *
 * A CLI engine is four things: how to find the executable, how to build its
 * argv, how to read its output, and what it costs. Only the first three differ
 * between Claude Code, Codex, OpenCode and a template-driven command, so they
 * are the whole of an `CliEngineSpec` and everything else — streaming,
 * cancellation, timeouts, the environment, the rate-limit rule — is inherited
 * from `runCliTurn`.
 */

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;
export const DEFAULT_KILL_GRACE_MS = 2000;

export interface CliEngineRuntime {
  readonly spawn: CliSpawn;
  /** Already filtered; never the host's whole environment. */
  readonly env: Record<string, string>;
  readonly turnTimeoutMs: number;
  readonly probeTimeoutMs: number;
  readonly killGraceMs: number;
  readonly onTurnResult: ((result: CliTurnResult) => void) | undefined;
}

export interface CliEngineSpec {
  readonly id: string;
  readonly name: string;
  readonly requirement: string;
  /** Default executable; a caller may point the engine at another one. */
  readonly command: string;
  readonly versionArgs: readonly string[];
  /** argv for one turn, prompt included. */
  buildArgs(prompt: string, options: EngineRunOptions): string[];
  /** A fresh dialect per turn, so two concurrent runs cannot share state. */
  readonly dialect: () => CliDialect;
}

export interface CliEngine extends Engine {
  /** The exact argv this engine would use. Exposed so a UI can show it. */
  buildArgs(prompt: string, options: EngineRunOptions): string[];
}

export function createCliEngine(spec: CliEngineSpec, runtime: CliEngineRuntime, command: string): CliEngine {
  // Last observed block, reported by `probe` so a status surface can say
  // "installed, but rate limited" instead of just "installed". Cleared by the
  // next turn that actually completes.
  let lastBlocked: string | null = null;

  return {
    id: spec.id,
    name: spec.name,
    requirement: spec.requirement,

    buildArgs: (prompt, options) => spec.buildArgs(prompt, options),

    async probe(): Promise<EngineProbe> {
      const probed = await probeExecutable(runtime, spec, command);
      return {
        available: probed.available,
        version: probed.version,
        reason: probed.reason,
        blocked: lastBlocked,
      };
    },

    createExecutor(options: EngineRunOptions): RunExecutor {
      return {
        execute: async (context: RunContext, signal: AbortSignal): Promise<void> => {
          try {
            const result = await runCliTurn({
              engineId: spec.id,
              engineName: spec.name,
              command,
              // The CLI sees the recent conversation rendered into the prompt;
              // it has no other way to know what a follow-up refers to.
              args: spec.buildArgs(buildCliPrompt(context), options),
              cwd: options.cwd,
              env: runtime.env,
              dialect: spec.dialect(),
              spawn: runtime.spawn,
              timeoutMs: options.turnTimeoutMs ?? runtime.turnTimeoutMs,
              killGraceMs: runtime.killGraceMs,
              context,
              signal,
            });
            if (result === null) return;

            if (result.text.trim().length > 0) {
              context.append({ role: 'agent', kind: 'message', content: result.text });
            }
            if (result.costUsd !== null && result.costUsd > 0) {
              // SECURITY.md lists "no cost budget per agent" as a known gap. This
              // is the first place real spend is knowable, so it goes in the
              // transcript where the user will see it rather than a log line.
              context.append({
                role: 'system',
                kind: 'status',
                content: `${spec.name} reported $${result.costUsd.toFixed(4)} of usage for this turn.`,
              });
            }
            lastBlocked = null;
            try {
              runtime.onTurnResult?.(result);
            } catch {
              // The turn already happened and is already in the transcript. A bug
              // in a caller's reporting hook must not turn a finished turn into a
              // failed run.
            }
          } catch (error) {
            if (error instanceof CliRunError) {
              if (error.blocked !== null) lastBlocked = describeBlocked(spec.name, error.blocked);
              // The host records the run as failed; the transcript records why,
              // which is the part the user actually reads.
              context.append({ role: 'system', kind: 'error', content: error.message });
            }
            throw error;
          }
        },
      };
    },
  };
}

interface ProbedExecutable {
  readonly available: boolean;
  readonly version: string | null;
  /** Set whenever there is something to tell the user, available or not. */
  readonly reason: string | null;
}

/**
 * Run `<cli> --version` and report honestly.
 *
 * A missing binary is a normal outcome (`available: false` with a reason), never
 * an exception: a host that probes every engine at boot must not fall over
 * because one of them is not installed.
 */
async function probeExecutable(
  runtime: CliEngineRuntime,
  spec: CliEngineSpec,
  command: string,
): Promise<ProbedExecutable> {
  let child: CliChild;
  try {
    child = runtime.spawn(command, [...spec.versionArgs], {
      // Not the user's project: a version check has no business writing state
      // into the directory the agent was pointed at.
      cwd: tmpdir(),
      env: runtime.env,
    });
  } catch (error) {
    return { available: false, version: null, reason: startFailure(command, error) };
  }

  const stdout = collectText(child.stdout);
  const stderr = collectText(child.stderr);

  let exit: { code: number | null; signal: string | null } | null = null;
  let failure: unknown = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }, runtime.probeTimeoutMs);
  timer.unref();
  try {
    exit = await child.exited;
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
  }

  const [out, err] = await Promise.all([stdout, stderr]);

  if (failure !== null) return { available: false, version: null, reason: startFailure(command, failure) };

  const line = firstLine(out) ?? firstLine(err);
  const version = line === null ? null : truncate(line, 200);

  if (timedOut || exit === null) {
    // The executable exists — it started — it just never answered. Saying
    // "unavailable" here would be wrong, and saying "installed" without the
    // caveat would hide a real problem.
    //
    // The version is deliberately null rather than the first line we happened to
    // read. `--version` is the one question this process did not answer, and what
    // it prints instead is not a version: a banner, a progress line, or a JSON
    // event. Reporting that as the version is worse than reporting nothing,
    // because a caller has no way to tell it apart from a real one — and whether
    // the line arrived before the kill is a race, which is how this was found.
    return {
      available: true,
      version: null,
      reason: `${spec.name} did not answer "${[...spec.versionArgs].join(' ')}" within ${runtime.probeTimeoutMs}ms.`,
    };
  }
  if (exit.code !== 0) {
    const tail = firstLine(err);
    const how = exit.code === null ? `was killed by ${exit.signal ?? 'a signal'}` : `exited with code ${exit.code}`;
    return {
      available: true,
      version,
      reason:
        `${spec.name} is installed but "${command} ${[...spec.versionArgs].join(' ')}" ${how}` +
        (tail === null ? '.' : `: ${truncate(tail, 200)}`),
    };
  }
  return { available: true, version, reason: null };
}

function startFailure(command: string, error: unknown): string {
  const code = error instanceof CliSpawnError ? error.code : null;
  if (code === 'ENOENT') return `"${command}" was not found on PATH. Install it, or point this engine at the executable.`;
  const detail = error instanceof Error ? error.message : String(error);
  return `"${command}" could not be started: ${detail}`;
}

function firstLine(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

async function collectText(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  try {
    for await (const chunk of stream) {
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      if (text.length > 4096) text = text.slice(0, 4096);
    }
  } catch {
    // A process that died mid-write is still probed on what it managed to say.
  }
  return text;
}

/**
 * A generic engine driven by a template.
 *
 * This is what makes the package extensible without a code change per tool: any
 * command that prints one of the known JSONL dialects, or plain lines, can be an
 * engine. `{prompt}`, `{cwd}` and `{model}` are the placeholders; the prompt is
 * always passed as a single argv element, never interpolated into a shell.
 */
export interface ExecEngineTemplate {
  readonly id: string;
  readonly name: string;
  readonly requirement: string;
  readonly command: string;
  /** argv template. Must contain `{prompt}`. */
  readonly args: readonly string[];
  /** Which JSONL dialect stdout speaks. Defaults to `text`. */
  readonly format?: ExecFormat;
  readonly versionArgs?: readonly string[];
  /** Extra child environment for this engine only. */
  readonly env?: Record<string, string>;
  /** Per-engine turn ceiling, overriding the package default. */
  readonly turnTimeoutMs?: number;
}

export type ExecFormat = 'claude-stream-json' | 'codex-json' | 'opencode-json' | 'text';

export function createExecEngine(
  template: ExecEngineTemplate,
  runtime: CliEngineRuntime,
  dialectFor: (format: ExecFormat) => CliDialect,
): CliEngine {
  if (!template.args.includes('{prompt}') && !template.args.some((arg) => arg.includes('{prompt}'))) {
    // Fail at construction rather than on the first turn: a template that never
    // receives the prompt is a configuration bug, and finding it during setup is
    // worth far more than finding it in a failed run.
    throw new Error(
      `exec engine "${template.id}" has no {prompt} placeholder in args, so the prompt would never reach it. ` +
        'Add {prompt} where the tool expects its message.',
    );
  }

  const spec: CliEngineSpec = {
    id: template.id,
    name: template.name,
    requirement: template.requirement,
    command: template.command,
    versionArgs: template.versionArgs ?? ['--version'],
    buildArgs: (prompt, options) => expandTemplate(template.args, prompt, options),
    dialect: () => dialectFor(template.format ?? 'text'),
  };

  const scoped: CliEngineRuntime = {
    ...runtime,
    env: { ...runtime.env, ...(template.env ?? {}) },
    ...(template.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: template.turnTimeoutMs }),
  };

  return createCliEngine(spec, scoped, template.command);
}

/**
 * Expand a template's placeholders.
 *
 * When `{model}` has no value, the element that contains it is dropped *along
 * with a bare flag immediately before it*: `--model {model}` must disappear as a
 * pair, because leaving `--model` with nothing after it makes the CLI fail in a
 * way that has nothing to do with what the user asked for.
 */
export function expandTemplate(args: readonly string[], prompt: string, options: EngineRunOptions): string[] {
  const values: Record<string, string | null> = {
    prompt,
    cwd: options.cwd,
    model: options.model ?? null,
  };

  const expanded: string[] = [];
  for (const arg of args) {
    const modelMissing = arg.includes('{model}') && values['model'] === null;
    if (modelMissing) {
      const previous = expanded[expanded.length - 1];
      if (previous !== undefined && previous.startsWith('-') && !previous.includes('{')) expanded.pop();
      continue;
    }
    expanded.push(
      arg.replace(/\{(prompt|cwd|model)\}/g, (_match, key: string) => values[key] ?? ''),
    );
  }

  if (options.extraArgs !== undefined) expanded.push(...options.extraArgs);
  return expanded;
}

/** Resolve the engine options into the runtime every engine shares. */
export function resolveRuntime(options: {
  spawn?: CliSpawn;
  env?: Record<string, string>;
  turnTimeoutMs?: number;
  probeTimeoutMs?: number;
  killGraceMs?: number;
  onTurnResult?: (result: CliTurnResult) => void;
}): CliEngineRuntime {
  return {
    spawn: options.spawn ?? processSpawn,
    env: options.env ?? {},
    turnTimeoutMs: options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    onTurnResult: options.onTurnResult,
  };
}
