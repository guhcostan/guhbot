import { randomUUID } from 'node:crypto';
import type { ChatMessage, ContentPart, ToolCall } from '../types.js';
import { ToolRegistry } from '../types.js';
import { describeProviderError, parseSse, withRetry, type ModelEvent, type ModelProvider, type ModelRequest } from '../provider.js';

/**
 * OpenAI-compatible chat completions.
 *
 * This one adapter is deliberately the default because the wire format is now a
 * de-facto industry standard: OpenAI, Groq, Together, Fireworks, DeepSeek,
 * Mistral, Ollama, vLLM, LM Studio and llama.cpp all speak it. A self-hosted
 * user pointing at a box on their LAN configures a base URL and nothing else.
 *
 * Only the chat-completions surface is implemented. Newer provider-specific
 * "responses" APIs are intentionally not used, because the point of this
 * adapter is the widest possible compatibility for self-hosting.
 */

export interface OpenAiCompatibleOptions {
  /** Base URL including any version segment, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  apiKey?: string | undefined;
  defaultModel?: string;
  /** Extra headers, e.g. for a gateway that requires a routing header. */
  headers?: Record<string, string>;
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * One streamed tool-call fragment.
 *
 * Note the nesting: on the wire the call id sits beside the function, while the
 * name and the JSON argument string are inside `function`. They arrive as
 * separate deltas that have to be concatenated per index.
 */
interface StreamingToolCallFragment {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ChatCompletionChunk {
  choices?: {
    index?: number;
    delta?: {
      content?: string | null;
      tool_calls?: StreamingToolCallFragment[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id = 'openai-compatible';
  readonly defaultModel: string;
  private readonly options: OpenAiCompatibleOptions;

  constructor(options: OpenAiCompatibleOptions) {
    this.options = options;
    this.defaultModel = options.defaultModel ?? 'gpt-4o-mini';
  }

  /**
   * Turn our internal messages into the provider's shape.
   *
   * Note what is dropped and what is preserved: `providerMeta` is not sent, so a
   * transcript replayed to a different vendor never leaks vendor-specific fields
   * into a request that would reject them.
   */
  private toProviderMessages(system: string | undefined, messages: ChatMessage[]): unknown[] {
    const out: unknown[] = [];
    if (system !== undefined && system.length > 0) {
      out.push({ role: 'system', content: system });
    }
    for (const message of messages) {
      if (message.role === 'tool') {
        out.push({
          role: 'tool',
          tool_call_id: message.toolCallId ?? '',
          content: typeof message.content === 'string' ? message.content : flattenText(message.content),
        });
        continue;
      }
      if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          // An assistant turn that only calls tools must send null content, not "".
          content: typeof message.content === 'string' && message.content.length > 0 ? message.content : null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.rawArguments },
          })),
        });
        continue;
      }
      out.push({
        role: message.role,
        content: typeof message.content === 'string' ? message.content : toContentArray(message.content),
      });
    }
    return out;
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...this.options.headers,
    };
    if (this.options.apiKey) headers['authorization'] = `Bearer ${this.options.apiKey}`;

    const body = {
      model: request.model || this.defaultModel,
      messages: this.toProviderMessages(request.system, request.messages),
      ...(request.tools.length > 0
        ? {
            tools: ToolRegistry.toProviderTools(request.tools).map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: 'auto',
          }
        : {}),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: true,
      // Ask for a final usage chunk. Providers that do not support it ignore the
      // field; providers that do give us token accounting for cost reporting.
      stream_options: { include_usage: true },
    };

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await withRetry(
      async () =>
        fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
        }),
      { signal: request.signal },
    );

    if (!response.ok) {
      throw describeProviderError(response.status, await response.text().catch(() => ''));
    }
    if (!response.body) {
      throw new Error('provider returned a successful response with no body to stream');
    }

    // Tool calls stream as fragments keyed by index, and the name may be split
    // across chunks. Accumulate per index and only emit once the turn finishes.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null = null;
    let sawText = false;

    for await (const data of parseSse(response.body)) {
      if (data === '[DONE]') break;

      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(data) as ChatCompletionChunk;
      } catch {
        // A malformed chunk is not worth failing the whole run over; skip it.
        continue;
      }

      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        sawText = true;
        yield { type: 'text-delta', text: choice.delta.content };
      }

      for (const fragment of choice?.delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const current = pending.get(index) ?? { id: '', name: '', args: '' };
        if (fragment.id) current.id = fragment.id;
        // Name and arguments accumulate: a provider may split either across
        // chunks, and the argument string in particular arrives in pieces.
        if (fragment.function?.name) current.name += fragment.function.name;
        if (fragment.function?.arguments) current.args += fragment.function.arguments;
        pending.set(index, current);
      }

      if (choice?.finish_reason) finishReason = choice.finish_reason;

      if (chunk.usage) {
        yield {
          type: 'usage',
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
    }

    for (const [, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      yield { type: 'tool-call', call: buildToolCall(call.id, call.name, call.args) };
    }

    if (finishReason === 'tool_calls' || pending.size > 0) {
      yield { type: 'stop', reason: 'tool-calls' };
    } else if (finishReason === 'length') {
      yield { type: 'stop', reason: 'length' };
    } else if (finishReason === 'content_filter') {
      yield { type: 'stop', reason: 'refusal' };
    } else if (finishReason === 'error') {
      yield { type: 'stop', reason: 'error', error: 'provider reported an error finish reason' };
    } else {
      // Some providers end the stream without a finish_reason. Treat a turn that
      // produced nothing at all as an error, because a silent empty turn is
      // otherwise indistinguishable from a successful no-op.
      yield {
        type: 'stop',
        reason: sawText || pending.size > 0 ? 'end' : 'error',
        ...(sawText || pending.size > 0 ? {} : { error: 'provider ended the stream without any content' }),
      };
    }
  }
}

function buildToolCall(id: string, name: string, rawArguments: string): ToolCall {
  let parsed: unknown = {};
  let parseError: string | null = null;
  const trimmed = rawArguments.trim();
  if (trimmed.length === 0) {
    parsed = {};
  } else {
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
      parsed = {};
    }
  }
  return {
    // Some providers omit ids; the loop needs one to thread the result back.
    id: id.length > 0 ? id : `call_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    name,
    arguments: parsed,
    rawArguments: trimmed,
    parseError,
  };
}

function flattenText(parts: ContentPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
}

function toContentArray(parts: ContentPart[]): unknown[] {
  return parts.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
  );
}
