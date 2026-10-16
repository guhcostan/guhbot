/**
 * Server-sent events, parsed by hand.
 *
 * Two MCP transports need this: the legacy SSE transport reads one long-lived
 * stream, and the streamable HTTP transport may answer a POST with an SSE body.
 * Both need "read events out of a stream that never ends", which a fetch body
 * reader plus this incremental parser provides.
 */

export interface SseEvent {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

export interface SseParser {
  push(chunk: string): void;
  end(): void;
}

/**
 * Incremental SSE parser.
 *
 * Field handling follows the event-stream grammar: a blank line dispatches,
 * a leading `:` is a comment (servers use those as keep-alives), and only
 * `event`, `data` and `id` carry meaning for MCP.
 */
export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
  let buffer = '';
  let name = '';
  let dataLines: string[] = [];
  let id: string | undefined;

  const dispatch = (): void => {
    if (name === '' && dataLines.length === 0) return;
    onEvent({ event: name === '' ? 'message' : name, data: dataLines.join('\n'), ...(id !== undefined ? { id } : {}) });
    name = '';
    dataLines = [];
    id = undefined;
  };

  const handleLine = (line: string): void => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') name = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
    // `retry` is ignored: MCP clients do not reconnect a session transparently.
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        handleLine(line);
      }
    },
    end(): void {
      if (buffer.length > 0) {
        handleLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
        buffer = '';
      }
      dispatch();
    },
  };
}

/**
 * Read SSE events from a response body until the stream ends.
 *
 * Cancelling the iteration cancels the body, which is what the streamable HTTP
 * transport relies on to stop reading as soon as it has its response.
 */
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const queue: SseEvent[] = [];
  const parser = createSseParser((event) => queue.push(event));

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.push(decoder.decode(value, { stream: true }));
      while (queue.length > 0) {
        const next = queue.shift();
        if (next) yield next;
      }
    }
    parser.push(decoder.decode());
    parser.end();
    while (queue.length > 0) {
      const next = queue.shift();
      if (next) yield next;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
