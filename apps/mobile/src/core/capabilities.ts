/**
 * What this device is allowed to do, decided before a request is sent.
 *
 * A phone pairs over the network, and the host only ever hands a remote device
 * the `background` class: `Host.claimPairing` downgrades a `person` request to
 * `background`, and promoting a device needs local presence on the host. So for
 * this app the interesting answer is almost always "no, and here is why".
 *
 * The host stays the authority (`Host.dispatch` re-checks everything); this
 * module exists so the UI can show a disabled control with a reason instead of
 * a raw `forbidden` error.
 */
import { methods, type AuthzClass, type DeviceClass, type MethodSpec } from '@guhbot/protocol';

export type CapabilityReason = 'permitted' | 'unpaired' | 'device-class' | 'host-only' | 'unknown-method';

export interface CapabilityAllowed {
  readonly allowed: true;
  readonly reason: 'permitted';
  readonly requiredClass: AuthzClass;
}

export interface CapabilityRefused {
  readonly allowed: false;
  readonly reason: Exclude<CapabilityReason, 'permitted'>;
  /** The class the host demands, or null when the method does not exist. */
  readonly requiredClass: AuthzClass | null;
  /** Short label for a disabled control. */
  readonly title: string;
  /** Why it is refused, and where the user has to go instead. */
  readonly detail: string;
}

export type Capability = CapabilityAllowed | CapabilityRefused;

const HOST_MACHINE = 'Do it in guhbot on the machine that runs the host.';

function specFor(method: string): MethodSpec | undefined {
  return (methods as Record<string, MethodSpec | undefined>)[method];
}

export function capabilityFor(deviceClass: DeviceClass | null, method: string): Capability {
  const spec = specFor(method);
  if (spec === undefined) {
    return {
      allowed: false,
      reason: 'unknown-method',
      requiredClass: null,
      title: 'This host does not have it',
      detail: `The host does not implement "${method}". It is probably running an older version of guhbot than this app.`,
    };
  }

  // `localOnly` methods are refused for every network client, whatever class it
  // holds; the phone can never be the machine the host runs on.
  if (spec.localOnly === true) {
    return {
      allowed: false,
      reason: 'host-only',
      requiredClass: spec.authz,
      title: 'Only on the host machine',
      detail: `The host only accepts "${method}" from a client running on the host itself, never over the network. ${HOST_MACHINE}`,
    };
  }

  if (deviceClass === null) {
    return {
      allowed: false,
      reason: 'unpaired',
      requiredClass: spec.authz,
      title: 'Pair with a host first',
      detail: `Nothing may be asked of a host until this phone has paired with it.`,
    };
  }

  if (spec.authz === 'background' || deviceClass === 'person') {
    return { allowed: true, reason: 'permitted', requiredClass: spec.authz };
  }

  return {
    allowed: false,
    reason: 'device-class',
    requiredClass: spec.authz,
    title: 'Needs a person on the host',
    detail:
      `"${method}" changes something on the host, so the host only accepts it from a device with human presence. ` +
      `This phone paired over the network as a background device, and a remote device cannot promote itself. ${HOST_MACHINE}`,
  };
}

export function isPermitted(deviceClass: DeviceClass | null, method: string): boolean {
  return capabilityFor(deviceClass, method).allowed;
}

/** The message for a disabled control, or null when the action is allowed. */
export function refusalDetail(capability: Capability): string | null {
  return capability.allowed ? null : capability.detail;
}

/** Narrows the client's `deviceClass` field, which is a plain string union. */
export function asDeviceClass(value: string | null | undefined): DeviceClass | null {
  return value === 'person' || value === 'background' ? value : null;
}
