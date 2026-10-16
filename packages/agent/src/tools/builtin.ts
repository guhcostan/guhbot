import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ToolDefinition, ToolExecutionContext } from '../types.js';

/**
 * Built-in tools.
 *
 * Two rules run through all of them:
 *
 *  1. **Stay inside the working directory.** Every path is resolved and then
 *     checked against the root. We resolve first and compare the *resolved*
 *     path, which is what defeats `../` traversal and, through `realpath`,
 *     symlinks that point outside the jail. (The Grok Bot bundle ships a
 *     dedicated `NoFollowRefusedError` for the same class of problem, which is
 *     a reasonable signal that this is where the real risk lives.)
 *  2. **Mutations need a human.** Reads do not ask, writes and command
 *     execution do. That split is what lets an agent work unattended overnight
 *     without being able to destroy anything it was not told to touch.
 */

const execFileAsync = promisify(execFile);

export interface BuiltinToolOptions {
  /**
   * Hosts `http_fetch` may reach. Empty means no network access at all, which is
   * the default: an agent that can fetch any URL can exfiltrate anything it can
   * read, so egress is opt-in per host.
   */
  allowedHosts?: string[];
  /** Commands `run_command` will never run, matched on the first token. */
  deniedCommands?: string[];
  /** Wall-clock ceiling for one command. */
  commandTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_DENIED = ['sudo', 'su', 'shutdown', 'reboot', 'mkfs', 'dd', 'diskutil'];

/**
 * Resolve `candidate` under `root` and refuse anything that escapes.
 *
 * Two checks, because either alone is insufficient:
 *
 *  - **Lexical.** Resolve the path and confirm it still sits under the root.
 *    Catches `../` traversal and absolute paths. Cheap, no I/O.
 *  - **Canonical.** Resolve the nearest *existing* ancestor through `realpath`
 *    and confirm that is still under the root. Catches a symlinked directory
 *    used to step outside the jail, including for a file that does not exist yet.
 *
 * The returned path is built from the caller's `root`, not from its canonical
 * form, so relative paths echoed back to the user look the way they were
 * written. On macOS this matters: `/var` is a symlink to `/private/var`, and
 * returning the canonical form would make every reported path unrecognisable.
 */
export async function resolveInside(root: string, candidate: string): Promise<string> {
  const rootAbs = resolve(root);
  const rootReal = await realpath(rootAbs).catch(() => rootAbs);
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(rootAbs, candidate);

  const insideLexically = (base: string): boolean => target === base || target.startsWith(base + sep);
  if (!insideLexically(rootAbs) && !insideLexically(rootReal)) {
    throw new Error(`path escapes the working directory: ${candidate}`);
  }

  // Walk up to the nearest ancestor that exists and canonicalise it.
  //
  // The walk stops at the jail root rather than continuing to the filesystem
  // root. Otherwise a working directory that does not exist yet (an agent
  // writing its first file) walks past the root, finds an ancestor that is
  // legitimately outside the jail, and rejects a path that is perfectly legal.
  let probe = target;
  for (;;) {
    if (probe === rootAbs) break;
    try {
      const real = await realpath(probe);
      if (real !== rootReal && !real.startsWith(rootReal + sep)) {
        throw new Error(`path resolves outside the working directory via a link: ${candidate}`);
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      const parent = resolve(probe, '..');
      // Reached the filesystem root without finding anything that exists.
      if (parent === probe) break;
      probe = parent;
    }
  }

  return target;
}

function asObject(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('tool arguments must be a JSON object');
  }
  return args as Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

export function builtinTools(options: BuiltinToolOptions = {}): ToolDefinition[] {
  const allowedHosts = new Set(options.allowedHosts ?? []);
  const deniedCommands = new Set(
    (options.deniedCommands ?? DEFAULT_DENIED).map((c) => c.toLowerCase()),
  );
  const timeout = options.commandTimeoutMs ?? 120_000;
  const doFetch = options.fetchImpl ?? fetch;

  const tools: ToolDefinition[] = [
    {
      name: 'list_dir',
      description: 'List the entries of a directory inside the working directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path, relative to the working directory.' } },
        required: [],
      },
      requiresApproval: false,
      execute: async (rawArgs, ctx) => {
        const args = asObject(rawArgs);
        const target = await resolveInside(ctx.cwd, typeof args['path'] === 'string' ? args['path'] : '.');
        const entries = await readdir(target, { withFileTypes: true });
        if (entries.length === 0) return '(empty directory)';
        return entries
          .map((e) => `${e.isDirectory() ? 'dir  ' : 'file '} ${e.name}`)
          .sort()
          .join('\n');
      },
    },

