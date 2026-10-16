import { describe, expect, it } from 'vitest';

import { connectionView, defaultDeviceName, devicePlatformFor } from '../src/core/device';

describe('device description', () => {
  it('maps the platform React Native reports onto the protocol vocabulary', () => {
    expect(devicePlatformFor('ios')).toBe('ios');
    expect(devicePlatformFor('android')).toBe('android');
    expect(devicePlatformFor('web')).toBe('web');
    expect(devicePlatformFor('macos')).toBe('desktop');
    expect(devicePlatformFor('something-else')).toBe('web');
  });

  it('uses the device name the OS reports, with a fallback that is still useful', () => {
    expect(defaultDeviceName("Gustavo's iPhone", 'ios')).toBe("Gustavo's iPhone");
    expect(defaultDeviceName('   ', 'android')).toBe('Phone (android)');
    expect(defaultDeviceName(null, 'ios')).toBe('Phone (ios)');
  });
});

describe('connectionView', () => {
  it('does not spin before the host has ever answered', () => {
    const view = connectionView({ clientState: 'connecting', paired: true, hasBeenReady: false, detail: null });
    expect(view.state).toBe('connecting');
    expect(view.busy).toBe(true);
    expect(view.ready).toBe(false);
  });

  it('reports a host that went away as unreachable, never as busy', () => {
    const view = connectionView({
      clientState: 'closed',
      paired: true,
      hasBeenReady: true,
      detail: 'websocket error: connection refused',
    });
    expect(view.state).toBe('unreachable');
    expect(view.busy).toBe(false);
    expect(view.tone).toBe('bad');
    expect(view.hint).toContain('same network');
    expect(view.hint).toContain('connection refused');
  });

  it('distinguishes a first connection attempt from a reconnection', () => {
    const reconnecting = connectionView({ clientState: 'connecting', paired: true, hasBeenReady: true, detail: null });
    expect(reconnecting.state).toBe('retrying');
    expect(reconnecting.busy).toBe(false);
  });

  it('reports readiness only when the host has accepted the device', () => {
    expect(connectionView({ clientState: 'ready', paired: true, hasBeenReady: true, detail: null }).ready).toBe(true);
    expect(connectionView({ clientState: 'authenticating', paired: true, hasBeenReady: false, detail: null }).ready).toBe(false);
  });

  it('describes the unpaired app without pretending anything is connecting', () => {
    const view = connectionView({ clientState: 'idle', paired: false, hasBeenReady: false, detail: null });
    expect(view.state).toBe('unpaired');
    expect(view.busy).toBe(false);
  });
});
