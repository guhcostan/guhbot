import { describe, expect, it } from 'vitest';
import { DEFAULT_HTTPS_PORT, credentialSecretName, normaliseOrigin, originsMatch } from '../src/index.js';

/**
 * The matcher, exhaustively.
 *
 * This function decides whether a credential may be handed to a request, so the
 * tests are a specification rather than a sample: every ordered pair in a corpus
 * of near-miss origins is checked against the relation it must have, and the
 * corpus contains every shape of lookalike that has ever worked against a naive
 * matcher — suffix confusion, subdomain, port, scheme, trailing dot, case,
 * punycode, userinfo and a path.
 */

const EXAMPLE = 'https://example.com';

describe('normaliseOrigin', () => {
  it('canonicalises the many spellings of one origin into one string', () => {
    const same = [
      'https://example.com',
      'https://example.com/',
      'HTTPS://EXAMPLE.COM',
      'https://Example.Com/',
      'https://example.com:443',
      'https://example.com:0443',
      'https://example.com.',
      ' https://example.com ',
      'https://example.com\n',
    ];
    for (const input of same) {
      expect(normaliseOrigin(input), input).toEqual({
        scheme: 'https',
        host: 'example.com',
        port: DEFAULT_HTTPS_PORT,
        origin: 'https://example.com',
      });
    }
  });

  it('keeps a port that is not the default', () => {
    expect(normaliseOrigin('https://example.com:8443')?.origin).toBe('https://example.com:8443');
    expect(normaliseOrigin('https://example.com:8443')?.port).toBe(8443);
  });

  it('canonicalises an IDN host to its punycode form', () => {
    expect(normaliseOrigin('https://exämple.com')?.host).toBe('xn--exmple-cua.com');
    expect(normaliseOrigin('https://exämple.com')?.origin).toBe('https://xn--exmple-cua.com');
    expect(normaliseOrigin('https://EXÄMPLE.com')?.origin).toBe('https://xn--exmple-cua.com');
    expect(normaliseOrigin('https://xn--exmple-cua.com')?.origin).toBe('https://xn--exmple-cua.com');
    expect(normaliseOrigin('https://éxample.com')?.host).toBe('xn--xample-9ua.com');
  });

  it('canonicalises IP literals, which is the parser writing the address out in full', () => {
    expect(normaliseOrigin('https://127.0.0.1')?.origin).toBe('https://127.0.0.1');
    expect(normaliseOrigin('https://0x7f.1')?.origin).toBe('https://127.0.0.1');
    expect(normaliseOrigin('https://[::1]')?.origin).toBe('https://[::1]');
    expect(normaliseOrigin('https://[0:0:0:0:0:0:0:1]')?.origin).toBe('https://[::1]');
  });

  it('accepts a single-label host, because localhost is a host', () => {
    expect(normaliseOrigin('https://localhost')?.origin).toBe('https://localhost');
  });

  it('refuses anything that is not an https origin', () => {
    const refused = [
      // Plaintext: a downgrade is not a weaker match, it is not a match at all.
      'http://example.com',
      'HTTP://EXAMPLE.COM',
      // Not a web origin.
      'wss://example.com',
      'ws://example.com',
      'ftp://example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      // Credentials in the URL.
      'https://user@example.com',
      'https://user:password@example.com',
      // A URL is not an origin.
      'https://example.com/path',
      'https://example.com/path?query=1',
      'https://example.com?query=1',
      'https://example.com#fragment',
      // Ports that cannot carry an https origin.
      'https://example.com:0',
      'https://example.com:99999',
      'https://example.com:https',
      // Malformed names.
      'https://example.com..',
      'https://.',
      'https://-bad.com',
      'https://bad-.com',
      'https://foo_bar.com',
      `https://${'a'.repeat(64)}.com`,
      'https://exa mple.com',
      'https://example.com:443:443',
      // Not a URL.
      '',
      '   ',
      'example.com',
      '//example.com',
      'https://',
      'not a url',
    ];
    for (const input of refused) {
      expect(normaliseOrigin(input), JSON.stringify(input)).toBeNull();
    }
  });

  it('refuses a non-string from a JavaScript caller instead of throwing', () => {
    // Nothing in this repository can do this through TypeScript, but a tool
    // argument arrives as `unknown` at runtime and a throw here would be an
    // unhandled rejection inside a run.
    expect(normaliseOrigin(undefined as unknown as string)).toBeNull();
    expect(normaliseOrigin(443 as unknown as string)).toBeNull();
    expect(normaliseOrigin(null as unknown as string)).toBeNull();
  });

  it('refuses an over-long input before parsing it', () => {
    expect(normaliseOrigin(`https://example.com/${'a'.repeat(5000)}`)).toBeNull();
  });
});

