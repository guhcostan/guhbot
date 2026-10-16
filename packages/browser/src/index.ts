/**
 * @guhbot/browser — the browser automation capability.
 *
 * What an agent gets: a headless browser it can point at hosts an operator
 * explicitly allowed, read as text with numbered refs, click and type in, and
 * screenshot to disk. What it never gets: cookies, storage, page source, raw
 * image bytes, or a way to evaluate JavaScript.
 *
 * The safety-critical pieces are exported so they can be tested and reasoned
 * about on their own — `isNavigationAllowed` in particular is the single
 * function that decides whether the browser may talk to a host at all.
 */
export { createBrowserCapability } from './capability.js';
export { createBrowserTools, asRecord, requireString, optionalString, optionalNumber, optionalBoolean, targetFrom } from './tools.js';
export { createBrowserMethods } from './methods.js';
export { BrowserSession, resolveBrowserOptions } from './session.js';
export type { BrowserCapabilityOptions, BrowserStatusReport, ResolvedBrowserOptions, SessionCall } from './session.js';
export {
  BLANK_PAGE_URL,
  decideRequest,
  hostMatches,
  isDangerousScheme,
  isNavigationAllowed,
  navigationRefusal,
  normalizeAllowList,
  normalizeHostname,
  parseAllowEntry,
} from './policy.js';
export type { AllowEntry, RequestDecision } from './policy.js';
export {
  BrowserUnavailableError,
  EgressRefusedError,
  NO_ENGINE_MESSAGE,
  NullEngine,
  PlaywrightEngine,
  createRequestGuard,
  describeEngineFailure,
  hardenedLaunchOptions,
  installHint,
  readPngDimensions,
} from './engine.js';
export type {
  ActionResult,
  BlockedRequest,
  BrowserEngine,
  BrowserEngineOptions,
  BrowserKind,
  ClickRequest,
  ElementTarget,
  EngineStatus,
  HardenedLaunchOptions,
  NavigationResult,
  PageSnapshot,
  ReadBudget,
  RouteLike,
  ScreenshotRequest,
  ScreenshotResult,
  TypeRequest,
} from './engine.js';
export type { RawElement, RawLink } from './in-page.js';
export {
  boundedText,
  formatActionResult,
  formatScreenshot,
  formatSearchResults,
  formatSnapshot,
  rankSearchResults,
  truncateToBytes,
  truncationMarker,
} from './snapshot.js';
export type { FormatOptions, TruncatedText } from './snapshot.js';
export { browserPaths, resolveScreenshotPath } from './paths.js';
export type { BrowserPaths } from './paths.js';
export { assignRefs } from './refs.js';
export type { RefAssignment } from './refs.js';
export { LIMITS } from './limits.js';
export { DeadlineError, withDeadline } from './util.js';
export type { DeadlineOptions } from './util.js';
