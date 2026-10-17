/**
 * Waitlist endpoint.
 *
 * A deliberately small function: one validation, one conditional write, one
 * response. It exists because the hosted service is not for sale yet and we
 * would rather collect interest than pretend to take payments.
 *
 * Written as a plain handler so it can be driven by a Lambda Function URL, a
 * local HTTP server in development, or a test, with no framework. The store is
 * an interface so the tests do not need DynamoDB.
 */

export interface WaitlistStore {
  /** Returns 'duplicate' when the address is already present. */
  add(
    email: string,
    source: string,
    at: string,
  ): Promise<'added' | 'duplicate'>;
}

/** In-memory store. Used by tests and by a single-instance local run. */
export class MemoryWaitlistStore implements WaitlistStore {
  private readonly seen = new Set<string>();

  async add(email: string): Promise<'added' | 'duplicate'> {
    const key = email.toLowerCase();
    if (this.seen.has(key)) return 'duplicate';
    this.seen.add(key);
    return 'added';
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * DynamoDB store.
 *
 * Deduplication rides on the write, not on a read-then-write: two people
 * submitting the same address at the same moment would both read "absent" and
 * both write. `attribute_not_exists` makes the second one fail, which is what
 * turns a race into a correct 409.
 */
export class DynamoWaitlistStore implements WaitlistStore {
  constructor(
    private readonly tableName: string,
    private readonly client: {
      send(command: unknown): Promise<unknown>;
    },
    private readonly commands: {
      PutItemCommand: new (input: unknown) => unknown;
      ConditionalCheckFailedException: new (...args: never[]) => Error;
    },
  ) {}

  async add(
    email: string,
    source: string,
    at: string,
  ): Promise<'added' | 'duplicate'> {
    const { PutItemCommand } = this.commands;
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: {
            email: { S: email.toLowerCase() },
            source: { S: source },
            createdAt: { S: at },
          },
          ConditionExpression: 'attribute_not_exists(email)',
        }),
      );
      return 'added';
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'ConditionalCheckFailedException') return 'duplicate';
      throw error;
    }
  }
}

export interface WaitlistResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface WaitlistOptions {
  store: WaitlistStore;
  /** Origin allowed to call this. Defaults to same-origin only. */
  allowedOrigin?: string;
  /** Cap on request body size, in bytes. Prevents a trivially large POST. */
  maxBodyBytes?: number;
  now?: () => Date;
  /**
   * Shared secret that CloudFront injects as `x-guhbot-origin`.
   *
   * A Function URL with `authType: NONE` is callable by anyone who learns the
   * URL. The distribution is the only client that should reach this, so when a
   * secret is configured a request without the matching header is refused
   * outright. Left unset (local development, tests) the check is skipped.
   */
  originSecret?: string;
}

function headerValue(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  // HTTP headers are case-insensitive, and API Gateway does not normalise them.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Longest address that can legally exist is 254 bytes; anything longer is an attack or a typo. */
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function createWaitlistHandler(options: WaitlistOptions) {
  const maxBody = options.maxBodyBytes ?? 2048;
  const now = options.now ?? (() => new Date());

  return async function handle(event: {
    requestContext?: { http?: { method?: string } };
    httpMethod?: string;
    headers?: Record<string, string | undefined>;
    body?: string | null;
    isBase64Encoded?: boolean;
  }): Promise<WaitlistResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // The page is static and hosted separately from the function in the
      // common case, so it needs an explicit grant rather than a wildcard.
      'access-control-allow-origin': options.allowedOrigin ?? 'null',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
      'cache-control': 'no-store',
    };

    if (options.originSecret !== undefined && options.originSecret.length > 0) {
      const provided = headerValue(event.headers, 'x-guhbot-origin');
      if (
        provided === null ||
        !constantTimeEquals(provided, options.originSecret)
      ) {
        // 403, and no detail: a caller probing for the right value learns nothing.
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'forbidden' }),
        };
      }
    }

    const method =
      event.requestContext?.http?.method ?? event.httpMethod ?? 'POST';

    if (method === 'OPTIONS') {
      return { statusCode: 204, headers, body: '' };
    }
    if (method !== 'POST') {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: 'method not allowed' }),
      };
    }

    const raw =
      event.isBase64Encoded === true
        ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
        : (event.body ?? '');
    if (Buffer.byteLength(raw, 'utf8') > maxBody) {
      return {
        statusCode: 413,
        headers,
        body: JSON.stringify({ error: 'request body is too large' }),
      };
    }

    let parsed: unknown;
    try {
      const contentType = headerValue(event.headers, 'content-type') ?? '';
      parsed = contentType.startsWith('application/x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(raw))
        : JSON.parse(raw.length > 0 ? raw : '{}');
    } catch {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'body must be JSON' }),
      };
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'body must be an object' }),
      };
    }

    const candidate = (parsed as { email?: unknown }).email;
    const source = (parsed as { source?: unknown }).source;
    const email = typeof candidate === 'string' ? candidate.trim() : '';

    if (email.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'email is required' }),
      };
    }
    if (email.length > MAX_EMAIL || !EMAIL.test(email)) {
      // Never echo the address back: a response body is a place it can leak into
      // logs, error trackers and browser history.
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'that does not look like an email address',
        }),
      };
    }

    const origin =
      typeof source === 'string' && source.length > 0
        ? source.slice(0, 64)
        : 'unknown';

    try {
      const result = await options.store.add(
        email,
        origin,
        now().toISOString(),
      );
      if (result === 'duplicate') {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({ status: 'already-on-list' }),
        };
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'added' }),
      };
    } catch (error) {
      // A storage failure is ours, not the visitor's. Say so without detail.
      console.error(
        'waitlist storage failure:',
        error instanceof Error ? error.message : String(error),
      );
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          error: 'could not record that right now, please retry',
        }),
      };
    }
  };
}
