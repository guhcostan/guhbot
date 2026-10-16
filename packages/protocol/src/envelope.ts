/**
 * Wire framing.
 *
 * Transport-agnostic: the same frames travel over a WebSocket when a client is
 * remote (phone on the LAN, browser, cloud console) and over an in-process
 * channel when a client is embedded (the Electron renderer talking to the host
 * it spawned). Keeping one framing means the desktop and mobile clients share
 * their entire data layer.
 *
 * Messages are JSON in a single text frame. A session looks like:
 *
 *   S -> C   hello
 *   C -> S   auth  { token, deviceId }
 *   S -> C   ready { device }
 *   C -> S   req   { id, method, params }        (repeat, concurrent)
 *   S -> C   res   { id, ok, result | error }    (repeat, out of order)
 *   S -> C   evt   { event, payload }            (unsolicited, at any time)
 *
 * The first frame from the server is always `hello`, and it is what a client
 * uses to discover the protocol version and whether it must authenticate.
 */
import { z } from 'zod';

/** Bumped on any breaking framing change. Clients refuse to speak across a mismatch. */
export const PROTOCOL_VERSION = 1;

export const ErrorCodeSchema = z.enum([
  /** Framing or payload did not parse or failed schema validation. */
  'bad-request',
  /** No valid device token on this session. */
  'unauthenticated',
  /** Authenticated, but the device class is not allowed to call this method. */
  'forbidden',
  /** Unknown method name. */
  'not-found',
  /** Method exists and is permitted but failed while executing. */
  'internal',
  /** Caller is acting too fast. */
  'rate-limited',
  /** The host is shutting down or the run was cancelled. */
  'cancelled',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const RpcErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().max(20_000),
  /** True when retrying the identical request could plausibly succeed. */
  retryable: z.boolean().default(false),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

// -- Server -> client -------------------------------------------------------

export const HelloFrameSchema = z.object({
  t: z.literal('hello'),
  protocolVersion: z.number().int().min(1),
  /** Host software version, for bug reports. */
  hostVersion: z.string().max(64),
  /** False when the host accepts anonymous loopback connections (embedded clients). */
  authRequired: z.boolean(),
});
export type HelloFrame = z.infer<typeof HelloFrameSchema>;

export const ReadyFrameSchema = z.object({
  t: z.literal('ready'),
  deviceId: z.string().max(128),
  deviceClass: z.enum(['person', 'background']),
});
export type ReadyFrame = z.infer<typeof ReadyFrameSchema>;

export const ResponseFrameSchema = z.object({
  t: z.literal('res'),
  /** Echoes the request id, so responses may arrive out of order. */
  id: z.string().min(1).max(128),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: RpcErrorSchema.optional(),
});
export type ResponseFrame = z.infer<typeof ResponseFrameSchema>;

export const EventFrameSchema = z.object({
  t: z.literal('evt'),
  event: z.string().min(1).max(200),
  payload: z.unknown(),
});
export type EventFrame = z.infer<typeof EventFrameSchema>;

// -- Client -> server -------------------------------------------------------

export const AuthFrameSchema = z.object({
  t: z.literal('auth'),
  token: z.string().min(1).max(4096).optional(),
  deviceId: z.string().max(128).optional(),
});
export type AuthFrame = z.infer<typeof AuthFrameSchema>;

export const RequestFrameSchema = z.object({
  t: z.literal('req'),
  id: z.string().min(1).max(128),
  method: z.string().min(1).max(200),
  params: z.unknown().optional(),
});
export type RequestFrame = z.infer<typeof RequestFrameSchema>;

export const ClientFrameSchema = z.discriminatedUnion('t', [AuthFrameSchema, RequestFrameSchema]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export const ServerFrameSchema = z.discriminatedUnion('t', [
  HelloFrameSchema,
  ReadyFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

// -- Helpers ----------------------------------------------------------------

export function encodeFrame(frame: ServerFrame | ClientFrame): string {
  return JSON.stringify(frame);
}

/**
 * Parse a frame defensively. Returns a discriminated result rather than
 * throwing, because a malformed frame from an untrusted peer is an expected
 * condition, not an exception.
 */
export function decodeClientFrame(raw: string): { ok: true; frame: ClientFrame } | { ok: false; error: RpcError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: 'bad-request', message: 'frame is not valid JSON', retryable: false } };
  }
  const result = ClientFrameSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: { code: 'bad-request', message: `frame failed validation: ${result.error.message}`, retryable: false },
    };
  }
  return { ok: true, frame: result.data };
}

export function decodeServerFrame(raw: string): { ok: true; frame: ServerFrame } | { ok: false; error: RpcError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: 'bad-request', message: 'frame is not valid JSON', retryable: false } };
  }
  const result = ServerFrameSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: { code: 'bad-request', message: `frame failed validation: ${result.error.message}`, retryable: false },
    };
  }
  return { ok: true, frame: result.data };
}
