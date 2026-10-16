import { describe, expect, it } from 'vitest';

import { describeEndpoint, normalizeHost, parseEndpoint, parsePort, rpcUrl } from '../src/core/endpoint.js';

describe('host addresses', () => {
  it('normalizes the forms a user can type', () => {
    expect(normalizeHost(' 192.168.1.20 ')).toBe('192.168.1.20');
    expect(normalizeHost('macbook.local')).toBe('macbook.local');
    expect(normalizeHost('[fe80::1]')).toBe('fe80::1');
    expect(normalizeHost('localhost')).toBe('localhost');
  });

  it('refuses a host with a port, a scheme or whitespace inside it', () => {
    for (const host of ['host:8787', 'ws://192.168.1.20', 'two words', '', '   ', 'tab\there']) {
      expect(normalizeHost(host)).toBeNull();
    }
  });

  it('accepts only real ports', () => {
    expect(parsePort('8787')).toBe(8787);
    expect(parsePort(' 1 ')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
    for (const port of ['0', '65536', '-1', '1.5', 'abc', '']) {
      expect(parsePort(port)).toBeNull();
    }
  });

  it('explains which field is wrong', () => {
    expect(parseEndpoint('192.168.1.20', '8787')).toEqual({ ok: true, endpoint: { host: '192.168.1.20', port: 8787 } });
    const badHost = parseEndpoint('nope nope', '8787');
    expect(badHost.ok).toBe(false);
    expect(badHost.ok ? '' : badHost.error).toContain('not a host address');
    const badPort = parseEndpoint('192.168.1.20', 'later');
    expect(badPort.ok).toBe(false);
    expect(badPort.ok ? '' : badPort.error).toContain('is not a port');
  });

  it('builds the RPC URL the host actually serves', () => {
    expect(rpcUrl({ host: '192.168.1.20', port: 8787 })).toBe('ws://192.168.1.20:8787/rpc');
    // An IPv6 literal needs its brackets back inside a URL authority.
    expect(rpcUrl({ host: 'fe80::1', port: 8787 })).toBe('ws://[fe80::1]:8787/rpc');
    expect(describeEndpoint({ host: 'fe80::1', port: 8787 })).toBe('fe80::1:8787');
  });
});
