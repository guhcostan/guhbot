/**
 * @guhbot/host-core — durable runtime and authorization.
 *
 * This package knows nothing about transports, models or UI. It owns the
 * database, the authorization decision, and the lifecycle of runs, approvals
 * and devices. Everything else is injected.
 */
export { Host, HostError } from './host.js';
export type { ChannelKind, HostEvents, HostOptions, RunContext, RunExecutor, Session } from './host.js';
export { Store } from './store.js';
export type { StoreOptions } from './store.js';
export { createSecretBox, hashToken, loadOrCreateMasterKey, verifyToken } from './crypto.js';
export type { SecretBox } from './crypto.js';
export { newId, newPairingCode, newToken, nowIso, safeEqual } from './ids.js';
export type { IdPrefix } from './ids.js';
