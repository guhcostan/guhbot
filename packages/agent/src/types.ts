import { z } from 'zod';

/**
 * The model-facing vocabulary.
 *
 * Kept separate from the wire protocol on purpose: these are the shapes a
 * provider adapter has to speak, and they change when a vendor changes. The
 * client-facing entities in `@guhbot/protocol` should not move when, say,
 * Anthropic renames a content block.
 */

export const RoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type Role = z.infer<typeof RoleSchema>;

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  /** Base64 payload without a data-URL prefix. */
  data: string;
  mimeType: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments. Providers that stream JSON fragments are assembled before this exists. */
  arguments: unknown;
  /** Raw JSON text, kept for faithful transcript rendering when parsing failed. */
  rawArguments: string;
  /** Set when the model emitted arguments that were not valid JSON. */
  parseError: string | null;
}

export interface ChatMessage {
  role: Role;
  /** Either a plain string (common case) or structured parts. */
  content: string | ContentPart[];
  /** Assistant messages may request tools. */
  toolCalls?: ToolCall[];
  /** Tool messages must name the call they answer. */
  toolCallId?: string;
  /** Free-form provider-specific fields that must survive a round trip. */
  providerMeta?: Record<string, unknown>;
}

/**
 * A tool the model may call.
 *
 * `execute` receives already-validated arguments and returns a string that goes
 * back to the model verbatim. Keeping the return type a plain string avoids an
 * endless debate about structured tool results: the loop renders whatever the
 * tool returns into the transcript, and a tool that wants structure returns JSON.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Sent to the provider as-is. */
  parameters: Record<string, unknown>;
  /**
   * Whether invoking this tool needs a human. When true the loop raises an
   * approval and waits before running it. Read-only tools should say false so an
   * unattended run is not blocked constantly.
   */
  requiresApproval: boolean;
  execute: (args: unknown, context: ToolExecutionContext) => Promise<string>;
}

export interface ToolExecutionContext {
  /** Resolve a secret by name. Never returns a value to the model. */
  readSecret: (name: string) => string | null;
  /** Working directory for filesystem-scoped tools. */
  cwd: string;
  signal: AbortSignal;
  /** Appends a progress entry to the transcript for long-running tools. */
  note: (message: string) => void;
}

export const ToolRegistry = {
  /**
   * Convert a tool set into the JSON Schema list a provider expects.
   *
   * Sorted by name so the serialized request is stable across runs. Stable
   * requests matter for prompt caching: an unstable tool order silently defeats
   * a provider's cache and multiplies cost.
   */
  toProviderTools(tools: ToolDefinition[]): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return [...tools]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  },
};
