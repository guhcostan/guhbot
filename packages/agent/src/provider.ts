import type { ChatMessage, ToolCall, ToolDefinition } from './types.js';

/**
 * Provider seam.
 *
 * A provider is anything that can stream a chat completion. The loop never
 * knows which vendor it is talking to, which is what lets the same host run
 * against a hosted API, a local Ollama, or a vLLM box on the LAN with no code
 * change — the difference is entirely configuration.
 */

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** Prepended as the system message when the provider wants it separate. */
  system: string | undefined;
  maxTokens: number;
  temperature: number;
  signal: AbortSignal;
}

/** Why the model stopped, normalized across providers. */
export type StopReason = 'end' | 'tool-calls' | 'length' | 'refusal' | 'error';

export type ModelEvent =
  | { type: 'text-delta'; text: string }
  /**
   * Reasoning tokens, for models that emit them separately. The loop keeps these
   * out of the transcript but must hand them back on the next request.
   */
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'stop'; reason: StopReason; error?: string };

export interface ModelProvider {
  /** Identifier used in configuration and error messages, e.g. `openai-compatible`. */
  readonly id: string;
  /** Model used when an agent does not name one. */
  readonly defaultModel: string;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export class ProviderError extends Error {
  /**
   * True when retrying the identical request could succeed — rate limits and
   * transient 5xx responses. The loop retries these with backoff and treats
   * everything else as fatal, because silently retrying a 400 wastes money and
   * hides a configuration mistake from the user.
   */
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(message: string, options: { retryable: boolean; status?: number | null }) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = options.retryable;
    this.status = options.status ?? null;
  }
}

/** Retry an operation with exponential backoff and jitter, honouring the abort signal. */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: { signal: AbortSignal; maxAttempts?: number; baseDelayMs?: number },
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal.aborted) throw new Error('aborted');
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ProviderError ? error.retryable : false;
      if (!retryable || attempt === maxAttempts - 1) throw error;
      // Jitter prevents a fleet of hosts from retrying in lockstep after an outage.
      const delay = baseDelayMs * 2 ** attempt * (0.5 + Math.random());
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        options.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Parse a `text/event-stream` body into `data:` payloads.
 *
 * Shared by every HTTP provider. Handles the awkward cases that actually occur:
 * multi-line `data:` fields, CRLF line endings, comments used as keep-alives,
 * and a final event with no trailing newline.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary = findBoundary(buffer);
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));
      const data = extractData(rawEvent);
      if (data !== null) yield data;
      boundary = findBoundary(buffer);
    }
  }

  // Flush whatever remains: a stream that ends without a blank line still
  // carries a complete final event.
  const tail = extractData(buffer);
  if (tail !== null) yield tail;
}

function findBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function extractData(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue; // keep-alive comment
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

/** Best-effort extraction of a human-readable message from a provider error body. */
export function describeProviderError(status: number, bodyText: string): ProviderError {
  let detail = bodyText.slice(0, 2000);
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string }; message?: string };
    detail = parsed.error?.message ?? parsed.message ?? detail;
  } catch {
    // Not JSON; keep the raw text.
  }
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  return new ProviderError(`provider returned ${status}: ${detail}`, { retryable, status });
}
