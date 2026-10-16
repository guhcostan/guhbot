/**
 * Ages and clock times without `Intl`, which is not reliably present on every
 * React Native runtime and is not worth a polyfill for a transcript header.
 */

export function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function ageLabel(iso: string, nowMs: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** For a deadline in the future, where `ageLabel` would only ever say "now". */
export function remainingLabel(iso: string, nowMs: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((then - nowMs) / 1000);
  if (seconds <= 0) return 'due now';
  if (seconds < 60) return 'in under a minute';
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `in ${Math.round(seconds / 3600)}h`;
  return `in ${Math.round(seconds / 86_400)}d`;
}

/** Long entries are clipped for the list; the transcript is not a log viewer. */
export function clampText(text: string, limit = 4000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`;
}
