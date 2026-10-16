/** Raised when one call outlives `callTimeoutMs`. */
export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}

export interface DeadlineOptions {
  readonly timeoutMs: number;
  readonly label: string;
  /** The run's abort signal, when there is one: an interrupted run stops waiting. */
  readonly signal?: AbortSignal;
}

/**
 * Bound one unit of work by wall-clock time and by the run's cancellation.
 *
 * Both matter and they are not the same thing: a run can be interrupted while a
 * page is still loading, and a page can hang forever in a run nobody interrupted.
 * The caller is responsible for the cleanup that follows a deadline — an aborted
 * Playwright operation leaves its browser in an unknown state, so the session
 * throws that browser away rather than reusing it.
 */
export async function withDeadline<T>(work: () => Promise<T>, options: DeadlineOptions): Promise<T> {
  const signal = options.signal;
  if (signal?.aborted === true) {
    throw new DeadlineError(`${options.label} was cancelled before it started`);
  }

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;

  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineError(`${options.label} exceeded its ${options.timeoutMs}ms budget`));
    }, options.timeoutMs);
    timer.unref();
  });

  const cancelled = new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    onAbort = () => reject(new DeadlineError(`${options.label} was cancelled by the run`));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([work(), expired, cancelled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
