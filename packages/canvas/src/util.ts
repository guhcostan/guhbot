import type { z } from 'zod';

/** Human-readable byte count for a refusal the model has to act on. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Validate tool arguments against a schema.
 *
 * Tool arguments arrive as `unknown` from the model, which may be a page it
 * read. Parsing once, here, is what lets every tool body treat its input as
 * typed — and a schema marked strict is how an argument we deliberately do not
 * support (`scriptHosts`, say) becomes a loud refusal instead of a silent no-op.
 */
export function parseToolArguments<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'arguments'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid arguments: ${detail}`);
  }
  return parsed.data;
}

/**
 * Collapse whitespace in a model-supplied label.
 *
 * Titles are stored and shown to a human; a newline or a control character in
 * one is at best untidy and at worst a way to make two different canvases look
 * identical in a list.
 */
export function cleanTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Escape a value for interpolation into a double-quoted HTML attribute.
 *
 * Single quotes are left alone on purpose: this is only ever used for a
 * double-quoted `content=` attribute, and the policy string has to stay readable
 * in the served bytes, because a model reads those bytes back to revise the
 * document. A policy built by `planCanvasCsp` cannot contain a quote from user
 * input anyway — only the fixed `'none'` and `'unsafe-inline'` tokens.
 */
export function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
