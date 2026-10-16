/**
 * @guhbot/companion — the network-facing sidecar.
 *
 * `@guhbot/server` keeps the harness on loopback and refuses a non-loopback
 * `Host`; this package is the only thing in the repository that binds a network
 * interface, and the only place that decides who may connect. It authenticates a
 * device token, rate limits by device and by source address, rewrites `Host`,
 * scrubs the harness's internal topology out of responses, and forwards the
 * WebSocket.
 */
export { CompanionConfigError, createCompanion, isLoopbackAddress } from './companion.js';
export type { Companion, CompanionOptions, CompanionStats } from './companion.js';
export { createHostVerifyToken } from './verify.js';
export type { DeviceIdentity, TokenAuthenticator, VerifyToken } from './verify.js';
export { SlidingWindow } from './limiter.js';
export type { RateLimitDecision, RateLimitOptions } from './limiter.js';
export { REDACTED_PATH, pseudonymizeHostId, scrubServerFrame } from './scrub.js';
export type { ScrubPolicy, ScrubResult } from './scrub.js';
