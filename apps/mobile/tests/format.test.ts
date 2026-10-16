import { describe, expect, it } from 'vitest';

import { ageLabel, clampText, remainingLabel, shortTime } from '../src/core/format';

const NOON = Date.parse('2026-03-04T12:00:00.000Z');

describe('formatting', () => {
  it('prints a clock time and refuses to invent one from garbage', () => {
    expect(shortTime('2026-03-04T12:34:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
    expect(shortTime('not a date')).toBe('');
  });

  it('describes how long ago something was asked', () => {
    expect(ageLabel(new Date(NOON - 5_000).toISOString(), NOON)).toBe('just now');
    expect(ageLabel(new Date(NOON - 4 * 60_000).toISOString(), NOON)).toBe('4m ago');
    expect(ageLabel(new Date(NOON - 3 * 3_600_000).toISOString(), NOON)).toBe('3h ago');
    expect(ageLabel(new Date(NOON - 2 * 86_400_000).toISOString(), NOON)).toBe('2d ago');
    expect(ageLabel('nonsense', NOON)).toBe('');
  });

  it('counts down to an approval deadline instead of calling it "now"', () => {
    expect(remainingLabel(new Date(NOON + 4 * 60_000).toISOString(), NOON)).toBe('in 4m');
    expect(remainingLabel(new Date(NOON + 30_000).toISOString(), NOON)).toBe('in under a minute');
    expect(remainingLabel(new Date(NOON - 1_000).toISOString(), NOON)).toBe('due now');
    expect(remainingLabel('nonsense', NOON)).toBe('');
  });

  it('clips a long entry and says how much was cut', () => {
    expect(clampText('short', 10)).toBe('short');
    const clipped = clampText('x'.repeat(20), 10);
    expect(clipped.startsWith('x'.repeat(10))).toBe(true);
    expect(clipped).toContain('10 more characters');
  });
});
