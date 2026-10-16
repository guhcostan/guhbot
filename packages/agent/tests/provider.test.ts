import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider, parseSse, ProviderError, withRetry } from '../src/index.js';
import type { ModelEvent } from '../src/provider.js';

/**
 * The provider adapter is exercised against a real HTTP server on an ephemeral
 * loopback port rather than a mocked `fetch`.
 *
 * That matters because most of the adapter's risk lives in the wire details:
 * SSE framing across chunk boundaries, tool-call fragments split mid-JSON, and
 * error bodies. A mocked fetch would let all three pass while the real thing
 * breaks against an actual provider.
 */

let server: Server;
let port = 0;
let script: { status: number; chunks: string[]; headers?: Record<string, string> } = { status: 200, chunks: [] };
let lastRequest: { url: string; body: unknown; headers: Record<string, string | string[] | undefined> } | null = null;

beforeEach(async () => {
  lastRequest = null;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      lastRequest = {
        url: req.url ?? '',
        body: raw.length > 0 ? JSON.parse(raw) : null,
        headers: req.headers,
      };
      res.writeHead(script.status, {
        'content-type': 'text/event-stream',
        ...script.headers,
      });
      let i = 0;
      const writeNext = (): void => {
        if (i >= script.chunks.length) {
          res.end();
          return;
        }
        res.write(script.chunks[i]);
        i += 1;
        setImmediate(writeNext);
      };
      // Write chunk by chunk on separate ticks so the parser genuinely has to
      // handle events split across reads.
      writeNext();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function provider(overrides: Partial<ConstructorParameters<typeof OpenAiCompatibleProvider>[0]> = {}) {
  return new OpenAiCompatibleProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    defaultModel: 'test-model',
    ...overrides,
  });
}

