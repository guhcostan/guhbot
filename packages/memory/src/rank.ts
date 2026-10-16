import type { Memory } from './types.js';

/**
 * Ranking for `memory_recall`.
 *
 * Deterministic by construction, because a rank that varies between two
 * identical calls makes every downstream test flaky and every client rendering
 * unstable:
 *
 *  1. **Score** — the number of *distinct* query words the fact contains. An
 *     integer, so two calls on the same data cannot disagree.
 *  2. **`createdAt` descending** — the recency tie-break. Newer facts win.
 *  3. **`id` ascending** — a final total order, so even two facts written in the
 *     same millisecond are ordered rather than left to the sort's mood.
 *
 * Recency is `createdAt`, *not* `lastUsedAt`, and that is load-bearing: recall
 * writes `lastUsedAt`, so ranking on it would make the second identical recall
 * return a different order than the first. `lastUsedAt` and `useCount` are
 * telemetry for a future pruning pass, not rank inputs.
 *
 * The score is keyword overlap on purpose:
 *
 *  - it needs no embedding model, no network call and no index to keep in sync;
 *  - a store of a few hundred short facts has no recall problem that embeddings
 *    solve, and a bad embedding returns a *confidently wrong* fact, which is
 *    worse than returning none;
 *  - it is explainable, which matters when a fact surfaces in a run and the user
 *    asks why.
 *
 * A fact with a score of zero is not returned at all. "No overlap returns
 * nothing" is the property that keeps an unrelated query from dumping the whole
 * store into a prompt.
 */

/**
 * Words that carry no recall signal.
 *
 * English and Portuguese, because this repository's users write both. Deliberately
 * short: a stopword list that grows turns into a linguistic opinion, and removing
 * a word that actually mattered is worse than a little noise.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from', 'had', 'has', 'have',
  'he', 'her', 'his', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our',
  'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'they', 'this', 'to', 'was', 'we', 'were', 'what',
  'when', 'which', 'who', 'will', 'with', 'you', 'your',
  'ao', 'aos', 'as', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'ele', 'ela', 'eu', 'foi', 'mais', 'mas',
  'na', 'nas', 'no', 'nos', 'o', 'os', 'ou', 'para', 'por', 'que', 'se', 'sem', 'ser', 'seu', 'sua', 'um', 'uma',
]);

/**
 * Fold a string into comparable content words.
 *
 * Accents are stripped so "reuniao" matches "reunião" and "São Paulo" matches
 * "sao paulo" — a user typing on a phone keyboard will produce both. Case is
 * folded for the same reason.
 *
 * Single letters are filler ("a b c"), but a single digit is not: "they have 3
 * offices" and "they have 5 offices" are different facts, and collapsing them
 * would let one silently restate the other.
 */
export function contentTokens(text: string): Set<string> {
  const folded = text
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
  const tokens = new Set<string>();
  for (const raw of folded.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 && !/^\p{N}$/u.test(raw)) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

/** Distinct content words shared between a fact and the query. */
export function overlapScore(text: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  let score = 0;
  for (const token of contentTokens(text)) {
    if (queryTokens.has(token)) score += 1;
  }
  return score;
}

/**
 * The documented rank, applied to one agent's facts.
 *
 * Pure: it reads no clock, writes nothing, and returns the same order for the
 * same inputs every time.
 */
export function rankMemories(memories: readonly Memory[], query: string, limit: number): Memory[] {
  const queryTokens = contentTokens(query);
  if (queryTokens.size === 0 || limit <= 0) return [];

  const scored: { memory: Memory; score: number }[] = [];
  for (const memory of memories) {
    const score = overlapScore(memory.text, queryTokens);
    if (score > 0) scored.push({ memory, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.memory.createdAt !== b.memory.createdAt) return a.memory.createdAt < b.memory.createdAt ? 1 : -1;
    return a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0;
  });

  return scored.slice(0, limit).map((entry) => entry.memory);
}

/**
 * Normalized text for exact-restatement detection.
 *
 * Punctuation and filler are dropped, so "They only sign annual contracts." and
 * "they only sign annual contracts" are the same fact restated rather than two
 * facts that both surface forever.
 */
export function normalizeForCompare(text: string): string {
  return [...contentTokens(text)].sort().join(' ');
}

/**
 * Whether `oldText` says nothing that `newText` does not say.
 *
 * This is the implicit half of the correction rule: when the *user* states a
 * fact, older facts whose every content word appears in the new statement are
 * replaced rather than accumulated ("they only sign annual" is replaced by "they
 * only sign annual, never monthly").
 *
 * Deliberately conservative. It can only ever delete a fact that is fully
 * contained in the correction, so an unrelated fact survives; anything more
 * aggressive (a similarity threshold, a shared subject) would silently delete
 * facts the user never corrected, which is unrecoverable.
 */
export function isSubsumedBy(oldText: string, newText: string): boolean {
  const oldTokens = contentTokens(oldText);
  if (oldTokens.size === 0) return false;
  const newTokens = contentTokens(newText);
  for (const token of oldTokens) {
    if (!newTokens.has(token)) return false;
  }
  return true;
}
