import { describe, expect, it } from 'vitest';

import { parsePairingUri, type PairingLink } from '../src/core/pairing';

const VALID = 'guhbot://pair?host=192.168.1.20&port=8787&id=pr_8f2c&code=12345678';

function link(raw: string): PairingLink {
  const result = parsePairingUri(raw);
  if (!result.ok) throw new Error(`expected "${raw}" to parse, but it failed: ${result.error}`);
  return result.link;
}

function errorOf(raw: string): string {
  const result = parsePairingUri(raw);
  if (result.ok) throw new Error(`expected "${raw}" to be refused, but it parsed as ${JSON.stringify(result.link)}`);
  return result.error;
}

describe('parsePairingUri', () => {
  it('reads every field of a scanned link', () => {
    expect(link(VALID)).toEqual({ host: '192.168.1.20', port: 8787, pairingId: 'pr_8f2c', code: '12345678' });
  });

  it('accepts the scheme written without slashes and with a trailing slash', () => {
    expect(link('guhbot:pair/?host=macbook.local&port=1&id=pr_1&code=00000000')).toEqual({
      host: 'macbook.local',
      port: 1,
      pairingId: 'pr_1',
      code: '00000000',
    });
  });

  it('accepts an uppercase scheme, a bracketed IPv6 host and percent-encoded values', () => {
    expect(link('GUHBOT://pair?host=%5Bfe80::1%5D&port=9443&id=pr%2F1&code=99999999')).toEqual({
      host: 'fe80::1',
      port: 9443,
      pairingId: 'pr/1',
      code: '99999999',
    });
  });

  it('ignores unknown parameters and the fragment', () => {
    expect(link(`${VALID}&ignored=1#anchor`)).toEqual(link(VALID));
  });

  it('keeps the first value when a parameter is repeated', () => {
    expect(link(`${VALID}&host=evil.example.com`).host).toBe('192.168.1.20');
  });

  it('names the parameters a link is missing', () => {
    expect(errorOf('guhbot://pair?host=192.168.1.20&port=8787&code=12345678')).toBe('The pairing link is missing id.');
    expect(errorOf('guhbot://pair?host=192.168.1.20')).toBe('The pairing link is missing port, id, code.');
  });

  it('refuses a link from another scheme', () => {
    const error = errorOf('https://example.com/pair?host=192.168.1.20&port=8787&id=pr_1&code=12345678');
    expect(error).toContain('guhbot://');
  });

  it('refuses an empty value', () => {
    expect(errorOf('   ')).toBe('There is no pairing link here yet.');
  });

  it('refuses a malformed port', () => {
    for (const port of ['abc', '0', '70000', '8787.5', '-1', '%208787%20x']) {
      expect(errorOf(`guhbot://pair?host=192.168.1.20&port=${port}&id=pr_1&code=12345678`)).toBe(
        `"${decodeURIComponent(port).trim()}" is not a valid port.`,
      );
    }
  });

  it('refuses a code that is not eight digits', () => {
    for (const code of ['1234567', '123456789', 'abcdefgh', '1234 678']) {
      expect(errorOf(`guhbot://pair?host=192.168.1.20&port=8787&id=pr_1&code=${encodeURIComponent(code)}`)).toBe(
        'The pairing code must be the 8 digits guhbot printed on the host.',
      );
    }
  });

  it('refuses a host it cannot dial', () => {
    for (const host of ['has space', 'host:8787', 'http://192.168.1.20', 'a'.repeat(300)]) {
      expect(errorOf(`guhbot://pair?host=${encodeURIComponent(host)}&port=8787&id=pr_1&code=12345678`)).toBe(
        `"${host.trim()}" is not a host address this phone can dial.`,
      );
    }
    // An empty value is reported as missing rather than as undialable.
    expect(errorOf('guhbot://pair?host=&port=8787&id=pr_1&code=12345678')).toBe('The pairing link is missing host.');
  });

  it('refuses invalid percent-encoding instead of throwing', () => {
    expect(errorOf('guhbot://pair?host=%E0%A4%A&port=8787&id=pr_1&code=12345678')).toBe(
      'The pairing link contains invalid percent-encoding.',
    );
  });

  it('refuses a link that is not the pair action', () => {
    expect(errorOf('guhbot://settings?host=192.168.1.20&port=8787&id=pr_1&code=12345678')).toBe(
      'Expected the "pair" action, got "settings".',
    );
  });
});