async function collect(iter: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

describe('openai-compatible streaming', () => {
  it('streams text deltas and stops', async () => {
    script = {
      status: 200,
      chunks: [
        sse({ choices: [{ delta: { content: 'Hel' } }] }),
        sse({ choices: [{ delta: { content: 'lo' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ],
    };
    const events = await collect(
      provider().stream({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        system: 'be nice',
        maxTokens: 100,
        temperature: 0,
        signal: new AbortController().signal,
      }),
    );

    expect(events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('')).toBe('Hello');
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end' });
  });

  it('reassembles a tool call split across chunks', async () => {
    script = {
      status: 200,
      chunks: [
        // Name and id arrive first, arguments stream in as fragments.
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ],
    };
    const events = await collect(
      provider().stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        system: undefined,
        maxTokens: 100,
        temperature: 0,
        signal: new AbortController().signal,
      }),
    );

    const call = events.find((e) => e.type === 'tool-call') as { call: { id: string; name: string; arguments: unknown } };
    expect(call).toBeDefined();
    expect(call.call.name).toBe('read_file');
    expect(call.call.id).toBe('call_1');
    expect(call.call.arguments).toEqual({ path: 'a.txt' });
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'tool-calls' });
  });

  it('keeps multiple parallel tool calls separate by index', async () => {
    script = {
      status: 200,
      chunks: [
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{}' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{}' } }] } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ],
    };
    const events = await collect(
      provider().stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        system: undefined,
        maxTokens: 10,
        temperature: 0,
        signal: new AbortController().signal,
      }),
    );
    const names = events.filter((e) => e.type === 'tool-call').map((e) => (e as { call: { name: string } }).call.name);
    expect(names).toEqual(['one', 'two']);
  });

  it('reports invalid tool arguments without throwing', async () => {
    script = {
      status: 200,
      chunks: [
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 't', arguments: '{not json' } }] } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ],
    };
    const events = await collect(
      provider().stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        system: undefined,
        maxTokens: 10,
        temperature: 0,
        signal: new AbortController().signal,
      }),
    );
    const call = events.find((e) => e.type === 'tool-call') as { call: { parseError: string | null } };
    expect(call.call.parseError).not.toBeNull();
  });

  it('surfaces usage when the provider reports it', async () => {
    script = {
      status: 200,
      chunks: [
        sse({ choices: [{ delta: { content: 'x' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 4 } }),
        'data: [DONE]\n\n',
      ],
    };
    const events = await collect(
      provider().stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        system: undefined,
        maxTokens: 10,
        temperature: 0,
        signal: new AbortController().signal,
      }),
    );
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', inputTokens: 11, outputTokens: 4 });
  });

  it('treats an empty stream as an error rather than a silent success', async () => {
    script = { status: 200, chunks: ['data: [DONE]\n\n'] };
    const events = await collect(
      provider().stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        system: undefined,
        maxTokens: 10,
        temperature: 0,
        signal: new AbortController().signal,
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'error' });
  });

  it('handles CRLF line endings and keep-alive comments', async () => {
    script = {
      status: 200,
      chunks: [': keep-alive\r\n\r\n', 'data: {"choices":[{"delta":{"content":"ok"}}]}\r\n\r\n', 'data: [DONE]\r\n\r\n'],
    };
    const events = await collect(
      provider().stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        system: undefined,
        maxTokens: 10,
        temperature: 0,
        signal: new AbortController().signal,
      }),
    );
    expect(events.find((e) => e.type === 'text-delta')).toEqual({ type: 'text-delta', text: 'ok' });
  });

  it('classifies a 429 as retryable and a 400 as fatal', async () => {
    script = { status: 429, chunks: [JSON.stringify({ error: { message: 'slow down' } })] };
    await expect(
      collect(
        provider().stream({
          model: 'm',
          messages: [{ role: 'user', content: 'x' }],
          tools: [],
          system: undefined,
          maxTokens: 10,
          temperature: 0,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({ retryable: true, status: 429 });

    script = { status: 400, chunks: [JSON.stringify({ error: { message: 'bad model' } })] };
    await expect(
      collect(
        provider().stream({
          model: 'm',
          messages: [{ role: 'user', content: 'x' }],
          tools: [],
          system: undefined,
          maxTokens: 10,
          temperature: 0,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({ retryable: false, status: 400 });
  });
});

describe('reasoning models', () => {
  it('streams reasoning separately from visible text', async () => {
    script = {
      status: 200,
      chunks: [
        sse({ choices: [{ delta: { reasoning_content: 'Let me think. ' } }] }),
        sse({ choices: [{ delta: { reasoning_content: 'Two plus two.' } }] }),
        sse({ choices: [{ delta: { content: '4' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ],
    };
    const events = await collect(
      provider().stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        system: undefined,
        maxTokens: 10,
        temperature: 0,
        signal: new AbortController().signal,
      }),
    );

    // Reasoning must not be mixed into the visible answer.
    const text = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('4');
    const reasoning = events
      .filter((e) => e.type === 'reasoning-delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(reasoning).toBe('Let me think. Two plus two.');
  });

  it('echoes reasoning back on the next request so thinking mode accepts it', async () => {
    script = { status: 200, chunks: [sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'] };
    await collect(
      provider().stream({
        model: 'm',
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'assistant',
            content: '',
            reasoning: 'I should call the tool.',
            toolCalls: [{ id: 'c1', name: 't', arguments: {}, rawArguments: '{}', parseError: null }],
          },
          { role: 'tool', content: 'result', toolCallId: 'c1' },
        ],
        tools: [],
        system: undefined,
        maxTokens: 10,
        temperature: 0,
        signal: new AbortController().signal,
      }),
    );

    const body = lastRequest?.body as { messages: { role: string; reasoning_content?: string }[] };
    const assistant = body.messages.find((m) => m.role === 'assistant');
    // Omitting this is what makes a reasoning model reject the follow-up with a
    // 400, which is exactly what happened before this was fixed.
    expect(assistant?.reasoning_content).toBe('I should call the tool.');
  });

  it('omits reasoning_content entirely when there is none', async () => {
    script = { status: 200, chunks: [sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'] };
    await collect(
      provider().stream({
        model: 'm',
        messages: [{ role: 'assistant', content: 'hello' }],
        tools: [],
        system: undefined,
        maxTokens: 10,
        temperature: 0,
        signal: new AbortController().signal,
      }),
    );
    const body = lastRequest?.body as { messages: Record<string, unknown>[] };
    expect(body.messages[0]).not.toHaveProperty('reasoning_content');
  });
});

describe('request shaping', () => {
  it('sends the system prompt, tools and stream options in the provider shape', async () => {
    script = { status: 200, chunks: [sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'] };
    await collect(
      provider({ apiKey: 'sk-test' }).stream({
        model: 'm',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          {
            name: 'ztool',
            description: 'z',
            parameters: { type: 'object' },
            requiresApproval: false,
            execute: async () => '',
          },
          {
            name: 'atool',
            description: 'a',
            parameters: { type: 'object' },
            requiresApproval: false,
            execute: async () => '',
          },
        ],
        system: 'sys',
        maxTokens: 42,
        temperature: 0.3,
        signal: new AbortController().signal,
      }),
    );

    const body = lastRequest?.body as {
      messages: { role: string }[];
      tools: { function: { name: string } }[];
      stream: boolean;
      stream_options: { include_usage: boolean };
      max_tokens: number;
      temperature: number;
    };
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    // Tool order is sorted so the serialized request is stable for prompt caching.
    expect(body.tools.map((t) => t.function.name)).toEqual(['atool', 'ztool']);
    expect(body.stream).toBe(true);
    expect(body.stream_options.include_usage).toBe(true);
    expect(body.max_tokens).toBe(42);
    expect(body.temperature).toBe(0.3);
    expect(lastRequest?.headers['authorization']).toBe('Bearer sk-test');
    expect(lastRequest?.url).toBe('/v1/chat/completions');
  });

  it('sends null content for an assistant turn that only calls tools', async () => {
    script = { status: 200, chunks: [sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'] };
    await collect(
      provider().stream({
        model: 'm',
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 't', arguments: {}, rawArguments: '{}', parseError: null }],
          },
          { role: 'tool', content: 'result', toolCallId: 'c1' },
        ],
        tools: [],
        system: undefined,
        maxTokens: 10,
        temperature: 0,
        signal: new AbortController().signal,
      }),
    );
    const body = lastRequest?.body as { messages: { role: string; content: unknown; tool_call_id?: string }[] };
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBeNull();
    const tool = body.messages.find((m) => m.role === 'tool');
    expect(tool?.tool_call_id).toBe('c1');
  });

  it('omits the tools field entirely when there are no tools', async () => {
    script = { status: 200, chunks: [sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'] };
    await collect(
      provider().stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        system: undefined,
        maxTokens: 10,
        temperature: 0,
        signal: new AbortController().signal,
      }),
    );
    expect(lastRequest?.body).not.toHaveProperty('tools');
  });
});

describe('sse parsing unit', () => {
  it('joins multi-line data fields', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: line1\ndata: line2\n\n'));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const d of parseSse(body)) out.push(d);
    expect(out).toEqual(['line1\nline2']);
  });

  it('yields a final event with no trailing blank line', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: tail'));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const d of parseSse(body)) out.push(d);
    expect(out).toEqual(['tail']);
  });
});

describe('withRetry', () => {
  it('retries a retryable error and then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new ProviderError('rate limited', { retryable: true, status: 429 });
        return 'ok';
      },
      { signal: new AbortController().signal, baseDelayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry a fatal error', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new ProviderError('bad request', { retryable: false, status: 400 });
        },
        { signal: new AbortController().signal, baseDelayMs: 1 },
      ),
    ).rejects.toThrow(/bad request/);
    expect(attempts).toBe(1);
  });

  it('gives up after the attempt budget', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new ProviderError('still failing', { retryable: true, status: 503 });
        },
        { signal: new AbortController().signal, maxAttempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow(/still failing/);
    expect(attempts).toBe(3);
  });
});
