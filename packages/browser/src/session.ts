import { rm } from 'node:fs/promises';
import { resolveInside } from '@guhbot/agent';
import type {
  ActionResult,
  BrowserEngine,
  BrowserEngineOptions,
  BrowserKind,
  ElementTarget,
  PageSnapshot,
  ReadBudget,
  ScreenshotResult,
} from './engine.js';
import { EgressRefusedError, PlaywrightEngine } from './engine.js';
import { LIMITS } from './limits.js';
import type { BrowserPaths } from './paths.js';
import { browserPaths, resolveScreenshotPath } from './paths.js';
import { navigationRefusal, parseAllowEntry } from './policy.js';
import type { FormatOptions } from './snapshot.js';
import {
  formatActionResult,
  formatScreenshot,
  formatSearchResults,
  formatSnapshot,
  rankSearchResults,
} from './snapshot.js';
import { DeadlineError, withDeadline } from './util.js';

/** Options the host passes when it mounts the capability. */
export interface BrowserCapabilityOptions {
  /**
   * Host data directory. The ephemeral browser profile and every screenshot live
   * under `<dataDir>/browser`.
   */
  dataDir: string;
  /**
   * Hosts navigation may reach, as `example.com`, `.example.com` (that domain and
   * its subdomains), `example.com:8443`, or an IP literal. Empty, which is the
   * default, means the browser cannot leave the blank page: no egress at all.
   */
  allowedHosts?: readonly string[];
  /** Engine backend. Defaults to chromium. */
  browser?: BrowserKind;
  /** Defaults to true. There is no reason to run an unattended agent's browser headed. */
  headless?: boolean;
  /**
   * Search endpoint for `browser_search`, with `{query}` where the term goes,
   * for example `http://localhost:8888/search?q={query}`. There is no default:
   * a hardcoded third-party search API would be a host the operator never
   * approved, so search is simply unavailable until one is configured.
   */
  searchUrlTemplate?: string;
  navigationTimeoutMs?: number;
  callTimeoutMs?: number;
  maxTextBytes?: number;
  maxElements?: number;
  maxSearchResults?: number;
  /** Injection seam: a different browser backend, or a scripted one in tests. */
  engineFactory?: (options: BrowserEngineOptions) => BrowserEngine;
}

export interface ResolvedBrowserOptions {
  readonly dataDir: string;
  readonly paths: BrowserPaths;
  readonly allowedHosts: readonly string[];
  readonly browser: BrowserKind;
  readonly headless: boolean;
  readonly searchUrlTemplate: string | null;
  readonly navigationTimeoutMs: number;
  readonly callTimeoutMs: number;
  readonly maxTextBytes: number;
  readonly maxElements: number;
  readonly maxSearchResults: number;
  readonly engineFactory: (options: BrowserEngineOptions) => BrowserEngine;
}

/** The parts of `ToolExecutionContext` a session call uses. */
export interface SessionCall {
  readonly signal?: AbortSignal;
  readonly note?: (message: string) => void;
}

