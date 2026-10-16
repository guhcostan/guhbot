import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildChildEnv } from '../env.js';
import { McpError, errorMessage } from '../errors.js';
import {
  PendingRequests,
  encodeMessage,
  isNotification,
  isResponse,
  isServerRequest,
  parseJsonRpcMessage,
  parseJsonRpcText,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from '../jsonrpc.js';
import { linkSignals, unsupportedRequestError, type CallOptions, type McpTransport, type TransportHooks } from '../transport.js';

/**
 * stdio transport: a child process, newline-delimited JSON-RPC on its stdin and
 * stdout.
 *
 * This is how most local MCP servers ship (`npx -y <server>`), which also makes
 * it the most dangerous transport: the command is arbitrary code execution
 * configured by whoever wrote the config. Two rules follow from that and are
 * enforced here rather than only in the manager, so no future caller can skip
 * them:
 *
 *   - `allowStdio` must be true. The opt-in is explicit, not implied by a
 *     command being present.
 *   - the command always arrives as an argv array with `shell: false`, so a
 *     tool name or an argument can never become shell syntax.
 */

const MAX_LINE_CHARS = 32 * 1024 * 1024;
const STDERR_TAIL_LINES = 20;

export interface StdioTransportOptions extends TransportHooks {
  serverName: string;
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  /** Explicit human opt-in to spawning a local process. Required. */
  allowStdio: boolean;
  /** How long a server gets to exit on SIGTERM before SIGKILL. */
  killGraceMs?: number | undefined;
}

export class StdioTransport implements McpTransport {
  readonly kind = 'stdio' as const;

  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending: PendingRequests;
  private stdoutBuffer = '';
  private exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly stderrTail: string[] = [];
  private closing = false;

  constructor(private readonly options: StdioTransportOptions) {
    this.pending = new PendingRequests(
      (method) => new McpError('timeout', `MCP server "${options.serverName}" timed out answering ${method}`),
    );
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<void> {
    if (!this.options.allowStdio) {
      throw new McpError(
        'refused',
        `refusing to spawn "${this.options.command}" for MCP server "${this.options.serverName}": ` +
          'a stdio server is arbitrary code execution, so it needs an explicit opt-in. ' +
          'Pass allowStdio: true (and a human decision to run it) before configuring a stdio server.',
      );
    }
    if (this.child) return;

    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: buildChildEnv(this.options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    trackChild(child);

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        this.child = null;
        untrackChild(child);
        reject(
          new McpError(
            'closed',
            `could not start MCP server "${this.options.serverName}" (${this.options.command}): ${error.message}`,
          ),
        );
      };
      const cleanup = (): void => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk));
    // A write to a dead child's stdin emits EPIPE on the stream. Without a
    // listener that is an unhandled 'error' event and takes the host down; the
    // death itself is reported by the 'exit' handler instead.
    child.stdin.on('error', () => undefined);
    child.on('error', (error: Error) => {
      this.fail(new McpError('closed', `MCP server "${this.options.serverName}" failed: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      this.exit = { code, signal };
      untrackChild(child);
      if (this.child === child) this.child = null;
      this.fail(
        new McpError(
          'closed',
          `MCP server "${this.options.serverName}" exited ${describeExit(code, signal)} while a request was in flight`,
        ),
      );
    });
  }

  async call(method: string, params: Record<string, unknown> | undefined, options: CallOptions): Promise<unknown> {
    const { id, promise } = this.pending.begin(method, options.timeoutMs);
    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    const link = linkSignals([options.signal]);
    const onAbort = (): void => {
      this.pending.cancel(id, new McpError('cancelled', `MCP request ${method} to "${this.options.serverName}" was cancelled`));
    };
    if (link.signal.aborted) onAbort();
    else link.signal.addEventListener('abort', onAbort, { once: true });

    try {
      this.write(encodeMessage(message));
      return await promise;
    } finally {
      link.signal.removeEventListener('abort', onAbort);
      link.cleanup();
    }
  }

  async notify(method: string, params?: Record<string, unknown> | undefined): Promise<void> {
    // No id: the server must not answer this, and nothing waits for it.
    this.write(encodeMessage({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }));
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    this.child = null;
    this.pending.failAll(new McpError('closed', `MCP server "${this.options.serverName}" was shut down`));
    if (!child) return;
    untrackChild(child);
    await terminate(child, this.options.killGraceMs ?? 2000);
  }

  /** Last stderr lines, for diagnostics. Never placed in a tool result. */
  stderrTail(): string[] {
    return [...this.stderrTail];
  }

  private write(payload: string): void {
    const child = this.child;
    if (!child || child.stdin.destroyed || this.exit) {
      throw new McpError(
        'closed',
        `MCP server "${this.options.serverName}" is not running${this.exit ? ` (it exited ${describeExit(this.exit.code, this.exit.signal)})` : ''}`,
      );
    }
    child.stdin.write(`${payload}\n`);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_LINE_CHARS) {
      this.fail(
        new McpError('protocol', `MCP server "${this.options.serverName}" sent a line larger than ${MAX_LINE_CHARS} characters`),
      );
      return;
    }

    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const message = parseJsonRpcText(line);
    if (!message) {
      // A server that logs to stdout instead of stderr is broken but common;
      // dropping the line keeps the rest of the session usable.
      this.options.onLog?.(`mcp/${this.options.serverName}: ignoring a stdout line that is not JSON-RPC`);
      return;
    }
    this.handleMessage(message);
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      if (!this.pending.settle(message)) {
        this.options.onLog?.(`mcp/${this.options.serverName}: ignoring a response with an unknown id`);
      }
      return;
    }
    if (isServerRequest(message)) {
      this.answerUnsupported(message);
      return;
    }
    if (isNotification(message)) {
      // Never awaited and never replied to: a notification has no id, so there
      // is nothing to correlate and a reply would be a protocol violation.
      this.options.onNotification?.(message);
    }
  }

  private answerUnsupported(request: JsonRpcRequest): void {
    try {
      this.write(encodeMessage(unsupportedRequestError(request)));
    } catch {
      // The server is already gone; its pending reply is failing on its own.
    }
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      this.stderrTail.push(trimmed);
      if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
      this.options.onLog?.(`mcp/${this.options.serverName}: ${trimmed}`);
    }
  }

  private fail(error: Error): void {
    if (this.closing) return;
    this.pending.failAll(error);
  }
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `on ${signal}`;
  return `with code ${code ?? 'unknown'}`;
}

/**
 * Live child processes, module-wide.
 *
 * A host that forgets to dispose the capability, or dies on an unhandled error,
 * must not leave an MCP server running on the user's machine. The exit hook is
 * the last line of defence: `child.kill` is synchronous, so it works from an
 * `exit` handler where nothing else does.
 */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const live of liveChildren) {
      try {
        live.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
    liveChildren.clear();
  });
}

function untrackChild(child: ChildProcess): void {
  liveChildren.delete(child);
}

/**
 * Stop a child: SIGTERM, then SIGKILL if it is still there.
 *
 * SIGKILL is not optional. A server that traps SIGTERM would otherwise outlive
 * the host, and shutdown would hang on an await that never resolves.
 */
export function terminate(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve();
    };

    child.once('exit', finish);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
      return;
    }

    const termTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        finish();
      }
    }, graceMs);
    // The child process handle keeps the event loop alive, so these timers run;
    // they are unref'd so a forcible shutdown path is never delayed by them.
    const killTimer = setTimeout(finish, graceMs * 2 + 1000);
    termTimer.unref?.();
    killTimer.unref?.();
  });
}
