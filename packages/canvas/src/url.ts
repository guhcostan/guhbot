import { isCanvasId } from './digest.js';
import { CanvasError } from './errors.js';

/**
 * The canvas locator.
 *
 * A canvas is addressed as `guhbot-canvas://frame/<sha256>?theme=light|dark`.
 * The grammar is deliberately rigid and validated by re-serialisation: the host
 * must be exactly `frame`, the port, userinfo and fragment must be empty, the
 * theme must be one of two literals, and the query must equal the canonical
 * `?theme=...` exactly. Anything else — an extra parameter, a reordered one, a
 * duplicate — is not a canvas URL.
 *
 * Why that strictness matters: this string reaches a privileged scheme handler,
 * where a parameter a client forgot to check is how a `theme=light&remote=...`
 * turns into a feature nobody reviewed.
 *
 * This package builds and validates the URL, and serves no scheme: only
 * `@guhbot/server` binds anything, and registering a custom scheme is the
 * desktop shell's job. The bytes always come from `canvas.get`, never from the
 * URL itself.
 */
export const CANVAS_SCHEME = 'guhbot-canvas';
export const CANVAS_FRAME_HOST = 'frame';
export const CANVAS_THEMES = ['light', 'dark'] as const;

export type CanvasTheme = (typeof CANVAS_THEMES)[number];

export interface CanvasUrlParts {
  readonly id: string;
  readonly theme: CanvasTheme;
}

export function canvasUrl(id: string, theme: CanvasTheme = 'light'): string {
  if (!isCanvasId(id)) {
    throw new CanvasError('bad-request', `cannot build a canvas URL for ${JSON.stringify(id.slice(0, 96))}: not a canvas id`);
  }
  return `${CANVAS_SCHEME}://${CANVAS_FRAME_HOST}/${id}?theme=${theme}`;
}

/**
 * Parse a canvas URL, or return null.
 *
 * Null rather than a throw, because every caller is deciding whether to admit a
 * URL: "that is not one of ours" is an ordinary answer, not an error.
 */
export function parseCanvasUrl(raw: string): CanvasUrlParts | null {
  if (!URL.canParse(raw)) return null;
  const url = new URL(raw);

  if (url.protocol !== `${CANVAS_SCHEME}:`) return null;
  if (url.hostname !== CANVAS_FRAME_HOST) return null;
  if (url.port !== '' || url.username !== '' || url.password !== '' || url.hash !== '') return null;

  const theme = url.searchParams.get('theme');
  if (theme !== 'light' && theme !== 'dark') return null;
  // The query must be exactly the canonical serialisation: `searchParams.get`
  // above takes the first of a duplicated parameter, so this is what rejects
  // `?theme=light&theme=dark` and every smuggled extra.
  if (url.search !== `?theme=${theme}`) return null;

  const segments = url.pathname.split('/');
  const id = segments[1];
  if (segments.length !== 2 || segments[0] !== '' || id === undefined || !isCanvasId(id)) return null;

  return { id, theme };
}
