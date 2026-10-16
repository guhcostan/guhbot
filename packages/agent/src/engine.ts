import type { RunExecutor } from '@guhbot/host-core';

/**
 * The engine seam.
 *
 * An "engine" is whatever actually does the work of an agent turn. Two families
 * exist, and they are interchangeable from the host's point of view:
 *
 *  - **Model engines** talk to a model API. `AgentLoop` is the one we ship; it is
 *    provider-agnostic and needs an API key.
 *  - **CLI engines** drive an agent that is already installed on the machine:
 *    Claude Code, Codex, OpenCode. They need no key, because the user is already
 *    signed in to a subscription they pay for.
 *
 * That second family is the reason this interface exists. Requiring an API key
 * excludes most of the people who would otherwise try this, and driving a CLI the
 * user already has is the shortest path from download to a working bot.
 *
 * Everything an engine produces is a `RunExecutor`, which is already the seam
 * `host-core` uses. So an engine cannot invent a new way to run work: it plugs
 * into the transcript, the approval flow and the budgets like anything else.
 */

export interface EngineDescriptor {
  /** Stable id used in configuration, e.g. `claude-code`. */
  readonly id: string;
  /** Display name, e.g. `Claude Code`. */
  readonly name: string;
  /** What has to be true for this engine to work, in one line. */
  readonly requirement: string;
}

export interface EngineProbe {
  /** The executable exists and can be started. */
  readonly available: boolean;
  /** Version string, when we could read one. */
  readonly version: string | null;
  /** Why it is unavailable, when it is not. Shown to the user verbatim. */
  readonly reason: string | null;
  /**
   * Set when the engine is installed but cannot currently work — a rate limit, a
   * signed-out session, an expired token.
   *
   * This is separate from `available` on purpose. "Not installed" and "installed
   * but throttled" need different advice, and a rate limit in particular must not
   * look like an empty successful answer.
   */
  readonly blocked: string | null;
}

export interface EngineRunOptions {
  /** Working directory the agent operates in. */
  readonly cwd: string;
  /** Model to request, when the engine supports choosing one. */
  readonly model?: string | undefined;
  /** Arguments passed through to the CLI verbatim, for engine-specific flags. */
  readonly extraArgs?: readonly string[] | undefined;
  /** Ceiling for one turn. A CLI that hangs must not hang the run forever. */
  readonly turnTimeoutMs?: number | undefined;
}

export interface Engine extends EngineDescriptor {
  /** Report whether this engine can run here, and why not if it cannot. */
  probe(): Promise<EngineProbe>;
  /** Build the executor for one host. */
  createExecutor(options: EngineRunOptions): RunExecutor;
}

/**
 * `spawn` used by the CLI engines, injectable so tests can drive a fake CLI.
 *
 * Real CLIs are not available in CI, need credentials, and change their output
 * format between versions. Injecting the process launcher is what lets the driver
 * logic — argument building, stream parsing, error classification — be tested
 * deterministically against a fixture script.
 */
export type CliSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => CliChild;

export interface CliChild {
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly stderr: AsyncIterable<Uint8Array | string>;
  readonly pid: number | undefined;
  /** Resolves with the exit code once the process ends. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  kill(signal?: NodeJS.Signals): void;
}

/**
 * A line-delimited JSON stream reader.
 *
 * Every agent CLI we drive emits newline-delimited JSON, and all of them will
 * occasionally emit a partial line, a blank line, or a line that is not JSON at
 * all (a banner, a warning, a progress spinner written to stdout by mistake).
 * Those are not errors; they are noise to skip. Getting this wrong makes the
 * engine appear to fail at random.
 */
export async function* readJsonLines(
  stream: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<{ ok: true; value: unknown } | { ok: false; line: string }> {
  const decoder = new TextDecoder();
  let buffer = '';

  const parse = (line: string): { ok: true; value: unknown } | { ok: false; line: string } => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return { ok: false, line: '' };
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch {
      return { ok: false, line: trimmed };
    }
  };

  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const parsed = parse(line);
      if (parsed.ok || parsed.line.length > 0) yield parsed;
      newline = buffer.indexOf('\n');
    }
  }

  buffer += decoder.decode();
  const tail = parse(buffer);
  if (tail.ok || tail.line.length > 0) yield tail;
}

/**
 * Classify a CLI failure into something a person can act on.
 *
 * Argument order, not prose, is what tells these apart in practice: every one of
 * these CLIs exits non-zero, and the difference between "you are not signed in"
 * and "you hit your weekly limit" decides whether the user goes to a login page or
 * waits until Thursday.
 */
export function classifyCliFailure(exitCode: number | null, output: string): { blocked: string | null; reason: string } {
  const text = output.toLowerCase();

  if (/rate.?limit|too many requests|429|weekly limit|usage limit/.test(text)) {
    return { blocked: 'the account has hit its rate limit', reason: 'rate limited' };
  }
  if (/not logged in|not signed in|please run .*login|unauthori[sz]ed|authentication|invalid api key|401/.test(text)) {
    return { blocked: 'not signed in', reason: 'authentication required' };
  }
  if (/command not found|not recognized|enoent/.test(text)) {
    return { blocked: null, reason: 'the executable was not found' };
  }
  if (/quota|billing|payment/.test(text)) {
    return { blocked: 'the account is out of quota', reason: 'quota exhausted' };
  }

  const hint = output.trim().split('\n').filter((l) => l.trim().length > 0).slice(-3).join(' ').slice(0, 400);
  return { blocked: null, reason: `exited with code ${exitCode ?? 'unknown'}${hint.length > 0 ? `: ${hint}` : ''}` };
}
