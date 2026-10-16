/**
 * The external-link gate.
 *
 * The sandbox deliberately carries `allow-popups-to-escape-sandbox`, which means
 * a link inside a canvas document opens as a normal, unsandboxed tab. That is
 * the one hole in the boundary, and this is what covers it: a navigation is
 * admitted only when the user did something in the last second, and only to a
 * scheme a browser tab can meaningfully open.
 *
 * Without the gesture check, agent-authored HTML (written after reading a page
 * somebody else controls) could navigate the user anywhere the moment they
 * glanced at the canvas — the classic drive-by. With it, a click the user
 * actually made is the only thing that can open a link, and a script that fires
 * a click on its own is outside the window by the time it matters.
 *
 * Pure and side-effect free: the renderer owns the gesture timestamp and the
 * focused frame, and calls this before it navigates. Keeping the decision here
 * means a client cannot quietly invent a laxer one.
 */
export const LINK_GATE_WINDOW_MS = 1000;

/** Schemes a canvas link may open. `javascript:` and `file:` are not among them. */
export const ADMITTED_LINK_PROTOCOLS: readonly string[] = Object.freeze(['http:', 'https:', 'mailto:', 'tel:']);

export interface LinkAdmissionRequest {
  /** True when the frame the link was activated in is a canvas frame. */
  readonly frameIsCanvas: boolean;
  /** Protocol of the requested target, e.g. `https:`, as parsed by the client. */
  readonly protocol: string;
  /** Monotonic timestamp of the last *trusted* user input, or null for none. */
  readonly lastGestureAtMs: number | null;
  /** Monotonic now. */
  readonly nowMs: number;
}

export function admitExternalLink(request: LinkAdmissionRequest): boolean {
  if (!request.frameIsCanvas) return false;
  if (request.lastGestureAtMs === null) return false;

  const age = request.nowMs - request.lastGestureAtMs;
  // A negative age means the clock moved backwards or the caller mixed sources;
  // either way the gesture is not evidence of anything.
  if (age < 0 || age > LINK_GATE_WINDOW_MS) return false;

  return ADMITTED_LINK_PROTOCOLS.includes(request.protocol);
}