function positive(value: number | undefined, fallback: number, ceiling: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of milliseconds`);
  return Math.min(Math.floor(value), ceiling);
}

/**
 * Validate at construction, not at first use.
 *
 * A malformed allow list or a search template that points somewhere the allow
 * list forbids are operator mistakes, and the moment to say so is host start,
 * when there is a human watching the logs, rather than the middle of an
 * unattended run.
 */
export function resolveBrowserOptions(options: BrowserCapabilityOptions): ResolvedBrowserOptions {
  const allowedHosts = (options.allowedHosts ?? []).map((entry) => {
    parseAllowEntry(entry);
    return entry.trim();
  });

  const template = options.searchUrlTemplate?.trim();
  if (template !== undefined && template !== '') {
    if (!template.includes('{query}')) {
      throw new Error('searchUrlTemplate must contain {query} where the search term goes');
    }
    const probe = template.split('{query}').join('test');
    const refusal = navigationRefusal(probe, allowedHosts);
    if (refusal !== null) {
      throw new Error(`searchUrlTemplate points at a URL the browser cannot reach: ${refusal}`);
    }
  }

  return {
    dataDir: options.dataDir,
    paths: browserPaths(options.dataDir),
    allowedHosts,
    browser: options.browser ?? 'chromium',
    headless: options.headless ?? true,
    searchUrlTemplate: template === undefined || template === '' ? null : template,
    navigationTimeoutMs: positive(options.navigationTimeoutMs, LIMITS.navigationTimeoutMs, 120_000, 'navigationTimeoutMs'),
    callTimeoutMs: positive(options.callTimeoutMs, LIMITS.callTimeoutMs, 600_000, 'callTimeoutMs'),
    maxTextBytes: positive(options.maxTextBytes, LIMITS.maxTextBytes, LIMITS.maxTextBytesCeiling, 'maxTextBytes'),
    maxElements: positive(options.maxElements, LIMITS.maxElements, LIMITS.maxElementsCeiling, 'maxElements'),
    maxSearchResults: positive(options.maxSearchResults, LIMITS.maxSearchResults, LIMITS.maxSearchResultsCeiling, 'maxSearchResults'),
    engineFactory: options.engineFactory ?? ((engineOptions) => new PlaywrightEngine(engineOptions)),
  };
}

export interface BrowserStatusReport {
  readonly launched: boolean;
  readonly engine: string;
  readonly currentUrl: string | null;
  readonly elementCount: number;
  readonly blockedHosts: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly searchConfigured: boolean;
  readonly disposed: boolean;
}

/**
 * One browser session: the engine, the policy boundary in front of it, and the
 * decisions about what the model is allowed to see.
 *
 * The policy is checked twice on purpose. Before a call, so a disallowed URL
 * never reaches the browser at all; after it, on the URL the browser actually
 * ended up on, because a redirect or a script can move a page somewhere the
 * request was never made to. The request interceptor inside the engine is the
 * third layer, and it is the one that covers subresources.
 */
export class BrowserSession {
  readonly options: ResolvedBrowserOptions;
  private engine: BrowserEngine | null = null;
  private lastSnapshot: PageSnapshot | null = null;
  private disposed = false;

  constructor(options: ResolvedBrowserOptions) {
    this.options = options;
  }

  /**
   * Build the engine on first use.
   *
   * Constructing it loads nothing; `launch()` inside the engine is what imports
   * Playwright and starts a browser, and neither happens for a host whose agent
   * never browses.
   */
  private ensureEngine(): BrowserEngine {
    if (this.disposed) throw new Error('the browser capability has been disposed');
    if (this.engine === null) {
      this.engine = this.options.engineFactory({
        browser: this.options.browser,
        headless: this.options.headless,
        allowedHosts: this.options.allowedHosts,
        profileDir: this.options.paths.profileDir,
        navigationTimeoutMs: this.options.navigationTimeoutMs,
      });
    }
    return this.engine;
  }

  private budget(selector: string | null, override?: number): ReadBudget {
    const ceiling = LIMITS.maxTextBytesCeiling;
    const maxBytes = override === undefined ? this.options.maxTextBytes : Math.min(override, ceiling);
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new Error('maxBytes must be a positive number');
    }
    return { selector, maxBytes: Math.floor(maxBytes), maxElements: this.options.maxElements };
  }

  private formatOptions(maxBytes?: number): FormatOptions {
    return { maxBytes: maxBytes === undefined ? this.options.maxTextBytes : Math.min(maxBytes, LIMITS.maxTextBytesCeiling), maxElements: this.options.maxElements };
  }

  /**
   * The one place a URL is refused.
   *
   * Called before every navigation and again on the URL that came back, so a
   * refusal message is the same sentence whether the model asked for the host or
   * the site redirected to it.
   */
  private assertAllowed(url: string): void {
    const refusal = navigationRefusal(url, this.options.allowedHosts);
    if (refusal !== null) throw new EgressRefusedError(`refused: ${refusal}`);
  }

  private async bound<T>(label: string, call: SessionCall, work: () => Promise<T>): Promise<T> {
    try {
      return await withDeadline(work, {
        timeoutMs: this.options.callTimeoutMs,
        label,
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
    } catch (error) {
      if (error instanceof DeadlineError) {
        // A deadline leaves an operation in flight inside a browser nobody can
        // reason about any more. Discard it; the next call starts a clean one.
        call.note?.(`${label}: discarding the browser session after a deadline`);
        await this.recover();
      }
      throw error;
    }
  }

  private async recover(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    this.lastSnapshot = null;
    if (engine !== null) await engine.close().catch(() => undefined);
  }

  async open(url: string, call: SessionCall = {}): Promise<string> {
    const requested = url.trim();
    if (requested === '') throw new Error('browser_open needs a URL');
    this.assertAllowed(requested);

    const engine = this.ensureEngine();
    const snapshot = await this.bound('browser_open', call, async () => {
      const navigation = await engine.navigate(requested);
      this.assertAllowed(navigation.url);
      return engine.read(this.budget(null));
    });
    this.lastSnapshot = snapshot;
    return formatSnapshot(snapshot, this.formatOptions());
  }

  async read(selector: string | null, maxBytes: number | undefined, call: SessionCall = {}): Promise<string> {
    const engine = this.ensureEngine();
    const snapshot = await this.bound('browser_read', call, async () => {
      const page = await engine.read(this.budget(selector, maxBytes));
      // A page can redirect itself after the load event; the URL that matters is
      // the one the text was extracted from.
      this.assertAllowed(page.url);
      return page;
    });
    this.lastSnapshot = snapshot;
    return formatSnapshot(snapshot, this.formatOptions(maxBytes));
  }

  async screenshot(
    request: { selector: string | null; name: string | undefined; fullPage: boolean },
    call: SessionCall = {},
  ): Promise<string> {
    const engine = this.ensureEngine();
    const current = engine.status().currentUrl;
    if (current !== null) this.assertAllowed(current);

    const path = await resolveScreenshotPath(this.options.paths.screenshotDir, request.name);
    const result: ScreenshotResult = await this.bound('browser_screenshot', call, () =>
      engine.screenshot({ path, selector: request.selector, fullPage: request.fullPage }),
    );
    call.note?.(`browser_screenshot wrote ${result.bytes} bytes to ${path}`);
    return formatScreenshot(path, result.width, result.height, result.bytes);
  }

  async click(
    request: { target: ElementTarget; button: 'left' | 'right' | 'middle' },
    call: SessionCall = {},
  ): Promise<string> {
    const engine = this.ensureEngine();
    const action = await this.bound('browser_click', call, () =>
      engine.click({
        target: request.target,
        button: request.button,
        timeoutMs: this.options.navigationTimeoutMs,
      }),
    );
    this.assertAllowed(action.url);
    return formatActionResult(action.url, action.navigated, this.actionNote(action));
  }

  async type(
    request: { target: ElementTarget; text: string; submit: boolean; clear: boolean },
    call: SessionCall = {},
  ): Promise<string> {
    const engine = this.ensureEngine();
    const action = await this.bound('browser_type', call, () =>
      engine.type({
        target: request.target,
        text: request.text,
        submit: request.submit,
        clear: request.clear,
        timeoutMs: this.options.navigationTimeoutMs,
      }),
    );
    this.assertAllowed(action.url);
    return formatActionResult(action.url, action.navigated, this.actionNote(action));
  }

  async search(query: string, maxResults: number | undefined, call: SessionCall = {}): Promise<string> {
    const term = query.trim();
    if (term === '') throw new Error('browser_search needs a query');
    if (this.options.searchUrlTemplate === null) {
      throw new Error(
        'browser_search is not configured on this host: set searchUrlTemplate to your own search endpoint, for example a self-hosted SearxNG at `http://localhost:8888/search?q={query}`',
      );
    }

    const url = this.options.searchUrlTemplate.split('{query}').join(encodeURIComponent(term));
    this.assertAllowed(url);

    const limit = Math.min(maxResults ?? this.options.maxSearchResults, LIMITS.maxSearchResultsCeiling);
    const engine = this.ensureEngine();
    const links = await this.bound('browser_search', call, async () => {
      const navigation = await engine.navigate(url);
      this.assertAllowed(navigation.url);
      return engine.links(limit * 4);
    });
    const ranked = rankSearchResults(links, url, Math.floor(limit));
    return formatSearchResults(ranked, {
      query: term,
      maxResults: Math.floor(limit),
      maxSnippetBytes: LIMITS.maxSnippetBytes,
    });
  }

  /** Close the browser but keep the capability usable: the next call relaunches. */
  async close(): Promise<string> {
    if (this.engine === null) {
      return 'The browser was already closed; there is no live session.';
    }
    const engine = this.engine;
    this.engine = null;
    this.lastSnapshot = null;
    await engine.close().catch(() => undefined);
    return 'Browser session closed. The next browser tool call starts a new one.';
  }

  status(): BrowserStatusReport {
    const status = this.engine?.status() ?? null;
    return {
      launched: status?.launched ?? false,
      engine: status?.name ?? `${this.options.browser} (not started)`,
      currentUrl: status?.currentUrl ?? null,
      elementCount: status?.elementCount ?? 0,
      blockedHosts: status?.blockedHosts ?? [],
      allowedHosts: this.options.allowedHosts,
      searchConfigured: this.options.searchUrlTemplate !== null,
      disposed: this.disposed,
    };
  }

  /**
   * Release everything, once.
   *
   * The profile directory is the interesting part: it holds the cookies and
   * storage of everywhere the agent browsed. Leaving it behind would turn an
   * ephemeral session into a persistent identity, so it is deleted here — using
   * `resolveInside` so a misconfigured data directory cannot turn this into an
   * `rm -rf` somewhere else.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const engine = this.engine;
    this.engine = null;
    this.lastSnapshot = null;
    if (engine !== null) await engine.close().catch(() => undefined);

    const profile = await resolveInside(this.options.paths.root, this.options.paths.profileDir).catch(() => null);
    if (profile === null) return;
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }

  private actionNote(action: ActionResult): string {
    return action.navigated
      ? `${action.note}; refs from the previous read are stale, so call browser_read before the next click or type`
      : `${action.note}; if the click changed the page in place, call browser_read for fresh refs`;
  }
}
