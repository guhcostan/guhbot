import { createContext, useContext, useEffect, useMemo, type ReactElement, type ReactNode } from 'react';

import type { AppSnapshot, AppStore } from './app-store.js';
import { createStores, type Stores } from './stores.js';
import type { TranscriptSnapshot, TranscriptStore } from './transcript-store.js';
import { useStore } from './use-store.js';

const StoresContext = createContext<Stores | null>(null);

export function StoreProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const stores = useMemo(() => createStores(), []);

  useEffect(() => {
    void stores.app.bootstrap();
  }, [stores]);

  return <StoresContext.Provider value={stores}>{children}</StoresContext.Provider>;
}

function useStores(): Stores {
  const stores = useContext(StoresContext);
  if (stores === null) throw new Error('StoreProvider is missing above this screen');
  return stores;
}

export function useAppStore(): AppStore {
  return useStores().app;
}

export function useAppState(): AppSnapshot {
  return useStore(useStores().app);
}

export function useTranscriptStore(): TranscriptStore {
  return useStores().transcript;
}

export function useTranscriptState(): TranscriptSnapshot {
  return useStore(useStores().transcript);
}
