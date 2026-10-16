/**
 * Apple timestamps in `chat.db`.
 *
 * `message.date` counts from 2001-01-01T00:00:00Z and its unit depends on the
 * macOS version that wrote the row: nanoseconds on everything modern, whole
 * seconds on very old databases. There is no schema flag to consult, so the
 * magnitude of the value is the only signal — and the two are far enough apart
 * (7.3e17 vs 7.6e8 for a 2024 timestamp) that a single threshold separates them
 * without ambiguity.
 *
 * `node:sqlite` throws `ERR_OUT_OF_RANGE` for any INTEGER that does not fit in a
 * JavaScript number, which every nanosecond timestamp is. Statements in this
 * package therefore read integers as bigint and convert here, while the
 * magnitude is still known exactly.
 */

/** Unix milliseconds of the Apple epoch. */
export const APPLE_EPOCH_UNIX_MS = 978_307_200_000;

/**
 * Anything at or above this is nanoseconds. Seconds would have to reach the
 * year 33,000 to cross it, so the two magnitudes cannot collide.
 */
const NANOSECOND_MAGNITUDE_FLOOR = 1_000_000_000_000n;

export type AppleDateMagnitude = 'nanoseconds' | 'seconds';

export function isNanosecondMagnitude(value: bigint): boolean {
  return (value < 0n ? -value : value) >= NANOSECOND_MAGNITUDE_FLOOR;
}

/**
 * Pick the unit for a set of raw column values.
 *
 * One query must use one unit for both reading and filtering, so the unit is
 * decided from the largest timestamp present rather than per row: a database
 * that stores seconds cannot contain a value that looks like nanoseconds.
 */
export function detectMagnitude(values: readonly bigint[]): AppleDateMagnitude {
  for (const value of values) {
    if (isNanosecondMagnitude(value)) return 'nanoseconds';
  }
  return 'seconds';
}

/** `chat.db` writes 0 for "no date"; it is not 2001-01-01. */
export function appleTimestampToUnixMs(raw: bigint | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === 'bigint' ? raw : BigInt(Math.trunc(raw));
  if (value === 0n) return null;
  // Truncating nanoseconds to milliseconds loses sub-millisecond order, which is
  // below anything a transcript needs to show.
  const millis = isNanosecondMagnitude(value) ? value / 1_000_000n : value * 1_000n;
  return APPLE_EPOCH_UNIX_MS + Number(millis);
}

export function appleTimestampToIso(raw: bigint | number | null | undefined): string | null {
  const unixMs = appleTimestampToUnixMs(raw);
  if (unixMs === null) return null;
  const date = new Date(unixMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Inverse of {@link appleTimestampToIso}, for `date < ?` pagination bounds. */
export function isoToAppleTimestamp(iso: string, magnitude: AppleDateMagnitude): bigint | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  const millis = BigInt(Math.trunc(parsed - APPLE_EPOCH_UNIX_MS));
  return magnitude === 'nanoseconds' ? millis * 1_000_000n : millis / 1_000n;
}
