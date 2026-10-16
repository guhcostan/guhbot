/**
 * @guhbot/protocol — the contract shared by host, desktop, mobile and cloud.
 *
 * Layering rule for the whole repository: this package depends on nothing but
 * `zod`. Every other package may depend on it. It must never import from a
 * package that talks to a network, a filesystem, or a model — otherwise the
 * mobile client drags the host runtime into its bundle.
 */
export * from './entities.js';
export * from './envelope.js';
export * from './events.js';
export * from './methods.js';
