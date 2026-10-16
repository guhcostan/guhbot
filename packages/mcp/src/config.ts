import { z } from 'zod';
import type { McpTransport } from '@guhbot/protocol';
import { McpError } from './errors.js';

/**
 * Server configuration, and the two rules that keep a namespace honest.
 *
 * 1. A server name may not contain the tool-name separator. `<server>__<tool>`
 *    is how a name is routed back to a server, so a name holding `__` is
 *    ambiguous and is refused outright rather than silently rewritten.
 * 2. Everything that becomes part of a tool name is normalized anyway, because
 *    MCP tool names are arbitrary strings and this repository's capability
 *    validator only accepts `[a-z][a-z0-9_]*`. Normalization collapses runs of
 *    `_`, so a hostile tool name cannot smuggle the separator into a namespace
 *    and impersonate another server's tool.
 */

/** Reserved separator between the server namespace and the tool name. */
export const MCP_TOOL_SEPARATOR = '__';

const NAME_MAX = 64;
const COMMAND_MAX = 4096;
const ARGS_MAX = 256;
const ENV_ENTRIES_MAX = 256;

export interface StdioServerConfig {
  name: string;
  transport: 'stdio';
  /** Program to execute. Never taken from a model tool call. */
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  enabled?: boolean | undefined;
}

export interface UrlServerConfig {
  name: string;
  transport: 'http' | 'sse';
  url: string;
  headers?: Record<string, string> | undefined;
  enabled?: boolean | undefined;
}

export type McpServerConfig = StdioServerConfig | UrlServerConfig;

export type McpServerTransport = McpTransport;

const ServerNameSchema = z
  .string()
  .min(1)
  .max(NAME_MAX)
  .refine((name) => !name.includes(MCP_TOOL_SEPARATOR), {
    message: `server name must not contain the reserved separator "${MCP_TOOL_SEPARATOR}"`,
  });

const EnvSchema = z.record(z.string().max(4096));
const HeadersSchema = z.record(z.string().max(4096));

const StdioConfigSchema = z.object({
  name: ServerNameSchema,
  transport: z.literal('stdio'),
  command: z.string().min(1).max(COMMAND_MAX),
  args: z.array(z.string().max(COMMAND_MAX)).max(ARGS_MAX).optional(),
  env: EnvSchema.optional(),
  cwd: z.string().min(1).max(COMMAND_MAX).optional(),
  enabled: z.boolean().optional(),
});

const UrlConfigSchema = z.object({
  name: ServerNameSchema,
  transport: z.enum(['http', 'sse']),
  url: z.string().min(1).max(COMMAND_MAX),
  headers: HeadersSchema.optional(),
  enabled: z.boolean().optional(),
});

export const McpServerConfigSchema = z.union([StdioConfigSchema, UrlConfigSchema]);

/** Parse untrusted input (a config file, or an `mcp.connect` parameter). */
export function parseServerConfig(input: unknown): McpServerConfig {
  const parsed = McpServerConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new McpError('config', `invalid MCP server configuration: ${parsed.error.message}`);
  }
  if (parsed.data.transport !== 'stdio') {
    // Refuse here rather than at first request: a config that can never work
    // should fail while the user is looking at it.
    assertHttpUrl(parsed.data.url, parsed.data.name);
  }
  return parsed.data;
}

/**
 * Require an http(s) URL.
 *
 * The URL is never echoed back: a URL can carry a credential in its query
 * string, and an error message ends up in logs and transcripts.
 */
export function assertHttpUrl(raw: string, serverName: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpError('config', `MCP server "${serverName}" has a URL that cannot be parsed`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new McpError(
      'config',
      `MCP server "${serverName}" must use http or https, got "${url.protocol.replace(':', '')}"`,
    );
  }
  return url;
}

export function isEnabled(config: McpServerConfig): boolean {
  return config.enabled !== false;
}

/**
 * Turn an arbitrary MCP name into a segment that is safe inside a tool name.
 *
 * Collapsing `_` runs is the security-relevant part: without it, a tool the
 * server calls `other__tool` would produce `<server>__other__tool` and look like
 * a tool of a different server.
 */
export function namespaceSegment(raw: string): string {
  const replaced = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  // A capability tool name must start with a letter.
  return /^[a-z]/.test(replaced) ? replaced : `s_${replaced}`;
}
