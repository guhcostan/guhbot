import { describe, expect, it } from 'vitest';
import { CanvasError, normalizeEgressList, planCanvasCsp } from '../src/index.js';

/**
 * The policy is built per document and never loosened by one. These tests read
 * the produced policy back as directives rather than matching substrings, so a
 * directive cannot silently disappear from the string while a substring
 * assertion elsewhere still passes.
 */
function directives(policy: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name === undefined || name === '') continue;
    map.set(name, values);
  }
  return map;
}

const OPEN = normalizeEgressList(['example.com', '.docs.example.com', 'api.example.com:8443']);

describe('canvas CSP', () => {
  it('denies everything by default', () => {
    const { policy } = planCanvasCsp(undefined, []);
    const d = directives(policy);

    expect(d.get('default-src')).toEqual(["'none'"]);
    expect(d.get('connect-src')).toEqual(["'none'"]);
    expect(d.get('frame-src')).toEqual(["'none'"]);
    expect(d.get('child-src')).toEqual(["'none'"]);
    expect(d.get('worker-src')).toEqual(["'none'"]);
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'none'"]);
    expect(d.get('manifest-src')).toEqual(["'none'"]);
  });

  it('treats an empty declaration set like no declaration at all', () => {
    expect(planCanvasCsp({}, OPEN).policy).toBe(planCanvasCsp(undefined, OPEN).policy);
  });

  it('allows inline script and style, and nothing else in script-src', () => {
    const { policy } = planCanvasCsp({ connectHosts: ['https://api.example.com:8443'] }, OPEN);
    const d = directives(policy);

    expect(d.get('script-src')).toEqual(["'unsafe-inline'"]);
    expect(d.get('style-src')).toEqual(["'unsafe-inline'"]);
    expect(d.get('img-src')).toEqual(['data:']);
  });

  it('never emits eval, wasm-eval or a remote script origin', () => {
    const { policy } = planCanvasCsp({ connectHosts: ['https://api.example.com:8443'] }, OPEN);
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('wasm-unsafe-eval');
    expect(policy).not.toContain('unsafe-hashes');

    // A host may only ever appear in the directive that declared it. `script-src`
    // is a fixed single token, so no origin can reach it.
    expect(directives(policy).get('script-src')).toEqual(["'unsafe-inline'"]);
  });

  it("keeps connect-src at 'none' unless a document opted into a host", () => {
    expect(directives(planCanvasCsp({ imageHosts: ['https://example.com'] }, OPEN).policy).get('connect-src')).toEqual([
      "'none'",
    ]);
  });

  it('narrows connect-src to an explicitly declared, allow-listed host', () => {
    const { policy, declared } = planCanvasCsp({ connectHosts: ['https://api.example.com:8443'] }, OPEN);
    expect(directives(policy).get('connect-src')).toEqual(['https://api.example.com:8443']);
    expect(declared.connectHosts).toEqual(['https://api.example.com:8443']);
  });

  it('accepts wss for connect-src and refuses it elsewhere', () => {
    const open = normalizeEgressList(['socket.example.com']);
    expect(directives(planCanvasCsp({ connectHosts: ['wss://socket.example.com'] }, open).policy).get('connect-src')).toEqual([
      'wss://socket.example.com',
    ]);
    expect(() => planCanvasCsp({ imageHosts: ['wss://socket.example.com'] }, open)).toThrow(/does not accept a wss/);
  });

  it('refuses a declared host outside the host egress allow list', () => {
    expect(() => planCanvasCsp({ connectHosts: ['https://evil.example'] }, OPEN)).toThrow(CanvasError);
    expect(() => planCanvasCsp({ connectHosts: ['https://evil.example'] }, OPEN)).toThrow(/not in this host's egress allow list/);
    try {
      planCanvasCsp({ imageHosts: ['https://evil.example'] }, OPEN);
      expect.unreachable('an unlisted host must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasError);
      expect((error as CanvasError).code).toBe('forbidden');
    }
  });

  it('refuses a remote script declaration with a reason', () => {
    expect(() => planCanvasCsp({ scriptHosts: ['https://cdn.example.com'] }, OPEN)).toThrow(CanvasError);
    expect(() => planCanvasCsp({ scriptHosts: ['https://cdn.example.com'] }, OPEN)).toThrow(/remote script/);
    expect(() => planCanvasCsp({ frames: ['https://example.com'] }, OPEN)).toThrow(/never allowed/);
  });

  it('refuses remote frames and workers outright', () => {
    expect(() => planCanvasCsp({ frameHosts: ['https://example.com'] }, OPEN)).toThrow(/remote frames/);
    expect(() => planCanvasCsp({ workerHosts: ['https://example.com'] }, OPEN)).toThrow(/workers/);
  });

  it('refuses a declaration that is not an object, or names an unknown key', () => {
    expect(() => planCanvasCsp('default-src *', OPEN)).toThrow(/refused/);
    expect(() => planCanvasCsp({ connectHosts: ['https://api.example.com:8443'], tls: true }, OPEN)).toThrow(/refused/);
  });

  it('refuses anything that is not an https origin', () => {
    const attempts = [
      'http://example.com',
      'https://*.example.com',
      'https://example.com/x.js',
      'https://example.com?x=1',
      'https://user@example.com',
      'https://example.com:99999',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
    ];
    for (const attempt of attempts) {
      expect(() => planCanvasCsp({ imageHosts: [attempt] }, OPEN), attempt).toThrow(CanvasError);
    }
  });

  it('matches subdomains only through an explicit leading-dot entry', () => {
    expect(directives(planCanvasCsp({ imageHosts: ['https://cdn.docs.example.com'] }, OPEN).policy).get('img-src')).toEqual([
      'data:',
      'https://cdn.docs.example.com',
    ]);
    // `example.com` is exact: a sibling subdomain is not covered by it.
    expect(() => planCanvasCsp({ imageHosts: ['https://cdn.example.com'] }, OPEN)).toThrow(/not in this host's egress allow list/);
    // and the separating dot stops the classic suffix trick.
    expect(() => planCanvasCsp({ imageHosts: ['https://evil-example.com'] }, OPEN)).toThrow(/not in this host's egress allow list/);
  });

  it('honours an allow-list port exactly', () => {
    // `api.example.com:8443` is listed with a port, so the default port is not covered.
    expect(() => planCanvasCsp({ connectHosts: ['https://api.example.com'] }, OPEN)).toThrow(/not in this host's egress allow list/);
    // An entry with no port covers any port.
    const open = normalizeEgressList(['any.example.com']);
    expect(directives(planCanvasCsp({ connectHosts: ['https://any.example.com:8443'] }, open).policy).get('connect-src')).toEqual([
      'https://any.example.com:8443',
    ]);
  });

  it('deduplicates declared origins', () => {
    const { declared } = planCanvasCsp({ imageHosts: ['https://example.com', 'https://example.com'] }, OPEN);
    expect(declared.imageHosts).toEqual(['https://example.com']);
  });
});
