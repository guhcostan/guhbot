import { describe, expect, it } from 'vitest';

import { pairingMessage } from '../src/host/pairing';

const ENDPOINT = { host: '192.168.1.20', port: 8787 };

describe('pairingMessage', () => {
  it('explains a refused code as a code problem, not a network problem', () => {
    const message = pairingMessage({ code: 'forbidden', message: 'pairing failed: expired', retryable: false }, ENDPOINT);
    expect(message).toContain('refused that pairing');
    expect(message).toContain('expired');
    expect(message).toContain('single use');
  });

  it('names the address it could not reach', () => {
    const message = pairingMessage({ code: 'cancelled', message: 'client is not connected', retryable: true }, ENDPOINT);
    expect(message).toContain('192.168.1.20:8787');
    expect(message).toContain('same network');
  });

  it('treats a socket failure and a timeout as the same story', () => {
    expect(pairingMessage(new Error('websocket error: connection refused'), ENDPOINT)).toContain('guhbot is running');
    expect(pairingMessage(undefined, ENDPOINT)).toContain('192.168.1.20:8787');
  });

  it('passes anything else through the shared error describer', () => {
    const message = pairingMessage({ code: 'bad-request', message: 'invalid params', retryable: false }, ENDPOINT);
    expect(message).toContain('invalid params');
  });
});
