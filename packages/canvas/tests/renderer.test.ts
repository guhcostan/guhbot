import { describe, expect, it } from 'vitest';
import {
  ADMITTED_LINK_PROTOCOLS,
  CANVAS_SCHEME,
  CanvasError,
  LINK_GATE_WINDOW_MS,
  admitExternalLink,
  canvasUrl,
  parseCanvasUrl,
} from '../src/index.js';

/**
 * The two pieces of the renderer contract this package owns: the locator grammar
 * and the gate in front of the one hole in the sandbox.
 *
 * Neither renders anything. The client supplies the focused frame and the
 * gesture timestamp; the decision stays here so a client cannot invent a laxer
 * one.
 */

const ID = 'a'.repeat(64);

describe('the canvas locator', () => {
  it('builds the canonical URL and parses it back', () => {
    expect(canvasUrl(ID)).toBe(`${CANVAS_SCHEME}://frame/${ID}?theme=light`);
    expect(canvasUrl(ID, 'dark')).toBe(`${CANVAS_SCHEME}://frame/${ID}?theme=dark`);
    expect(parseCanvasUrl(canvasUrl(ID))).toEqual({ id: ID, theme: 'light' });
    expect(parseCanvasUrl(canvasUrl(ID, 'dark'))).toEqual({ id: ID, theme: 'dark' });
  });

  it('refuses to build a URL for something that is not a canvas id', () => {
    expect(() => canvasUrl('not-a-digest')).toThrow(CanvasError);
    expect(() => canvasUrl('../../etc/passwd')).toThrow(CanvasError);
  });

  it('accepts nothing but the exact grammar', () => {
    const rejected = [
      `${CANVAS_SCHEME}://frame/${ID}`,
      `${CANVAS_SCHEME}://frame/${ID}?theme=blue`,
      `${CANVAS_SCHEME}://frame/${ID}?theme=light&room=1`,
      `${CANVAS_SCHEME}://frame/${ID}?theme=light&theme=dark`,
      `${CANVAS_SCHEME}://frame/${ID}?theme=light#section`,
      `${CANVAS_SCHEME}://frame/${ID}/?theme=light`,
      `${CANVAS_SCHEME}://${'user'}:${'pw'}@frame/${ID}?theme=light`,
      `${CANVAS_SCHEME}://frame:8080/${ID}?theme=light`,
      `${CANVAS_SCHEME}://FRAME/${ID}?theme=light`,
      `${CANVAS_SCHEME}://other/${ID}?theme=light`,
      `https://frame/${ID}?theme=light`,
      `${CANVAS_SCHEME}://frame/${'A'.repeat(64)}?theme=light`,
      `${CANVAS_SCHEME}://frame/not-a-digest?theme=light`,
      '',
      'not a url at all',
    ];
    for (const attempt of rejected) {
      expect(parseCanvasUrl(attempt), attempt).toBeNull();
    }
  });

  it('does not accept a query that only looks canonical', () => {
    // Percent-encoded theme, reordered parameter: refused by the exact-query check.
    expect(parseCanvasUrl(`${CANVAS_SCHEME}://frame/${ID}?theme=lig%68t`)).toBeNull();
  });
});

describe('the external link gate', () => {
  const base = { frameIsCanvas: true, lastGestureAtMs: 10_000, nowMs: 10_500 };

  it('admits a link the user just clicked', () => {
    for (const protocol of ADMITTED_LINK_PROTOCOLS) {
      expect(admitExternalLink({ ...base, protocol }), protocol).toBe(true);
    }
    expect(ADMITTED_LINK_PROTOCOLS).toEqual(['http:', 'https:', 'mailto:', 'tel:']);
  });

  it('uses a window strictly under a second', () => {
    expect(LINK_GATE_WINDOW_MS).toBe(1000);
    expect(admitExternalLink({ ...base, protocol: 'https:', nowMs: 11_000 })).toBe(true);
    expect(admitExternalLink({ ...base, protocol: 'https:', nowMs: 11_001 })).toBe(false);
  });

  it('refuses a link with no gesture behind it', () => {
    expect(admitExternalLink({ ...base, protocol: 'https:', lastGestureAtMs: null })).toBe(false);
    expect(admitExternalLink({ ...base, protocol: 'https:', nowMs: 60_000 })).toBe(false);
    // A timestamp from the future is not evidence of a click.
    expect(admitExternalLink({ ...base, protocol: 'https:', nowMs: 9_000 })).toBe(false);
  });

  it('refuses a scheme a tab has no business opening from a document', () => {
    for (const protocol of ['javascript:', 'file:', 'data:', 'blob:', 'vbscript:', '']) {
      expect(admitExternalLink({ ...base, protocol }), protocol).toBe(false);
    }
  });

  it('refuses a link activated anywhere but a canvas frame', () => {
    expect(admitExternalLink({ ...base, frameIsCanvas: false, protocol: 'https:' })).toBe(false);
  });
});
