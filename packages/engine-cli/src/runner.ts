import { readJsonLines, type CliChild, type CliSpawn } from '@guhbot/agent';
import type { RunContext } from '@guhbot/host-core';
import { blockedFromText, describeBlocked, rateLimitSignal, type BlockedSignal, type RateLimitInfo } from './classify.js';
import { asObject, truncate, type JsonObject } from './json.js';
import { CliSpawnError } from './spawn.js';

/**
 * One CLI turn: spawn, stream, interpret, decide.
 *
 * Everything the four engines share lives here, so that cancellation, the turn
 * timeout, the environment and the rate-limit rule cannot differ between them.
 *
 * The interpreter half is a `CliDialect`, because that is the only part that
 * actually differs: Claude Code emits Anthropic messages, Codex emits items,
 * OpenCode emits session parts, and a template-driven engine emits whatever its
 * tool emits.
 */

/** How much of one tool result or command output reaches the transcript. */
const MAX_ENTRY_CHARS = 4000;
/** How much stderr is kept for a failure message. Secrets are not echoed; size is. */
const MAX_STDERR_CHARS = 8000;
/** How many raw stdout lines are kept to explain a failure with nothing parseable. */
const MAX_RECENT_LINES = 5;

export interface CliRunSink {
  /** Append answer text arrived from the CLI and emit it as a live delta. */
  text(delta: string): void;
  /** Record a tool the CLI decided to call, before its result is known. */
  toolCall(name: string, args: string): void;
  /** Record what a tool returned. */
  toolResult(name: string, output: string): void;
}

export interface CliTurnState {
  /** Answer text, in arrival order. */
  text: string;
  /** True once any answer text was accepted. A synthetic refusal does not count. */
  answered: boolean;
  costUsd: number | null;
  usage: Record<string, number> | null;
  model: string | null;
  sessionId: string | null;
  /** A structured refusal: the CLI says it cannot run at all right now. */
  blocked: BlockedSignal | null;
  /**
   * A usage limit the CLI reported, kept separate from `blocked` on purpose.
   *
   * `status: "rejected"` can still be served from overage, in which case the CLI
   * goes on to produce a real answer. The turn is only a refusal if the limit was
   * rejected *and* no answer arrived; that decision needs the whole turn, so it
   * is made once the process has exited.
   */
  rateLimit: RateLimitInfo | null;
  /** What the CLI printed alongside the limit, usually the human-local reset time. */
  rateLimitText: string | null;
  /** A structured fatal error the CLI reported on its stream. */
  error: { message: string; type: string | null } | null;
  /** The most recent non-fatal complaint, used when nothing else explains a failure. */
  warning: string | null;
}

export interface CliDialect {
  readonly id: string;
  /**
   * Whether a successful exit with no answer must fail the run.
   *
   * It should. An agent CLI that exits zero having said nothing is either
   * refusing silently or not signed in; reporting that as a completed turn with
   * an empty answer is the failure mode this whole package exists to avoid.
   */
  readonly requiresOutput: boolean;
  /** Interpret one parsed JSON object from stdout. */
  onEvent(event: JsonObject, state: CliTurnState, sink: CliRunSink): void;
  /** Interpret a stdout line that is not JSON (a banner, a warning, a spinner). */
  onLine?(line: string, state: CliTurnState, sink: CliRunSink): void;
}

export interface CliTurnResult {
  readonly engineId: string;
  readonly text: string;
  readonly costUsd: number | null;
  readonly usage: Readonly<Record<string, number>> | null;
  readonly model: string | null;
  readonly sessionId: string | null;
  readonly durationMs: number;
  readonly exitCode: number | null;
}

export class CliRunError extends Error {
  readonly engineId: string;
  /** The structured block, when the failure is "you cannot run now". */
  readonly blocked: BlockedSignal | null;
  readonly exitCode: number | null;

  constructor(message: string, options: { engineId: string; blocked?: BlockedSignal | null; exitCode?: number | null }) {
    super(message);
    this.name = 'CliRunError';
    this.engineId = options.engineId;
    this.blocked = options.blocked ?? null;
    this.exitCode = options.exitCode ?? null;
  }
}

export interface CliTurnRequest {
  readonly engineId: string;
  /** Display name, used verbatim in failure messages. */
  readonly engineName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly dialect: CliDialect;
  readonly spawn: CliSpawn;
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly context: RunContext;
  readonly signal: AbortSignal;
}

export function createTurnState(): CliTurnState {
  return {
    text: '',
    answered: false,
    costUsd: null,
    usage: null,
    model: null,
    sessionId: null,
    blocked: null,
    rateLimit: null,
    rateLimitText: null,
    error: null,
    warning: null,
  };
}

