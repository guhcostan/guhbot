import { spawn } from 'node:child_process';
import type { CliChild, CliSpawn } from '@guhbot/agent';

/**
 * The real process launcher.
 *
 * Three decisions here are deliberate and load-bearing:
 *
 *  - **stdin is closed.** `codex exec` with a prompt argument still reads stdin
 *    when it is a pipe and only stops at EOF, so an inherited or open pipe makes
 *    the run hang forever with no output. `ignore` gives the child an immediate
 *    EOF.
 *  - **The child gets its own process group on POSIX.** An agent CLI spawns its
 *    own children (MCP servers, shell tools). Killing only the direct child
 *    leaves those running after the user cancels, which is exactly the bug we
 *    refuse.
 *  - **The abort signal is not forwarded to `spawn`.** The runner owns the
 *    SIGTERM-then-SIGKILL ladder through `CliChild.kill`, so there is one kill
 *    path that tests can observe rather than two racing ones.
 */
export function createProcessSpawn(): CliSpawn {
  return (command, args, options) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    return wrapChild(child);
  };
}

/** The default launcher, already bound. */
export const processSpawn: CliSpawn = createProcessSpawn();

/** A failure to start the process at all, e.g. the binary is not on PATH. */
export class CliSpawnError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'CliSpawnError';
    this.code = code;
  }
}

type RealChild = ReturnType<typeof spawn>;

function wrapChild(child: RealChild): CliChild {
  let settled = false;

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    // 'close' rather than 'exit': the streams must be drained before the exit
    // code is interpreted, or the last lines of a failing run are lost.
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    });
    child.once('error', (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(new CliSpawnError(describeSpawnError(error), errorCode(error)));
    });
  });
  // A caller may legitimately stop awaiting `exited` (a run that is cancelled
  // before the process is reaped); without this the rejection is reported as an
  // unhandled rejection and can take the host process down.
  exited.catch(() => undefined);

  return {
    stdout: child.stdout ?? emptyStream(),
    stderr: child.stderr ?? emptyStream(),
    pid: child.pid,
    exited,
    kill: (signal = 'SIGTERM') => {
      // Node's own kill refuses to signal a reaped pid, which is what keeps a
      // recycled pid safe. Mirror that guard for the process-group path.
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // No group (or it is already gone); fall through to the direct child.
        }
      }
      child.kill(signal);
    },
  };
}

async function* emptyStream(): AsyncGenerator<Uint8Array> {
  // Yields nothing. Only reachable when a caller passes a launcher whose stdio
  // is not piped; the engine never does.
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function describeSpawnError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 0 ? message : 'the process could not be started';
}
