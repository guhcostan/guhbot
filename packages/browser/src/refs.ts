import type { RawElement } from './in-page.js';

/**
 * The ref scheme.
 *
 * A read numbers interactive elements and embeds each number in the text the
 * model sees: `[3] button "Sign in"`. A ref means "the element the host called 3
 * when it last showed you this document", and nothing more.
 *
 * Three rules keep it honest:
 *
 *  1. **A full read renumbers from 1** in DOM order and replaces the table.
 *  2. **A scoped read preserves.** Elements already numbered keep their number
 *     (so a ref from the full read still resolves to the same element), and
 *     elements the scope reveals for the first time take the next numbers. A
 *     scoped read must not silently invalidate the refs a model is holding: that
 *     turns "read the price, then click Buy" into a failed click.
 *  3. **Navigation discards the table**, because refs describe a document and
 *     the document is gone. An unresolvable ref is an error, never a best-effort
 *     click on whatever moved into that position.
 *
 * The table is bounded by the call's element budget: once `ceiling` entries
 * exist, a scoped read stops minting numbers rather than growing without limit,
 * and reports fewer elements than it found.
 */
export interface RefAssignment {
  /** What this call should show the model, with refs resolved. */
  readonly shown: RawElement[];
  /** The table after this call. */
  readonly table: RawElement[];
}

export function assignRefs(
  table: readonly RawElement[],
  incoming: readonly RawElement[],
  ceiling: number,
): RefAssignment {
  const limit = Math.max(1, Math.floor(ceiling));
  const known = new Map(table.map((element) => [element.selector, element.ref]));
  const shown: RawElement[] = [];
  const added: RawElement[] = [];
  let next = table.reduce((max, element) => Math.max(max, element.ref), 0);

  for (const element of incoming) {
    const previous = known.get(element.selector);
    if (previous !== undefined) {
      shown.push({ ...element, ref: previous });
      continue;
    }
    if (table.length + added.length >= limit) continue;
    next += 1;
    known.set(element.selector, next);
    const numbered = { ...element, ref: next };
    shown.push(numbered);
    added.push(numbered);
  }

  return { shown, table: added.length === 0 ? [...table] : [...table, ...added] };
}
