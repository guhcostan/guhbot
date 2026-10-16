import { describe, expect, it } from 'vitest';
import { contentTokens, isSubsumedBy, normalizeForCompare, overlapScore, rankMemories } from '../src/rank.js';
import type { Memory } from '../src/types.js';

/**
 * Ranking is the one piece of this capability every other piece depends on, and
 * the one that goes wrong quietly: an unstable order makes recall tests flaky and
 * makes a client's rendering change between two identical requests.
 */

function memory(id: string, text: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id,
    agentId: 'ag_a',
    text,
    source: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    useCount: 0,
    ...overrides,
  };
}

describe('rankMemories', () => {
  it('orders by how many distinct query words a fact shares', () => {
    const rows = [
      memory('mem_1', 'they only sign annual contracts'),
      memory('mem_2', 'annual contract renewal happens in march'),
      memory('mem_3', 'the office is in lisbon'),
    ];

    const ranked = rankMemories(rows, 'annual contract renewal', 5);

    // mem_2 shares three words, mem_1 shares two, mem_3 none (and is dropped).
    expect(ranked.map((row) => row.id)).toEqual(['mem_2', 'mem_1']);
  });

  it('returns nothing when no fact shares a word with the query', () => {
    const rows = [memory('mem_1', 'annual contracts'), memory('mem_2', 'billing contact')];

    expect(rankMemories(rows, 'kubernetes ingress', 5)).toEqual([]);
  });

  it('returns nothing for a query that carries no content words', () => {
    const rows = [memory('mem_1', 'annual contracts')];

    expect(rankMemories(rows, '   ', 5)).toEqual([]);
    expect(rankMemories(rows, 'the of and', 5)).toEqual([]);
  });

  it('breaks a score tie by createdAt, newest first', () => {
    const older = memory('mem_old', 'annual contracts', { createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = memory('mem_new', 'annual invoices', { createdAt: '2026-06-01T00:00:00.000Z' });

    expect(rankMemories([older, newer], 'annual', 5).map((row) => row.id)).toEqual(['mem_new', 'mem_old']);
    // And the same pair in the opposite input order: the tie-break, not the
    // array order, decides.
    expect(rankMemories([newer, older], 'annual', 5).map((row) => row.id)).toEqual(['mem_new', 'mem_old']);
  });

  it('breaks a createdAt tie by id, so the order is total', () => {
    const b = memory('mem_b', 'annual contracts');
    const a = memory('mem_a', 'annual invoices');

    expect(rankMemories([b, a], 'annual', 5).map((row) => row.id)).toEqual(['mem_a', 'mem_b']);
  });

  it('ignores lastUsedAt in ranking, so recall cannot reorder its own result', () => {
    // The row that has been used least recently is also the newest. If recency
    // meant lastUsedAt the order would flip; it must not.
    const used = memory('mem_used', 'annual contracts', {
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-09-01T00:00:00.000Z',
      useCount: 9,
    });
    const fresh = memory('mem_fresh', 'annual invoices', { createdAt: '2026-06-01T00:00:00.000Z' });

    expect(rankMemories([used, fresh], 'annual', 5).map((row) => row.id)).toEqual(['mem_fresh', 'mem_used']);
  });

  it('is deterministic across repeated calls and does not mutate its input', () => {
    const rows = [
      memory('mem_1', 'annual contracts renew in march'),
      memory('mem_2', 'annual invoices are sent by email'),
      memory('mem_3', 'annual contracts are signed by the cfo'),
    ];
    const snapshot = JSON.parse(JSON.stringify(rows)) as Memory[];

    const first = rankMemories(rows, 'annual contracts', 5).map((row) => row.id);
    for (let run = 0; run < 25; run += 1) {
      expect(rankMemories(rows, 'annual contracts', 5).map((row) => row.id)).toEqual(first);
    }
    expect(rows).toEqual(snapshot);
  });

  it('returns at most the requested number of facts', () => {
    const rows = [
      memory('mem_1', 'annual contracts'),
      memory('mem_2', 'annual invoices'),
      memory('mem_3', 'annual reports'),
    ];

    expect(rankMemories(rows, 'annual', 2)).toHaveLength(2);
    expect(rankMemories(rows, 'annual', 0)).toEqual([]);
  });

  it('matches across accents, case and punctuation', () => {
    const rows = [memory('mem_1', 'A reunião com o fornecedor é na quinta')];

    expect(rankMemories(rows, 'reuniao fornecedor', 5).map((row) => row.id)).toEqual(['mem_1']);
    expect(rankMemories(rows, 'REUNIÃO, fornecedor!', 5).map((row) => row.id)).toEqual(['mem_1']);
  });

  it('counts a repeated word once', () => {
    const tokens = contentTokens('annual annual annual');
    expect([...tokens]).toEqual(['annual']);
    expect(overlapScore('annual annual annual', contentTokens('annual'))).toBe(1);
  });
});

describe('normalizeForCompare', () => {
  it('treats the same fact with different punctuation and order as one fact', () => {
    expect(normalizeForCompare('They only sign annual contracts.')).toBe(
      normalizeForCompare('contracts annual sign only they'),
    );
  });

  it('keeps a single digit, so two counts are two facts', () => {
    expect(normalizeForCompare('they have 3 offices')).not.toBe(normalizeForCompare('they have 5 offices'));
  });

  it('separates facts that differ by a content word', () => {
    expect(normalizeForCompare('they sign annual contracts')).not.toBe(
      normalizeForCompare('they sign monthly contracts'),
    );
  });
});

describe('isSubsumedBy', () => {
  it('treats a fact fully contained in the correction as replaced', () => {
    expect(isSubsumedBy('they only sign annual', 'they only sign annual, never monthly')).toBe(true);
  });

  it('leaves a fact alone when the correction adds a word the old fact lacks', () => {
    expect(isSubsumedBy('they only sign annual contracts', 'they only sign monthly')).toBe(false);
  });

  it('never treats a fact with no content words as subsumed', () => {
    expect(isSubsumedBy('the of and', 'the of and more')).toBe(false);
  });

  it('is not fooled by an empty old fact', () => {
    expect(isSubsumedBy('   ', 'anything at all')).toBe(false);
  });
});
