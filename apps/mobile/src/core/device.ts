/**
 * How this phone describes itself to a host, and how the app describes the
 * connection back to the user.
 */
import type { DevicePlatform } from '@guhbot/protocol';
import type { ClientState } from '@guhbot/server';

const PLATFORM_BY_OS: Readonly<Record<string, DevicePlatform>> = {
  ios: 'ios',
  android: 'android',
  web: 'web',
  macos: 'desktop',
  windows: 'desktop',
  linux: 'desktop',
};

export function devicePlatformFor(os: string): DevicePlatform {
  // An unknown OS reports `web`: claiming `desktop` would misdescribe the
  // device in `devices.list` on the host.
  return PLATFORM_BY_OS[os] ?? 'web';
}

export function defaultDeviceName(reported: string | null | undefined, os: string): string {
  const trimmed = (reported ?? '').trim();
  return trimmed.length > 0 ? trimmed : `Phone (${os})`;
}

export type LinkState = 'unpaired' | 'connecting' | 'ready' | 'retrying' | 'unreachable';

export interface ConnectionView {
  readonly state: LinkState;
  readonly label: string;
  readonly hint: string;
  readonly ready: boolean;
  /** True only while the app is waiting on a host it has never reached. */
  readonly busy: boolean;
  readonly tone: 'neutral' | 'good' | 'warn' | 'bad';
}

export interface ConnectionInput {
  readonly clientState: ClientState;
  readonly paired: boolean;
  /** True once the host has accepted this device at least once this session. */
  readonly hasBeenReady: boolean;
  /** Last transport error, already formatted for display. */
  readonly detail: string | null;
}

const NETWORK_HINT = 'Check that guhbot is running on the host machine and that this phone is on the same network.';

export function connectionView(input: ConnectionInput): ConnectionView {
  if (!input.paired) {
    return {
      state: 'unpaired',
      label: 'Not paired',
      hint: 'Pair with a host to get started.',
      ready: false,
      busy: false,
      tone: 'neutral',
    };
  }

  const withDetail = (hint: string): string => (input.detail === null ? hint : `${hint} Last error: ${input.detail}`);

  switch (input.clientState) {
    case 'ready':
      return { state: 'ready', label: 'Connected', hint: 'The host is answering.', ready: true, busy: false, tone: 'good' };
    case 'authenticating':
      return {
        state: 'connecting',
        label: 'Signing in',
        hint: 'The host is checking this device token.',
        ready: false,
        // The device is waiting on the host right now, including the very first
        // sign-in, so this is busy whether or not the host was reached before.
        busy: true,
        tone: 'neutral',
      };
    case 'idle':
    case 'connecting':
      return input.hasBeenReady
        ? {
            state: 'retrying',
            label: 'Reconnecting',
            hint: withDetail('The connection dropped. guhbot is retrying with backoff.'),
            ready: false,
            busy: false,
            tone: 'warn',
          }
        : {
            state: 'connecting',
            label: 'Connecting',
            hint: withDetail('Reaching the host on your network.'),
            ready: false,
            busy: true,
            tone: 'neutral',
          };
    case 'closed':
      return {
        state: 'unreachable',
        label: 'Host unreachable',
        hint: withDetail(NETWORK_HINT),
        ready: false,
        // Never a spinner: the host is not coming back on its own schedule.
        busy: false,
        tone: 'bad',
      };
  }
}
