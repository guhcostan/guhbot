import { describe, expect, it } from 'vitest';

import { createSessionStore, HOST_KEY, parsePersistedHost, TOKEN_KEY, type StringStore } from '../src/host/storage.js';

function memoryStore(initial: Record<string, string> = {}): StringStore & { readonly values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
  };
}

describe('parsePersistedHost', () => {
  it('reads back what was written', () => {
    expect(parsePersistedHost('{"host":"192.168.1.20","port":8787,"deviceId":"dv_1","deviceName":"Phone"}')).toEqual({
      host: '192.168.1.20',
      port: 8787,
      deviceId: 'dv_1',
      deviceName: 'Phone',
    });
  });

  it('sends the user back to pairing rather than crashing on a corrupt entry', () => {
    // A truncated write, an old format or a hand-edited file must all land on
    // the pairing screen, which is the only screen that can fix it.
    for (const raw of ['', 'not json', 'null', '[]', '"host"', '{}', '{"host":"h"}', '{"host":"has space","port":80}', '{"host":"h","port":0}', '{"host":"h","port":70000}']) {
      expect(parsePersistedHost(raw)).toBeNull();
    }
  });

  it('accepts a port stored as a string and defaults the optional fields', () => {
    expect(parsePersistedHost('{"host":"macbook.local","port":"8787"}')).toEqual({
      host: 'macbook.local',
      port: 8787,
      deviceId: '',
      deviceName: '',
    });
  });
});

describe('session store', () => {
  it('keeps the token out of the plain store', async () => {
    const values = memoryStore();
    const secrets = memoryStore();
    const session = createSessionStore(values, secrets);

    await session.saveHost({ host: '192.168.1.20', port: 8787, deviceId: 'dv_1', deviceName: 'Phone' });
    await session.saveToken('a'.repeat(43));

    expect(values.values.has(HOST_KEY)).toBe(true);
    expect(values.values.has(TOKEN_KEY)).toBe(false);
    expect(secrets.values.get(TOKEN_KEY)).toBe('a'.repeat(43));
    expect(await session.loadToken()).toBe('a'.repeat(43));
    expect(await session.loadHost()).toEqual({ host: '192.168.1.20', port: 8787, deviceId: 'dv_1', deviceName: 'Phone' });
  });

  it('clears the token and keeps the address, so re-pairing is one field', async () => {
    const values = memoryStore();
    const secrets = memoryStore({ [TOKEN_KEY]: 'token' });
    const session = createSessionStore(values, secrets);
    await session.saveHost({ host: '192.168.1.20', port: 8787, deviceId: 'dv_1', deviceName: 'Phone' });

    await session.clearToken();

    expect(await session.loadToken()).toBeNull();
    expect(await session.loadHost()).not.toBeNull();
  });

  it('treats an empty stored token as no token at all', async () => {
    const session = createSessionStore(memoryStore(), memoryStore({ [TOKEN_KEY]: '' }));
    expect(await session.loadToken()).toBeNull();
  });
});
