import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliChild, CliSpawn } from '@guhbot/agent';
import type { RunContext } from '@guhbot/host-core';
import { processSpawn as spawnReal } from '../src/spawn.js';

/**
 * Shared scaffolding for the engine tests.
 *
 * Everything here spawns a real child process. The engines' whole job is to
 * manage one, and a mocked process would happily accept a kill that never
 * reached anything.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FAKE_CLI_SOURCE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));

/** Absolute path to a recorded stream or error fixture. */
export function fixture(name: string): string {
  return join(FIXTURES, name);
}

const tempDirs: string[] = [];

/** A temp directory removed by `cleanupTempDirs`, one per test. */
export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guhbot-engine-cli-'));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Install an executable stand-in for a CLI into a fresh temp directory.
 *
 * `mkdtempSync` per test keeps two tests from sharing a pid or signal file, and
 * the copy is made executable because the engine starts it as a program, not
 * through a shell.
 */
export function installFakeCli(): string {
  const dir = makeTempDir();
  const target = join(dir, 'fake-cli');
  copyFileSync(FAKE_CLI_SOURCE, target);
  chmodSync(target, 0o755);
  return target;
}

export interface RecordedEntry {
  readonly role: string;
  readonly kind: string;
  readonly content: string;
  readonly toolName: string | null;
}

export interface RecordedDelta {
  readonly seq: number;
  readonly text: string;
}

export interface FakeContext {
  readonly context: RunContext;
  readonly entries: RecordedEntry[];
  readonly deltas: RecordedDelta[];
}

/**
 * A `RunContext` that records instead of writing to a database.
 *
 * Shaped after the fake in `packages/agent/tests/loop.test.ts` so the two seams
 * are exercised the same way.
 */
export function fakeContext(options: { prompt?: string; history?: RunContext['history']; cancelled?: boolean } = {}): FakeContext {
  const entries: RecordedEntry[] = [];
  const deltas: RecordedDelta[] = [];

  const context: RunContext = {
    run: {
      id: 'run_1',
      agentId: 'ag_1',
      status: 'running',
      promptEntryId: null,
      error: null,
      startedAt: '',
      endedAt: null,
    },
    agent: {
      id: 'ag_1',
      name: 'Tester',
      status: 'active',
      instructions: '',
      model: null,
      avatarUrl: null,
      hidden: false,
      draftingDisabled: false,
      notifyOnUpdates: true,
      unreadCount: 0,
      createdAt: '',
      updatedAt: '',
    },
    prompt: options.prompt ?? 'do the thing',
    history: options.history ?? [],
    append: (input) => {
      entries.push({ role: input.role, kind: input.kind, content: input.content, toolName: input.toolName ?? null });
      const entry: ReturnType<RunContext['append']> = {
        id: `en_${entries.length}`,
        agentId: 'ag_1',
        seq: entries.length - 1,
        runId: 'run_1',
        role: input.role,
        kind: input.kind,
        content: input.content,
        toolName: input.toolName ?? null,
        createdAt: '',
      };
      return entry;
    },
    emitDelta: (seq, textDelta) => {
      deltas.push({ seq, text: textDelta });
    },
    readSecret: () => null,
    requestApproval: async (input) => ({
      id: 'ap_1',
      agentId: 'ag_1',
      runId: 'run_1',
      kind: 'tool-permission',
      status: 'denied',
      summary: input.summary,
      detail: '{}',
      createdAt: '',
      expiresAt: null,
      resolvedAt: null,
      resolutionNote: null,
    }),
    isCancelled: () => options.cancelled ?? false,
  };

  return { context, entries, deltas };
}

export interface CapturedSpawn {
  readonly calls: { command: string; args: string[]; cwd: string }[];
  readonly spawn: CliSpawn;
}

/**
 * A launcher that records the argv it was asked for and runs something else.
 *
 * This is how argument building is tested through the real code path rather than
 * by reimplementing it: the engine still spawns a process, but the executable is
 * the fixture and the argv is kept for the assertion.
 */
export function recordingSpawn(replacement: string, replacementArgs: string[] = []): CapturedSpawn {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const spawn: CliSpawn = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    return spawnReal(replacement, replacementArgs, options);
  };
  return { calls, spawn };
}

// Imported lazily so the module reads as one unit while still using the real
// launcher the engines default to.

/** Poll until `check` is true, or throw after `timeoutMs`. */
export async function waitFor(check: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/** Signals the fixture recorded, in order. */
export function observedSignals(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** A minimal `CliChild` for the tests that must not start a process. */
export function scriptedChild(exitCode: number, stdoutLines: string[]): CliChild {
  return {
    stdout: (async function* () {
      for (const line of stdoutLines) yield `${line}\n`;
    })(),
    stderr: (async function* () {})(),
    pid: 4242,
    exited: Promise.resolve({ code: exitCode, signal: null }),
    kill: () => undefined,
  };
}
