/**
 * Where the stores are built. Kept out of the React file so the wiring is
 * readable on its own, and so the dependency edges (app -> transcript) are
 * visible in one place.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { defaultDeviceName, devicePlatformFor } from '../core/device.js';
import { HostConnection } from '../host/connection.js';
import { sessionStore } from '../host/expo-storage.js';
import { createAppStore, type AppStore } from './app-store.js';
import { createTranscriptStore, type TranscriptStore, type TranscriptStoreDeps } from './transcript-store.js';

export interface Stores {
  readonly app: AppStore;
  readonly transcript: TranscriptStore;
}

export function createStores(): Stores {
  // The app store forwards transcript events, and the transcript store issues
  // its reads through the app store's link: one is created first, the other is
  // filled in immediately after.
  let transcript: TranscriptStore | null = null;

  const app = createAppStore({
    session: sessionStore,
    createConnection: (options) => new HostConnection(options),
    platform: devicePlatformFor(Platform.OS),
    deviceName: () => defaultDeviceName(Constants.deviceName, Platform.OS),
    onTranscriptEvent: (event, payload) => transcript?.applyLive(event, payload),
    onHostReconnected: () => {
      void transcript?.resync();
    },
  });

  const request: TranscriptStoreDeps['request'] = (method, params) => app.request(method, params);
  transcript = createTranscriptStore({ request });

  return { app, transcript };
}
