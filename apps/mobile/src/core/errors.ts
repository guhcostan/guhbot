/**
 * Turning failures into sentences.
 *
 * `forbidden` is not an exception here: a background-class phone is refused by
 * design for every method that resolves an approval or mutates the host, so the
 * UI has to render that state as a normal outcome with a way forward.
 */
import { RpcErrorSchema, type ErrorCode, type RpcError } from '@guhbot/protocol';

export interface Problem {
  readonly code: ErrorCode | 'unknown';
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
  /** True when the user has to act on the host machine rather than the phone. */
  readonly needsHostMachine: boolean;
}

export function isRpcError(value: unknown): value is RpcError {
  return RpcErrorSchema.safeParse(value).success;
}

const FORBIDDEN_DETAIL =
  'The host only accepts this from a device with human presence, and this phone paired over the network as a background device. ' +
  'Approve it in guhbot on the machine that runs the host.';

function problem(code: ErrorCode | 'unknown', title: string, detail: string, retryable: boolean, needsHostMachine = false): Problem {
  return { code, title, detail, retryable, needsHostMachine };
}

export function describeError(error: unknown): Problem {
  if (isRpcError(error)) {
    switch (error.code) {
      case 'forbidden':
        return problem('forbidden', 'The host refused this', `${error.message}. ${FORBIDDEN_DETAIL}`, false, true);
      case 'unauthenticated':
        return problem(
          'unauthenticated',
          'This phone is no longer paired',
          'The host did not accept the stored device token. It may have been revoked on the host; pair again from Settings.',
          false,
          true,
        );
      case 'cancelled':
        return problem('cancelled', 'The connection dropped', 'The host did not answer this request. guhbot keeps retrying in the background.', true);
      case 'not-found':
        return problem('not-found', 'The host does not have that', error.message, false);
      case 'bad-request':
        return problem(
          'bad-request',
          'The host rejected the request',
          `${error.message}. This app and the host may speak different protocol versions.`,
          false,
        );
      case 'rate-limited':
        return problem('rate-limited', 'Too many requests', error.message, true);
      case 'internal':
        return problem('internal', 'The host reported an error', error.message, error.retryable);
    }
  }

  if (error instanceof Error) {
    return problem('unknown', 'Something went wrong', error.message, true);
  }

  return problem('unknown', 'Something went wrong', 'The request failed for a reason this app cannot describe.', true);
}

export function isForbidden(error: unknown): boolean {
  return isRpcError(error) && error.code === 'forbidden';
}
