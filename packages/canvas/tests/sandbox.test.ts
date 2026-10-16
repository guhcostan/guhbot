import { describe, expect, it } from 'vitest';
import {
  CANVAS_CSP_MARKER,
  CANVAS_SANDBOX,
  CANVAS_SANDBOX_TOKENS,
  CanvasError,
  SANDBOX_TOKENS_NEVER_ALLOWED,
  assertCanvasSandbox,
  wrapCanvasDocument,
} from '../src/index.js';

/**
 * The most important assertions in the package.
 *
 * The sandbox string is the only thing standing between model-authored HTML and
 * the host application's origin, so it is asserted as an exact value and as an
 * absence: `allow-same-origin` must never appear, in any spelling.
 */
describe('the canvas iframe sandbox', () => {
  it('is exactly the three allowed tokens', () => {
    expect(CANVAS_SANDBOX).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox');
    expect(CANVAS_SANDBOX_TOKENS).toEqual(['allow-scripts', 'allow-popups', 'allow-popups-to-escape-sandbox']);
  });

  it('does not contain allow-same-origin', () => {
    expect(CANVAS_SANDBOX).not.toContain('allow-same-origin');
    expect(CANVAS_SANDBOX_TOKENS).not.toContain('allow-same-origin');
    for (const token of CANVAS_SANDBOX_TOKENS) {
      expect(token).not.toMatch(/same-origin/i);
    }
  });

  it('contains none of the tokens that would widen the boundary', () => {
    for (const token of SANDBOX_TOKENS_NEVER_ALLOWED) {
      expect(CANVAS_SANDBOX_TOKENS).not.toContain(token);
    }
    // The list itself has to be the thing a reviewer expects to see.
    expect(SANDBOX_TOKENS_NEVER_ALLOWED).toContain('allow-same-origin');
    expect(SANDBOX_TOKENS_NEVER_ALLOWED).toContain('allow-forms');
    expect(SANDBOX_TOKENS_NEVER_ALLOWED).toContain('allow-top-navigation');
    expect(SANDBOX_TOKENS_NEVER_ALLOWED).toContain('allow-downloads');
  });

  it('has no duplicate, empty or padded tokens', () => {
    expect(new Set(CANVAS_SANDBOX_TOKENS).size).toBe(CANVAS_SANDBOX_TOKENS.length);
    for (const token of CANVAS_SANDBOX_TOKENS) {
      expect(token).not.toBe('');
      expect(token).toBe(token.trim());
    }
  });

  it('accepts only the hardened value', () => {
    expect(() => assertCanvasSandbox(CANVAS_SANDBOX)).not.toThrow();
    expect(() => assertCanvasSandbox(`${CANVAS_SANDBOX} allow-same-origin`)).toThrow(CanvasError);
    expect(() => assertCanvasSandbox(`${CANVAS_SANDBOX} allow-same-origin`)).toThrow(/exactly/);
    expect(() => assertCanvasSandbox('allow-scripts allow-popups')).toThrow(/exactly/);
    expect(() => assertCanvasSandbox('')).toThrow(/exactly/);
    expect(() => assertCanvasSandbox('allow-scripts  allow-popups allow-popups-to-escape-sandbox')).toThrow(
      /exactly/,
    );
  });
});

describe('the served document', () => {
  const policy = "default-src 'none'; connect-src 'none'";

  it('injects the policy after the doctype and before any author byte', () => {
    const doc = wrapCanvasDocument('<h1>hi</h1>', policy);
    expect(doc.startsWith(`<!DOCTYPE html>${CANVAS_CSP_MARKER}<meta http-equiv="Content-Security-Policy" content="`)).toBe(true);
    expect(doc).toContain(`content="${policy}"`);
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<h1>'));
    expect(doc.endsWith('<h1>hi</h1>')).toBe(true);
  });

  it('strips a byte order mark so the policy still lands first', () => {
    const doc = wrapCanvasDocument('\uFEFF<h1>hi</h1>', policy);
    expect(doc.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(doc).not.toContain('\uFEFF');
  });

  it('replaces the author doctype instead of stacking one', () => {
    const doc = wrapCanvasDocument('<!doctype HTML>\n<html><body>x</body></html>', policy);
    expect(doc.match(/<!DOCTYPE html>/gi)).toHaveLength(1);
    expect(doc).toContain('<html><body>x</body></html>');
  });

  it('leaves a later author-supplied policy in place, after ours', () => {
    // CSP policies intersect, so a later meta can only tighten ours. What must
    // hold is that nothing renders under a policy we did not set first.
    const author = '<meta http-equiv="Content-Security-Policy" content="default-src *"><p>x</p>';
    const doc = wrapCanvasDocument(author, policy);
    expect(doc.indexOf(policy)).toBeLessThan(doc.indexOf('default-src *'));
    expect(doc).toContain('default-src *');
  });

  it('is idempotent, so an agent revising the served bytes does not stack them', () => {
    const once = wrapCanvasDocument('<p>one</p>', policy);
    expect(wrapCanvasDocument(once, policy)).toBe(once);
  });

  it('regenerates the policy when the same body is created with different declarations', () => {
    const once = wrapCanvasDocument('<p>one</p>', "default-src 'none'; connect-src 'none'");
    const twice = wrapCanvasDocument(once, "default-src 'none'; connect-src https://api.example.com");
    expect(twice).not.toContain("connect-src 'none'");
    expect(twice).toContain('connect-src https://api.example.com');
    expect(twice.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(twice).toContain('<p>one</p>');
  });
});
