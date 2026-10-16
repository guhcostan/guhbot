/**
 * @guhbot/server — transport for the host.
 *
 * Exposes the runtime over a WebSocket that any client can speak: the Electron
 * desktop app over loopback, a phone over the LAN, and a hosted deployment
 * behind a gateway. `HostServer` is the only thing in the repository that binds
 * a socket, so the blast radius of a transport bug is this package and nothing else.
 */
export { HostServer, localAddresses } from './server.js';
export type { HostServerOptions, PairingInfo } from './server.js';
export { GuhbotClient } from './client.js';
export type { ClientState, GuhbotClientOptions } from './client.js';
