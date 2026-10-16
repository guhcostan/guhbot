/**
 * Expo-backed storage, split by sensitivity.
 *
 * The device token is a bearer credential: whoever reads it can read every
 * transcript this device may read and drive background work as it, so it goes
 * to the platform keystore (iOS Keychain / Android Keystore) where the OS can
 * require an unlocked device and exclude it from device backups.
 *
 * The host address is not a credential. The user typed it, or scanned it off a
 * screen, it is useless without the token, and ordinary app storage is faster
 * with no per-item size limit.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { createSessionStore, type StringStore } from './storage';

const values: StringStore = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
};

const secrets: StringStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
};

export const sessionStore = createSessionStore(values, secrets);