/**
 * Run one turn against a child process.
 *
 * Returns `null` when the turn was cancelled: the host already records the run
 * as interrupted, and inventing a failure for a user-initiated cancel would be
 * noise. Every other unhappy path throws `CliRunError`.
 */
export async function runCliTurn(request: CliTurnRequest): Promise<CliTurnResult | null> {
  const { context, signal, dialect } = request;
  const started = Date.now();
  if (signal.aborted || context.isCancelled()) return null;

  const state = createTurnState();
  const recentLines: string[] = [];
  let cancelled = false;
  let timedOut = false;
  let readError: unknown = null;

  // The entry this turn will append, so deltas land on the row that will hold
  // them once the turn is durable. Same convention as `AgentLoop`.
  const seq = context.history.length;
  const sink: CliRunSink = {
    text: (delta) => {
      if (delta.length === 0) return;
      state.text += delta;
      state.answered = true;
      context.emitDelta(seq, delta);
    },
    toolCall: (name, args) => {
      context.append({ role: 'agent', kind: 'tool-call', content: truncate(args, MAX_ENTRY_CHARS), toolName: name });
    },
    toolResult: (name, output) => {
      context.append({ role: 'tool', kind: 'tool-result', content: truncate(output, MAX_ENTRY_CHARS), toolName: name });
    },
  };

  let child: CliChild;
  try {
    child = request.spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      signal,
    });
  } catch (error) {
    throw new CliRunError(spawnFailureMessage(request, error), { engineId: request.engineId });
  }

  let ladderTimer: NodeJS.Timeout | null = null;
  const kill = (kind: NodeJS.Signals): void => {
    try {
      child.kill(kind);
    } catch {
      // The process is already gone. Killing twice is not an error.
    }
  };
  // SIGTERM first, SIGKILL only if the CLI ignores it. A CLI that traps SIGTERM
  // to finish writing its transcript gets the grace period; one that hangs does
  // not get to hang the run.
  const terminate = (): void => {
    kill('SIGTERM');
    if (ladderTimer !== null) return;
    ladderTimer = setTimeout(() => {
      ladderTimer = null;
      kill('SIGKILL');
    }, request.killGraceMs);
    ladderTimer.unref();
  };

  const onAbort = (): void => {
    cancelled = true;
    terminate();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs);
  timeout.unref();

  const stderrPromise = collect(child.stderr, MAX_STDERR_CHARS);

  try {
    for await (const item of readJsonLines(child.stdout)) {
      // The AbortSignal is the host's; `isCancelled()` covers an executor whose
      // caller wired the two independently.
      if (signal.aborted || context.isCancelled()) {
        if (!cancelled) {
          cancelled = true;
          terminate();
        }
      }
      // A cancelled or timed-out turn stops reading even if the child is still
      // dribbling output: the answer is already decided.
      if (cancelled || timedOut) break;
      if (item.ok === false) {
        recentLines.push(truncate(item.line, 400));
        if (recentLines.length > MAX_RECENT_LINES) recentLines.shift();
        dialect.onLine?.(item.line, state, sink);
        continue;
      }
      const event = asObject(item.value);
      // A JSON scalar or array on the stream is not an event; skipping it keeps
      // one odd line from ending the run.
      if (event !== null) dialect.onEvent(event, state, sink);
    }
  } catch (error) {
    readError = error;
  }

  const exit = await settleExit(child, request.killGraceMs + 3000);
  clearTimeout(timeout);
  signal.removeEventListener('abort', onAbort);
  if (ladderTimer !== null) clearTimeout(ladderTimer);
  const stderr = await stderrPromise;

  if (cancelled || signal.aborted) return null;

  if (exit.spawnError !== null) {
    throw new CliRunError(spawnFailureMessage(request, exit.spawnError), { engineId: request.engineId });
  }

  // A rejected limit with no answer is a refusal, however the process exited.
  // A rejected limit *with* an answer was served some other way and the turn
  // really did happen.
  if (state.blocked === null && state.rateLimit !== null && !state.answered) {
    state.blocked = rateLimitSignal(state.rateLimit, state.rateLimitText);
  }

  const durationMs = Date.now() - started;
  const diagnostic = firstDiagnostic(stderr, recentLines, state.warning);

  if (timedOut) {
    throw new CliRunError(
      `${request.engineName} was still running after ${formatDuration(request.timeoutMs)} and was stopped. ` +
        'Raise turnTimeoutMs for this engine, or give it a smaller task.' +
        (diagnostic.length > 0 ? ` Last output: ${diagnostic}` : ''),
      { engineId: request.engineId, exitCode: exit.code },
    );
  }

  if (readError !== null) {
    const message = readError instanceof Error ? readError.message : String(readError);
    throw new CliRunError(`${request.engineName} ended with a broken output stream: ${message}`, {
      engineId: request.engineId,
      exitCode: exit.code,
    });
  }

  if (state.blocked !== null) {
    // Structured refusal. This check sits before the exit code on purpose:
    // Claude Code has exited zero on a rate limit, and the exit code is not the
    // signal that matters.
    throw new CliRunError(describeBlocked(request.engineName, state.blocked), {
      engineId: request.engineId,
      blocked: state.blocked,
      exitCode: exit.code,
    });
  }

  if (state.error !== null) {
    const structured = blockedFromText(state.error.message) ?? (state.error.type === null ? null : blockedFromText(state.error.type));
    if (structured !== null) {
      throw new CliRunError(describeBlocked(request.engineName, { ...structured, cliText: state.error.message }), {
        engineId: request.engineId,
        blocked: { ...structured, cliText: state.error.message },
        exitCode: exit.code,
      });
    }
    throw new CliRunError(`${request.engineName} reported an error: ${truncate(state.error.message, 400)}`, {
      engineId: request.engineId,
      exitCode: exit.code,
    });
  }

  if (exit.code !== 0) {
    const text = diagnostic;
    const structured = blockedFromText(text);
    if (structured !== null) {
      throw new CliRunError(describeBlocked(request.engineName, structured), {
        engineId: request.engineId,
        blocked: structured,
        exitCode: exit.code,
      });
    }
    const how = exit.code === null ? `was killed by ${exit.signal ?? 'a signal'}` : `exited with code ${exit.code}`;
    throw new CliRunError(
      `${request.engineName} ${how}${text.length > 0 ? `: ${text}` : '.'}`,
      { engineId: request.engineId, exitCode: exit.code },
    );
  }

  if (dialect.requiresOutput && !state.answered) {
    // Exit zero, nothing said. Either the CLI is refusing in a way we did not
    // recognise, or it is not signed in. Both need the user, and neither is a
    // successful empty answer.
    throw new CliRunError(
      `${request.engineName} finished successfully without producing an answer, so the turn is treated as failed. ` +
        'Check that it is signed in by running it directly' +
        (diagnostic.length > 0 ? `. It last said: ${diagnostic}` : '.'),
      { engineId: request.engineId, exitCode: exit.code },
    );
  }

  return {
    engineId: request.engineId,
    text: state.text,
    costUsd: state.costUsd,
    usage: state.usage,
    model: state.model,
    sessionId: state.sessionId,
    durationMs,
    exitCode: exit.code,
  };
}

