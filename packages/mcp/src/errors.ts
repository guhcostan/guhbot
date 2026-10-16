/**
 * MCP failure taxonomy.
 *
 * Every error carries a machine-readable code so a caller can tell a refused
 * configuration (the host will not spawn that) from a server that died, without
 * matching on prose.
 */
export type McpErrorCode =
  | 'refused'
  | 'config'
  | 'timeout'
  | 'closed'
  | 'protocol'
  | 'http'
  | 'cancelled';

export class McpError extends Error {
  readonly code: McpErrorCode;

  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

/** Human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
