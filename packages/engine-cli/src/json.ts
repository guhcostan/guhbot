/**
 * Defensive readers for JSON that came out of somebody else's CLI.
 *
 * The stream-json formats we parse are not stable public contracts: every field
 * is optional, one of them is sometimes a string where you expect an object, and
 * a version bump can rename or drop anything. A driver that trusts the shape
 * crashes on the next release of the tool it drives, so nothing here throws and
 * every getter returns `null` rather than pretending.
 */

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Read a dotted path out of nested objects, e.g. `part.state.input`. */
export function at(object: JsonObject, path: string): unknown {
  let current: unknown = object;
  for (const segment of path.split('.')) {
    const record = asObject(current);
    if (record === null) return undefined;
    current = record[segment];
  }
  return current;
}

/** Read a dotted path and require a string. */
export function stringAt(object: JsonObject, path: string): string | null {
  return asString(at(object, path));
}

/** Read a dotted path and require a finite number. */
export function numberAt(object: JsonObject, path: string): number | null {
  return asNumber(at(object, path));
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`;
}

/**
 * Collect the numeric leaves of a usage record into a flat bag.
 *
 * Every CLI shapes its token counts differently, and they nest them to different
 * depths (`cache.read`, `cache_creation.ephemeral_5m_input_tokens`). Flattening
 * keeps the numbers reportable without pretending they share a schema.
 */
export function flattenNumbers(value: unknown, prefix = '', depth = 2): Record<string, number> | null {
  const record = asObject(value);
  if (record === null) return null;
  const flat: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    const name = prefix.length === 0 ? key : `${prefix}.${key}`;
    const numeric = asNumber(entry);
    if (numeric !== null) {
      flat[name] = numeric;
      continue;
    }
    if (depth > 0) {
      const nested = flattenNumbers(entry, name, depth - 1);
      if (nested !== null) Object.assign(flat, nested);
    }
  }
  return Object.keys(flat).length === 0 ? null : flat;
}

/** Sum two usage bags. Missing keys on either side are simply carried over. */
export function mergeNumbers(
  left: Record<string, number> | null,
  right: Record<string, number> | null,
): Record<string, number> | null {
  if (left === null) return right;
  if (right === null) return left;
  const merged: Record<string, number> = { ...left };
  for (const [key, value] of Object.entries(right)) merged[key] = (merged[key] ?? 0) + value;
  return merged;
}
