/**
 * Per-key sliding-window rate limiting.
 *
 * Two different attacks are being slowed down here, and they want different
 * keys:
 *
 * - **A stolen phone.** It holds a valid token, so authentication cannot stop
 *   it. What stops it is a ceiling on how often *that device* may connect and
 *   how many requests it may make, so a pocket-dialling or hostile client
 *   cannot turn the harness into a busy loop.
 * - **A token-guessing loop.** It does not hold a token, so it has no device id
 *   to key on. Those attempts are keyed by source address instead, which also
 *   bounds the CPU a single peer can burn: verifying a token is a deliberate
 *   scrypt hash, so an unbounded guesser would be a denial of service whether or
 *   not it ever guesses right.
 *
 * A sliding window rather than a token bucket: "N connections per minute" is a
 * sentence an operator can check against reality, and it is trivially testable
 * because the decision depends only on the clock, which is injected.
 */

export interface RateLimitOptions {
  /** Length of the window every limit is measured over. Default 60s. */
  windowMs?: number;
  /** Connection attempts allowed per device per window. Default 10. */
  maxConnectionsPerDevice?: number;
  /** Requests forwarded per device (or per address, before a device is known). Default 300. */
  maxRequestsPerDevice?: number;
  /**
   * Unauthenticated attempts allowed per source address per window, counting
   * unknown and revoked tokens as well as pairing connections. Default 30.
   */
  maxAttemptsPerAddress?: number;
  /** Injectable clock. Tests advance it instead of sleeping. */
  now?: () => number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Milliseconds until the oldest hit leaves the window. 0 when allowed. */
  readonly retryAfterMs: number;
  readonly remaining: number;
}

/** Bound on distinct keys held at once, so a spray of addresses cannot grow memory forever. */
const MAX_KEYS = 4096;

export class SlidingWindow {
  private readonly windows = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: { windowMs: number; now: () => number }) {
    this.windowMs = options.windowMs;
    this.now = options.now;
  }

  /**
   * Record one hit against `key` if the window has room.
   *
   * A limit of zero or less refuses everything, which is how a deployment turns
   * a path off (`maxConnectionsPerDevice: 0`) rather than by passing a special
   * value the caller has to know about.
   */
  take(key: string, limit: number): RateLimitDecision {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const hits = (this.windows.get(key) ?? []).filter((at) => at > cutoff);

    if (limit <= 0 || hits.length >= limit) {
      this.sweep();
      this.windows.set(key, hits);
      const oldest = hits[0];
      return {
        allowed: false,
        retryAfterMs: oldest === undefined ? this.windowMs : Math.max(1, oldest + this.windowMs - now),
        remaining: 0,
      };
    }

    hits.push(now);
    this.windows.set(key, hits);
    return { allowed: true, retryAfterMs: 0, remaining: limit - hits.length };
  }

  /** Test seam, and useful when a deployment reloads its policy. */
  reset(): void {
    this.windows.clear();
  }

  /** Drop keys whose hits have all aged out. */
  private sweep(): void {
    if (this.windows.size < MAX_KEYS) return;
    const cutoff = this.now() - this.windowMs;
    for (const [key, hits] of this.windows) {
      if (hits.every((at) => at <= cutoff)) this.windows.delete(key);
    }
  }
}

export function createLimiter(options: RateLimitOptions): SlidingWindow {
  return new SlidingWindow({
    windowMs: options.windowMs ?? 60_000,
    now: options.now ?? Date.now,
  });
}
