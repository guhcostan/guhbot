/**
 * A store small enough to read in one sitting.
 *
 * It satisfies the contract `useSyncExternalStore` expects (a stable snapshot
 * plus subscribe), and it lives outside React so the state layer can be reasoned
 * about, and later tested, without rendering anything.
 */
export interface Readable<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

export interface Writable<T> extends Readable<T> {
  set(next: T): void;
  update(updater: (current: T) => T): void;
}

export function createStore<T>(initial: T): Writable<T> {
  let value = initial;
  const listeners = new Set<() => void>();

  const set = (next: T): void => {
    if (Object.is(next, value)) return;
    value = next;
    // Copy first: a listener may unsubscribe while we are notifying.
    for (const listener of [...listeners]) listener();
  };

  return {
    get: () => value,
    set,
    update: (updater) => set(updater(value)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