interface SettledExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly spawnError: unknown;
}

/**
 * Wait for the child to be reaped, but never forever.
 *
 * If SIGKILL was somehow ignored, the run still has to end: a host that hangs on
 * a wedged child is worse than a host that reports a failed turn.
 */
async function settleExit(child: CliChild, capMs: number): Promise<SettledExit> {
  let capTimer: NodeJS.Timeout | null = null;
  const capped = new Promise<SettledExit>((resolve) => {
    capTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      resolve({ code: null, signal: null, spawnError: null });
    }, capMs);
    capTimer.unref();
  });

  try {
    const settled = await Promise.race([
      child.exited.then((result) => ({ code: result.code, signal: result.signal, spawnError: null })),
      capped,
    ]);
    return settled;
  } catch (error) {
    return { code: null, signal: null, spawnError: error };
  } finally {
    if (capTimer !== null) clearTimeout(capTimer);
  }
}

async function collect(stream: AsyncIterable<Uint8Array | string>, max: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  try {
    for await (const chunk of stream) {
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      // Only the tail is kept: a CLI that logs megabytes of progress before
      // failing still has to produce a readable message.
      if (text.length > max) text = text.slice(text.length - max);
    }
    text += decoder.decode();
  } catch {
    // A killed child can break its own pipe. That is not a reason to fail the
    // classification, which is about what we already read.
  }
  return text;
}

function firstDiagnostic(stderr: string, recentLines: readonly string[], warning: string | null): string {
  const trimmedStderr = stderr.trim();
  if (trimmedStderr.length > 0) {
    const lines = trimmedStderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return truncate(lines.slice(-3).join(' '), 600);
  }
  if (recentLines.length > 0) return truncate(recentLines.join(' '), 600);
  return warning === null ? '' : truncate(warning, 600);
}

function spawnFailureMessage(request: CliTurnRequest, error: unknown): string {
  const code = error instanceof CliSpawnError ? error.code : null;
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'ENOENT') {
    return `${request.engineName} could not be started: "${request.command}" was not found. Install it, or point this engine at the executable.`;
  }
  return `${request.engineName} could not be started: ${detail}`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) {
    const minutes = milliseconds / 60_000;
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  return `${Math.round(milliseconds / 1000)}s`;
}
