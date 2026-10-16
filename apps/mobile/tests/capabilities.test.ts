import { METHOD_NAMES, methodAuthz, methods, type DeviceClass } from '@guhbot/protocol';
import { describe, expect, it } from 'vitest';

import { asDeviceClass, capabilityFor, isPermitted, refusalDetail } from '../src/core/capabilities.js';

const PHONE: DeviceClass = 'background';

function refusal(deviceClass: DeviceClass | null, method: string) {
  const capability = capabilityFor(deviceClass, method);
  if (capability.allowed) throw new Error(`expected ${method} to be refused for ${String(deviceClass)}`);
  return capability;
}

describe('capabilityFor', () => {
  it('refuses a background device the methods that change the host', () => {
    for (const method of ['agents.create', 'agents.update', 'agents.delete', 'approvals.resolve', 'runs.start', 'runs.interrupt']) {
      const capability = refusal(PHONE, method);
      expect(capability.reason).toBe('device-class');
      expect(capability.requiredClass).toBe('person');
      // The point of the whole screen: it must say where the action belongs.
      expect(capability.detail).toContain('machine that runs the host');
      expect(refusalDetail(capability)).toBe(capability.detail);
    }
  });

  it('allows a background device to observe', () => {
    for (const method of ['agents.list', 'transcript.tail', 'transcript.page', 'approvals.list', 'host.status', 'devices.list']) {
      const capability = capabilityFor(PHONE, method);
      expect(capability.allowed).toBe(true);
      expect(refusalDetail(capability)).toBeNull();
    }
    expect(isPermitted(PHONE, 'agents.list')).toBe(true);
  });

  it('allows a person device to do the same things the host would allow', () => {
    for (const method of ['agents.create', 'approvals.resolve', 'runs.start', 'agents.list']) {
      expect(isPermitted('person', method)).toBe(true);
    }
  });

  it('treats an unpaired client as permitted to do nothing', () => {
    for (const method of ['agents.list', 'agents.create', 'transcript.tail']) {
      const capability = refusal(null, method);
      expect(capability.reason).toBe('unpaired');
    }
  });

  it('refuses methods the host cannot run on itself, whatever the class', () => {
    // pairing.begin mints credentials and is localOnly: a network client can
    // never call it, so the phone must not offer it.
    const capability = refusal('person', 'pairing.begin');
    expect(capability.reason).toBe('host-only');
    expect(isPermitted(PHONE, 'pairing.begin')).toBe(false);
  });

  it('reports a method this host does not implement', () => {
    const capability = refusal(PHONE, 'agents.teleport');
    expect(capability.reason).toBe('unknown-method');
    expect(capability.requiredClass).toBeNull();
  });

  it('permits a background device exactly when the host registry says background', () => {
    // The app's mapping must not drift from the host's own table: every method
    // that is not localOnly and not `person` has to be reachable from a phone.
    for (const name of METHOD_NAMES) {
      const spec = (methods as Record<string, { localOnly?: boolean } | undefined>)[name];
      const expected = methodAuthz(name) === 'background' && spec?.localOnly !== true;
      expect(isPermitted(PHONE, name), `background device vs ${name}`).toBe(expected);
    }
  });

  it('never lets a background device reach a person method', () => {
    for (const name of METHOD_NAMES) {
      if (methodAuthz(name) !== 'person') continue;
      expect(isPermitted(PHONE, name), `background device vs ${name}`).toBe(false);
    }
  });

  it('narrows a device class coming off the wire', () => {
    expect(asDeviceClass('background')).toBe('background');
    expect(asDeviceClass('person')).toBe('person');
    expect(asDeviceClass(null)).toBeNull();
    expect(asDeviceClass('anonymous')).toBeNull();
  });
});