describe('originsMatch', () => {
  it('matches an origin with itself, however it is spelled', () => {
    expect(originsMatch(EXAMPLE, EXAMPLE)).toBe(true);
    expect(originsMatch(EXAMPLE, 'https://example.com/')).toBe(true);
    expect(originsMatch(EXAMPLE, 'HTTPS://Example.COM:443')).toBe(true);
    expect(originsMatch(EXAMPLE, 'https://example.com.')).toBe(true);
  });

  it('does not match a different scheme', () => {
    expect(originsMatch(EXAMPLE, 'wss://example.com')).toBe(false);
    expect(originsMatch(EXAMPLE, 'ftp://example.com')).toBe(false);
    expect(originsMatch('wss://example.com', 'wss://example.com')).toBe(false);
  });

  it('does not match an http downgrade', () => {
    expect(originsMatch(EXAMPLE, 'http://example.com')).toBe(false);
    expect(originsMatch('http://example.com', EXAMPLE)).toBe(false);
    // A plaintext origin matches nothing at all, not even another plaintext one.
    expect(originsMatch('http://example.com', 'http://example.com')).toBe(false);
  });

  it('does not match a subdomain, in either direction', () => {
    expect(originsMatch(EXAMPLE, 'https://app.example.com')).toBe(false);
    expect(originsMatch('https://app.example.com', EXAMPLE)).toBe(false);
    expect(originsMatch(EXAMPLE, 'https://example.co')).toBe(false);
  });

  it('does not match suffix confusion', () => {
    expect(originsMatch(EXAMPLE, 'https://example.com.evil.com')).toBe(false);
    expect(originsMatch('https://example.com.evil.com', EXAMPLE)).toBe(false);
    expect(originsMatch(EXAMPLE, 'https://example.comevil.com')).toBe(false);
  });

  it('does not match when the approved host is a suffix of the requested one', () => {
    // `notevil.com`.endsWith('evil.com') is true, which is exactly the trap.
    expect(originsMatch('https://evil.com', 'https://notevil.com')).toBe(false);
    expect(originsMatch('https://notevil.com', 'https://evil.com')).toBe(false);
    expect(originsMatch('https://evil.com', EXAMPLE)).toBe(false);
    expect(originsMatch(EXAMPLE, 'https://evil.com')).toBe(false);
  });

  it('does not match a different port, and does match an explicit default port', () => {
    expect(originsMatch(EXAMPLE, 'https://example.com:8443')).toBe(false);
    expect(originsMatch('https://example.com:8443', 'https://example.com:443')).toBe(false);
    expect(originsMatch('https://example.com:8443', 'https://example.com:8444')).toBe(false);
    expect(originsMatch(EXAMPLE, 'https://example.com:443')).toBe(true);
  });

  it('treats an IDN host and its punycode spelling as the same origin', () => {
    expect(originsMatch('https://exämple.com', 'https://xn--exmple-cua.com')).toBe(true);
    expect(originsMatch('https://exämple.com', 'https://exämple.com')).toBe(true);
  });

  it('does not match a punycode lookalike', () => {
    // xn--exmple-cua.com renders as exämple.com: visually one character away
    // from example.com and a completely different registrable domain.
    expect(originsMatch(EXAMPLE, 'https://xn--exmple-cua.com')).toBe(false);
    expect(originsMatch(EXAMPLE, 'https://exämple.com')).toBe(false);
    expect(originsMatch('https://xn--exmple-cua.com', 'https://exämple.com')).toBe(true);
  });

  it('never matches a URL carrying userinfo', () => {
    expect(originsMatch(EXAMPLE, 'https://user@example.com')).toBe(false);
    expect(originsMatch(EXAMPLE, 'https://user:password@example.com')).toBe(false);
    expect(originsMatch('https://user@example.com', 'https://user@example.com')).toBe(false);
  });

  it('never matches a URL carrying a path or a query', () => {
    expect(originsMatch(EXAMPLE, 'https://example.com/login')).toBe(false);
    expect(originsMatch(EXAMPLE, 'https://example.com/login?next=/x')).toBe(false);
    expect(originsMatch(EXAMPLE, 'https://example.com#fragment')).toBe(false);
    // Not even with itself: release takes an origin, not the page you are on.
    expect(originsMatch('https://example.com/login', 'https://example.com/login')).toBe(false);
  });

  it('is symmetric and total over a corpus of near misses', () => {
    const corpus = [
      EXAMPLE,
      'https://example.com/',
      'HTTPS://Example.COM:443',
      'https://example.com.',
      'https://exämple.com',
      'https://xn--exmple-cua.com',
      'https://example.com.evil.com',
      'https://evil.com',
      'https://notevil.com',
      'https://app.example.com',
      'https://example.co',
      'http://example.com',
      'https://example.com:8443',
      'wss://example.com',
      'https://user@example.com',
      'https://example.com/login',
      'https://127.0.0.1',
      'https://[::1]',
      'not a url',
      '',
    ];
    for (const left of corpus) {
      for (const right of corpus) {
        expect(originsMatch(left, right), `${left} vs ${right}`).toBe(originsMatch(right, left));
      }
    }
  });

  it('matches exactly the pairs that canonicalise to the same origin', () => {
    // Each array below is ONE origin spelled several ways: within an array the
    // answer must be "match", across arrays it must be "no match". The
    // `unmatchable` list is inputs that are not approvable origins at all, so
    // they match nothing — not even an identical string.
    const groups = [
      ['https://example.com', 'https://example.com/', 'HTTPS://Example.COM:443', 'https://example.com.'],
      ['https://exämple.com', 'https://xn--exmple-cua.com', 'https://EXÄMPLE.com'],
      ['https://127.0.0.1', 'https://0x7f.1'],
      ['https://[::1]', 'https://[0:0:0:0:0:0:0:1]'],
      ['https://example.com.evil.com'],
      ['https://evil.com'],
      ['https://notevil.com'],
      ['https://app.example.com'],
      ['https://example.co'],
      ['https://example.com:8443'],
      ['https://xn--exmple-cua.com.evil.com'],
    ];
    const unmatchable = [
      'http://example.com',
      'HTTP://EXAMPLE.COM',
      'wss://example.com',
      'https://user@example.com',
      'https://example.com/login',
      'https://example.com/?q=1',
      'https://example.com#fragment',
      'https://example.com..',
      'not a url',
      '',
    ];
    const corpus = [...groups.flat(), ...unmatchable];

    const expected = (left: string, right: string): boolean =>
      groups.some((group) => group.includes(left) && group.includes(right));

    for (const left of corpus) {
      for (const right of corpus) {
        expect(originsMatch(left, right), `${left} vs ${right}`).toBe(expected(left, right));
      }
    }

    // Guard against a corpus that silently stopped testing anything.
    expect(corpus.length).toBeGreaterThan(25);
    expect(corpus.filter((entry) => expected(entry, entry)).length).toBe(groups.flat().length);
    expect(unmatchable.filter((entry) => expected(entry, entry))).toEqual([]);
  });
});

describe('credentialSecretName', () => {
  it('names the sealed value row after the canonical origin', () => {
    expect(credentialSecretName('https://example.com')).toBe('origin:https://example.com');
    expect(credentialSecretName('HTTPS://Example.COM:443/')).toBe('origin:https://example.com');
    expect(credentialSecretName('https://example.com:8443')).toBe('origin:https://example.com:8443');
  });

  it('refuses to name a row for anything that is not an origin', () => {
    expect(credentialSecretName('http://example.com')).toBeNull();
    expect(credentialSecretName('https://example.com/login')).toBeNull();
    expect(credentialSecretName('https://example.com.evil.com')).toBe(
      // A lookalike is a perfectly good origin in its own right; what it must
      // never do is produce the *same* name as the origin it imitates.
      'origin:https://example.com.evil.com',
    );
    expect(credentialSecretName('https://example.com.evil.com')).not.toBe(credentialSecretName('https://example.com'));
  });
});
