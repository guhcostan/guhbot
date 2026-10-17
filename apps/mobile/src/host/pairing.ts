/**
 * What to tell the user when pairing fails.
 *
 * Pairing is the only place where a failure has no fallback screen, so the
 * message has to name the likely cause: an unreachable host, or a code that was
 * already used or has expired.
 */
import { describeEndpoint, type HostEndpoint } from '../core/endpoint';
import { describeError, isRpcError } from '../core/errors';

export function pairingMessage(error: unknown, endpoint: HostEndpoint): string {
  if (isRpcError(error)) {
    if (error.code === 'forbidden') {
      return `The host refused that pairing (${error.message}). Codes are single use and expire a few minutes after they are minted; print a fresh one on the host.`;
    }
    if (error.code === 'cancelled' || error.code === 'internal') {
      return unreachable(endpoint);
    }
    return describeError(error).detail;
  }
  return unreachable(endpoint);
}

function unreachable(endpoint: HostEndpoint): string {
  return (
    `No answer from ${describeEndpoint(endpoint)}. Check that guhbot is running on that machine, ` +
    'that the companion or secure proxy is running, and that this phone is on the same network or can reach the secure remote host.'
  );
}