    {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the working directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, relative to the working directory.' },
          max_bytes: { type: 'number', description: 'Truncate after this many bytes (default 100000).' },
        },
        required: ['path'],
      },
      requiresApproval: false,
      execute: async (rawArgs, ctx) => {
        const args = asObject(rawArgs);
        const target = await resolveInside(ctx.cwd, requireString(args, 'path'));
        const limit = typeof args['max_bytes'] === 'number' ? args['max_bytes'] : 100_000;
        const info = await stat(target);
        if (!info.isFile()) throw new Error('not a regular file');
        const bytes = await readFile(target);
        const slice = bytes.subarray(0, limit);
        const suffix = bytes.length > limit ? `\n\n[truncated: showed ${limit} of ${bytes.length} bytes]` : '';
        return slice.toString('utf8') + suffix;
      },
    },

    {
      name: 'search_files',
      description: 'Find files whose name or contents contain a literal string.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Literal text to look for.' },
          path: { type: 'string', description: 'Directory to search, relative to the working directory.' },
          max_results: { type: 'number', description: 'Stop after this many matches (default 40).' },
        },
        required: ['query'],
      },
      requiresApproval: false,
      execute: async (rawArgs, ctx) => {
        const args = asObject(rawArgs);
        const query = requireString(args, 'query');
        const root = await resolveInside(ctx.cwd, typeof args['path'] === 'string' ? args['path'] : '.');
        const max = typeof args['max_results'] === 'number' ? args['max_results'] : 40;
        const hits: string[] = [];
        const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.cache']);

        const walk = async (dir: string, depth: number): Promise<void> => {
          if (hits.length >= max || depth > 8 || ctx.signal.aborted) return;
          let entries;
          try {
            entries = await readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (hits.length >= max) return;
            if (entry.isDirectory()) {
              if (skipDirs.has(entry.name)) continue;
              await walk(join(dir, entry.name), depth + 1);
              continue;
            }
            if (!entry.isFile()) continue;
            const full = join(dir, entry.name);
            const shown = relative(ctx.cwd, full);
            if (entry.name.includes(query)) {
              hits.push(`${shown} (name match)`);
              continue;
            }
            try {
              const info = await stat(full);
              if (info.size > 2_000_000) continue;
              const text = await readFile(full, 'utf8');
              const index = text.indexOf(query);
              if (index !== -1) {
                const line = text.slice(0, index).split('\n').length;
                const excerpt = text.slice(Math.max(0, index - 60), index + query.length + 60).replace(/\s+/g, ' ');
                hits.push(`${shown}:${line}  ...${excerpt}...`);
              }
            } catch {
              // Binary or unreadable; skip.
            }
          }
        };

        await walk(root, 0);
        return hits.length === 0 ? `No matches for ${JSON.stringify(query)}.` : hits.join('\n');
      },
    },

    {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file inside the working directory. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, relative to the working directory.' },
          content: { type: 'string', description: 'Full file contents to write.' },
        },
        required: ['path', 'content'],
      },
      requiresApproval: true,
      execute: async (rawArgs, ctx) => {
        const args = asObject(rawArgs);
        const target = await resolveInside(ctx.cwd, requireString(args, 'path'));
        const content = requireString(args, 'content');
        // Create parent directories. Resolving first means the path has already
        // been checked against the jail, so mkdir cannot escape it either.
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
        return `Wrote ${content.length} characters to ${relative(ctx.cwd, target)}.`;
      },
    },

    {
      name: 'run_command',
      description:
        'Run a shell-less command inside the working directory and return its output. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          program: { type: 'string', description: 'Executable to run, e.g. "git" or "npm".' },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments, passed without a shell.' },
        },
        required: ['program'],
      },
      requiresApproval: true,
      execute: async (rawArgs, ctx) => {
        const args = asObject(rawArgs);
        const program = requireString(args, 'program');
        const argv = Array.isArray(args['args']) ? args['args'].filter((a): a is string => typeof a === 'string') : [];

        if (program.includes('/') || program.includes('\\')) {
          throw new Error('"program" must be a bare executable name, not a path');
        }
        if (deniedCommands.has(program.toLowerCase())) {
          throw new Error(`"${program}" is on this host's deny list and will not be run`);
        }

        // No shell: `execFile` with an argv array means a value like `; rm -rf /`
        // is passed as a literal argument and cannot become a second command.
        const { stdout, stderr } = await execFileAsync(program, argv, {
          cwd: ctx.cwd,
          timeout,
          maxBuffer: 4 * 1024 * 1024,
          signal: ctx.signal,
          env: sanitizeEnv(),
        });
        const parts: string[] = [];
        if (stdout.length > 0) parts.push(stdout.trimEnd());
        if (stderr.length > 0) parts.push(`[stderr]\n${stderr.trimEnd()}`);
        return parts.length > 0 ? parts.join('\n') : '(command produced no output)';
      },
    },

    {
      name: 'http_fetch',
      description:
        'Fetch a URL and return its body as text. Only hosts this host has been configured to allow are reachable.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL.' },
          max_bytes: { type: 'number', description: 'Truncate the body after this many bytes (default 200000).' },
        },
        required: ['url'],
      },
      requiresApproval: false,
      execute: async (rawArgs, ctx) => {
        const args = asObject(rawArgs);
        const raw = requireString(args, 'url');
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          throw new Error('url must be an absolute URL');
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
          throw new Error('only http and https URLs are supported');
        }
        if (!allowedHosts.has(url.hostname)) {
          const list = allowedHosts.size === 0 ? 'none are configured' : [...allowedHosts].join(', ');
          throw new Error(`host ${url.hostname} is not on this host's egress allow list (allowed: ${list})`);
        }

        const limit = typeof args['max_bytes'] === 'number' ? args['max_bytes'] : 200_000;
        const response = await doFetch(url, { signal: ctx.signal, redirect: 'follow' });
        const text = await response.text();
        const body = text.slice(0, limit);
        return `HTTP ${response.status}\n\n${body}${text.length > limit ? `\n\n[truncated: showed ${limit} of ${text.length} characters]` : ''}`;
      },
    },
  ];

  return tools;
}

/**
 * Strip secrets from the environment handed to a child process.
 *
 * Without this, any tool that runs a command can read the host's API keys out of
 * `env` — the exact values `secrets.*` goes to such lengths to keep off the wire.
 */
function sanitizeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(_KEY|_TOKEN|_SECRET|_PASSWORD|^AWS_|^OPENAI_|^ANTHROPIC_|^GITHUB_|^GH_)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}
