/**
 * Where the pairing survives an app restart.
 *
 * The interesting parts are the two ports (`StringStore`) and the tolerant
 * parser below: a corrupt entry must send the user back to the pairing screen,
 * never crash the app on launch.
 */
import { normalizeHost, parsePort, type HostEndpoint } from '../core/endpoint';

export const HOST_KEY = 'guhbot.host';
export const TOKEN_KEY = 'guhbot.device-token';

export interface PersistedHost extends HostEndpoint {
  readonly deviceId: string;
  readonly deviceName: string;
}

export interface SessionStore {
  loadHost(): Promise<PersistedHost | null>;
  saveHost(host: PersistedHost): Promise<void>;
  loadToken(): Promise<string | null>;
  saveToken(token: string): Promise<void>;
  /** Removes the credential and nothing else. */
  clearToken(): Promise<void>;
}

/** The two primitives this app needs; AsyncStorage and SecureStore both fit. */
export interface StringStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export function parsePersistedHost(raw: string): PersistedHost | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const host = typeof record['host'] === 'string' ? normalizeHost(record['host']) : null;
  const port = typeof record['port'] === 'number' ? record['port'] : typeof record['port'] === 'string' ? parsePort(record['port']) : null;
  if (host === null || port === null || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    host,
    port,
    deviceId: typeof record['deviceId'] === 'string' ? record['deviceId'] : '',
    deviceName: typeof record['deviceName'] === 'string' ? record['deviceName'] : '',
  };
}

export function createSessionStore(values: StringStore, secrets: StringStore): SessionStore {
  return {
    async loadHost(): Promise<PersistedHost | null> {
      const raw = await values.get(HOST_KEY);
      return raw === null ? null : parsePersistedHost(raw);
    },
    async saveHost(host: PersistedHost): Promise<void> {
      await values.set(HOST_KEY, JSON.stringify(host));
    },
    async loadToken(): Promise<string | null> {
      const token = await secrets.get(TOKEN_KEY);
      return token !== null && token.length > 0 ? token : null;
    },
    async saveToken(token: string): Promise<void> {
      await secrets.set(TOKEN_KEY, token);
    },
    async clearToken(): Promise<void> {
      await secrets.remove(TOKEN_KEY);
    },
  };
}
