import type { RpcError } from '@guhbot/protocol';
import { describe, expect, it } from 'vitest';

import { describeError, isForbidden, isRpcError } from '../src/core/errors.js';

describe('describeError', () => {
  it('treats a refusal as a normal outcome with a way forward', () => {
    const problem = describeError({
      code: 'forbidden',
      message: 'agents.create requires a device with human presence, but this device is "background"',
      retryable: false,
    } satisfies RpcError);

    expect(problem.code).toBe('forbidden');
    expect(problem.needsHostMachine).toBe(true);
    expect(problem.retryable).toBe(false);
    // The host's own words are kept, and the app adds where to go instead.
    expect(problem.detail).toContain('human presence');
    expect(problem.detail).toContain('machine that runs the host');
    expect(isForbidden({ code: 'forbidden', message: 'x', retryable: false })).toBe(true);
  });

  it('sends the user back to pairing when the token is gone', () => {
    const problem = describeError({ code: 'unauthenticated', message: 'device token is not valid', retryable: false } satisfies RpcError);
    expect(problem.title).toContain('no longer paired');
    expect(problem.detail).toContain('pair again');
  });

  it('treats a dropped connection as retryable', () => {
    const problem = describeError({ code: 'cancelled', message: 'connection closed', retryable: true } satisfies RpcError);
    expect(problem.retryable).toBe(true);
    expect(problem.needsHostMachine).toBe(false);
  });

  it('handles a plain Error and an unknown thrown value', () => {
    expect(describeError(new Error('socket exploded')).detail).toBe('socket exploded');
    expect(describeError(undefined).code).toBe('unknown');
    expect(describeError({ nonsense: true }).detail).toContain('cannot describe');
  });

  it('recognizes a wire error and rejects anything else', () => {
    expect(isRpcError({ code: 'internal', message: 'boom' })).toBe(true);
    expect(isRpcError({ code: 'nope', message: 'boom' })).toBe(false);
    expect(isRpcError(new Error('boom'))).toBe(false);
    expect(isRpcError(null)).toBe(false);
  });
});
