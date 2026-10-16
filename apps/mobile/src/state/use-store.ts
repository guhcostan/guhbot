import { useSyncExternalStore } from 'react';

import type { Readable } from './store';

export function useStore<T>(store: Readable<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
