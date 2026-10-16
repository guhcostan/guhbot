import { mkdir, writeFile } from 'node:fs/promises';
import type { BrowserContext, Locator, Page, Route } from 'playwright-core';
import type { RawElement, RawLink } from './in-page.js';
import { collectLinksInPage, extractPageInPage } from './in-page.js';
import { decideRequest } from './policy.js';

/**
 * The engine seam.
 *
 * The capability talks to a browser only through `BrowserEngine`. Two
 * implementations exist: `PlaywrightEngine`, which drives a real browser, and
 * `NullEngine`, which refuses everything with an actionable message. Tests use a
 * third, scripted implementation, which is the reason the seam exists at all —
 * the interesting logic (policy, formatting, budgets, refs) is testable without
 * a browser binary, and the parts that are not testable stay thin.
 *
 * Playwright is imported lazily, inside `launch()`. Nothing about this package
 * *requires* the driver to be present: `pnpm add` without `playwright-core`, or a
 * machine where the browser binary was never downloaded, must still start the
 * host and produce a sentence a human can act on. Only `playwright-core` types
 * are referenced statically, and type-only imports disappear at runtime.
 */

export type BrowserKind = 'chromium' | 'firefox' | 'webkit';

export interface BrowserEngineOptions {
  readonly browser: BrowserKind;
  readonly headless: boolean;
  readonly allowedHosts: readonly string[];
  /** Ephemeral Chromium/Firefox/WebKit profile, under the host data directory. */
  readonly profileDir: string;
  readonly navigationTimeoutMs: number;
}

/** How much of the page one call may pull back. */
export interface ReadBudget {
  readonly selector: string | null;
  /** Byte ceiling for the extracted text. */
  readonly maxBytes: number;
  readonly maxElements: number;
}

export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly totalChars: number;
  readonly elements: readonly RawElement[];
  readonly elementsTruncated: boolean;
  readonly blockedHosts: readonly string[];
}

export type ElementTarget =
  | { readonly kind: 'ref'; readonly ref: number }
  | { readonly kind: 'selector'; readonly selector: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'label'; readonly label: string };

export interface ClickRequest {
  readonly target: ElementTarget;
  readonly button: 'left' | 'right' | 'middle';
  readonly timeoutMs: number;
}

export interface TypeRequest {
  readonly target: ElementTarget;
  readonly text: string;
  readonly submit: boolean;
  readonly clear: boolean;
  readonly timeoutMs: number;
}

export interface ScreenshotRequest {
  readonly path: string;
  readonly selector: string | null;
  readonly fullPage: boolean;
}

export interface ScreenshotResult {
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

export interface ActionResult {
  readonly url: string;
  /** True when the main frame changed document as part of this action. */
  readonly navigated: boolean;
  /** Everything the model needs to know that is not in the URL. */
  readonly note: string;
}

export interface EngineStatus {
  readonly name: string;
  readonly launched: boolean;
  readonly currentUrl: string | null;
  readonly elementCount: number;
  readonly blockedHosts: readonly string[];
}

export interface BrowserEngine {
  readonly name: string;
  launch(): Promise<void>;
  isLaunched(): boolean;
  open(url: string, budget: ReadBudget): Promise<PageSnapshot>;
  read(budget: ReadBudget): Promise<PageSnapshot>;
  links(maxLinks: number): Promise<readonly RawLink[]>;
  screenshot(request: ScreenshotRequest): Promise<ScreenshotResult>;
  click(request: ClickRequest): Promise<ActionResult>;
  type(request: TypeRequest): Promise<ActionResult>;
  close(): Promise<void>;
  status(): EngineStatus;
}

/**
 * Raised when the browser cannot be started at all.
 *
 * The message is the product here: it is shown to a model and to a human reading
 * the transcript, and it has to name the command that fixes it.
 */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}

/** Raised when the egress policy refuses a URL or blocks a request mid-flight. */
export class EgressRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressRefusedError';
  }
}

export function installHint(browser: BrowserKind): string {
  return `no browser binary found; run \`npx playwright install ${browser}\` (browsers are never downloaded at install time)`;
}

/**
 * Turn whatever Playwright threw into something a human can act on.
 *
 * Playwright's own messages are close, but they hide the two failure modes that
 * actually happen on a fresh machine behind a stack trace: the driver package is
 * missing, or the driver is present and the browser binary is not.
 */
export function describeEngineFailure(error: unknown, browser: BrowserKind = 'chromium'): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

  if (/Executable doesn't exist|playwright install|Failed to launch|browserType\.launch/i.test(message)) {
    return `${installHint(browser)}. Playwright said: ${firstLine(message)}`;
  }
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /Cannot find (package|module) 'playwright-core'/.test(message)) {
    return 'the playwright-core package is not installed; add it with `pnpm add playwright-core`, then run `npx playwright install chromium`';
  }
  return firstLine(message);
}

function firstLine(message: string): string {
  const line = message.split('\n').find((candidate) => candidate.trim() !== '');
  return (line ?? message).trim().slice(0, 400);
}

/** Width and height straight out of the PNG IHDR chunk; no image library needed. */
export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** What every refusal from an unavailable engine says. */
export const NO_ENGINE_MESSAGE = `the browser is not available: ${installHint('chromium')}`;

/** Refuses every operation. Used by tests and by a host that wants the tools listed but inert. */
export class NullEngine implements BrowserEngine {
  readonly name = 'null';

  async launch(): Promise<void> {
    throw new BrowserUnavailableError(NO_ENGINE_MESSAGE);
  }

  isLaunched(): boolean {
    return false;
  }

  async open(): Promise<PageSnapshot> {
    throw new BrowserUnavailableError(NO_ENGINE_MESSAGE);
  }

  async read(): Promise<PageSnapshot> {
    throw new BrowserUnavailableError(NO_ENGINE_MESSAGE);
  }

  async links(): Promise<readonly RawLink[]> {
    throw new BrowserUnavailableError(NO_ENGINE_MESSAGE);
  }

  async screenshot(): Promise<ScreenshotResult> {
    throw new BrowserUnavailableError(NO_ENGINE_MESSAGE);
  }

  async click(): Promise<ActionResult> {
    throw new BrowserUnavailableError(NO_ENGINE_MESSAGE);
  }

  async type(): Promise<ActionResult> {
    throw new BrowserUnavailableError(NO_ENGINE_MESSAGE);
  }

  async close(): Promise<void> {
    // Closing something that was never opened is not an error.
  }

  status(): EngineStatus {
    return { name: this.name, launched: false, currentUrl: null, elementCount: 0, blockedHosts: [] };
  }
}

/**
 * The real engine.
 *
 * The browser is launched on first use and kept for the life of the capability.
 * The profile directory is ephemeral and lives under the host data directory;
 * cookies, storage and history live there and are never exposed through a tool,
 * an RPC method or a log line — there is deliberately no method that returns any
 * of them.
 */
export class PlaywrightEngine implements BrowserEngine {
  readonly name: string;
  private readonly options: BrowserEngineOptions;
  private launching: Promise<void> | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private snapshot: readonly RawElement[] | null = null;
  private currentUrl: string | null = null;
  /** Main-frame document loads, so an action can tell whether it navigated. */
  private navigations = 0;
  private lastRefusal: { url: string; reason: string } | null = null;
  private readonly blocked = new Map<string, number>();

  constructor(options: BrowserEngineOptions) {
    this.options = options;
    this.name = `playwright:${options.browser}`;
  }

  isLaunched(): boolean {
    return this.page !== null;
  }

  async launch(): Promise<void> {
    if (this.page !== null) return;
    if (this.launching === null) {
      this.launching = this.launchOnce().catch((error: unknown) => {
        this.launching = null;
        throw error;
      });
    }
    await this.launching;
  }

  private async launchOnce(): Promise<void> {
    const playwright = await loadPlaywright();
    await mkdir(this.options.profileDir, { recursive: true, mode: 0o700 });

    const context = await playwright[this.options.browser]
      .launchPersistentContext(this.options.profileDir, {
        headless: this.options.headless,
        // Chromium's sandbox defaults to *off* in Playwright, and the browser that
        // a model drives is the last process that should run unsandboxed. No
        // `args` are passed at all, so nothing can smuggle in `--no-sandbox`.
        chromiumSandbox: true,
        // Downloads are remote writes with a filesystem landing zone. Off unless a
        // future option turns them on deliberately.
        acceptDownloads: false,
        // A service worker outlives the page and can keep talking to origins the
        // allow list was never asked about.
        serviceWorkers: 'block',
        permissions: [],
        bypassCSP: false,
        ignoreHTTPSErrors: false,
        viewport: { width: 1280, height: 800 },
      })
      .catch((error: unknown) => {
        throw new BrowserUnavailableError(describeEngineFailure(error, this.options.browser));
      });

    this.context = context;
    await this.installRequestGuard(context);

    // A popup is a page nobody can read (no refs, no text) and nobody can close
    // from a tool, so it is closed as it appears.
    context.on('page', (opened) => {
      if (opened !== this.page) void opened.close().catch(() => undefined);
    });

    const existing = context.pages();
    this.page = existing[0] ?? (await context.newPage());
    for (const page of existing) {
      if (page !== this.page) await page.close().catch(() => undefined);
    }

    this.page.setDefaultTimeout(this.options.navigationTimeoutMs);
    this.page.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);
    this.page.on('framenavigated', (frame) => {
      if (this.page === null || frame !== this.page.mainFrame()) return;
      this.navigations += 1;
      // Refs describe a document. Once that document is gone they are noise, so
      // the table is dropped rather than silently reinterpreted.
      this.snapshot = null;
    });
    this.currentUrl = this.page.url();
  }

  /**
   * Enforce the allow list on every request the browser issues.
   *
   * This is the hop-level check: a redirect is a *new* request, so a chain that
   * leaves the allow list is stopped at the hop that leaves it, before any byte
   * of the disallowed response is read. The tool layer independently re-checks
   * the final URL, because a policy that is only enforced in one place is one bug
   * away from not being enforced at all.
   */
  private async installRequestGuard(context: BrowserContext): Promise<void> {
    await context.route('**/*', async (route: Route) => {
      const url = route.request().url();
      const decision = decideRequest(url, this.options.allowedHosts);
      if (decision.allowed) {
        await route.continue().catch(() => undefined);
        return;
      }
      this.lastRefusal = { url, reason: decision.reason ?? 'not allowed' };
      const key = decision.host === '' ? url : decision.host;
      this.blocked.set(key, (this.blocked.get(key) ?? 0) + 1);
      await route.abort('blockedbyclient').catch(() => undefined);
    });
  }

  async open(url: string, budget: ReadBudget): Promise<PageSnapshot> {
    await this.launch();
    const page = this.requirePage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.options.navigationTimeoutMs });
    } catch (error) {
      throw this.navigationFailure(url, error);
    }
    return this.capture(budget);
  }

  async read(budget: ReadBudget): Promise<PageSnapshot> {
    await this.launch();
    this.requirePage();
    return this.capture(budget);
  }

  private navigationFailure(url: string, error: unknown): Error {
    const refusal = this.lastRefusal;
    if (refusal !== null) {
      return new EgressRefusedError(
        `navigation to ${url} was blocked by the egress policy: ${refusal.reason} (blocked ${refusal.url})`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/Timeout .* exceeded|timed out/i.test(message)) {
      return new Error(`navigation to ${url} timed out after ${this.options.navigationTimeoutMs}ms`);
    }
    return new Error(`navigation to ${url} failed: ${firstLine(message)}`);
  }

  private async capture(budget: ReadBudget): Promise<PageSnapshot> {
    const result = await page.evaluate(extractPageInPage, {
      selector: budget.selector,
      maxChars: Math.max(budget.maxBytes, 1024),
      maxElements: budget.maxElements,
    });
    if (!result.scopeFound) {
      // A selector that matches nothing is a user error, not an empty page.
      throw new Error(`no element matches the selector ${JSON.stringify(budget.selector)}`);
    }
    this.snapshot = result.elements;
    this.currentUrl = result.url;
    return {
      url: result.url,
      title: result.title,
      text: result.text,
      totalChars: result.totalChars,
      elements: result.elements,
      elementsTruncated: result.elementsTruncated,
      blockedHosts: this.blockedHosts(),
    };
  }

  async links(maxLinks: number): Promise<readonly RawLink[]> {
    await this.launch();
    const page = this.requirePage();
    return page.evaluate(collectLinksInPage, { maxLinks });
  }

  async screenshot(request: ScreenshotRequest): Promise<ScreenshotResult> {
    await this.launch();
    const page = this.requirePage();
    const buffer = request.selector !== null
      ? await this.resolve({ kind: 'selector', selector: request.selector }).screenshot({ type: 'png' })
      : await page.screenshot({ type: 'png', fullPage: request.fullPage });
    await writeFile(request.path, buffer, { mode: 0o600 });
    const dimensions = readPngDimensions(buffer) ?? { width: 0, height: 0 };
    return { bytes: buffer.byteLength, width: dimensions.width, height: dimensions.height };
  }

  async click(request: ClickRequest): Promise<ActionResult> {
    await this.launch();
    const before = this.navigations;
    const locator = this.resolve(request.target);
    await this.runOn(locator, request.target, () => locator.click({ button: request.button, timeout: request.timeoutMs }));
    return this.afterAction(before);
  }

  async type(request: TypeRequest): Promise<ActionResult> {
    await this.launch();
    const before = this.navigations;
    const locator = this.resolve(request.target);
    await this.runOn(locator, request.target, async () => {
      if (request.clear) await locator.fill('', { timeout: request.timeoutMs });
      // Real keystrokes, not a value assignment: autocomplete widgets and
      // framework-controlled inputs ignore `fill` and only react to typing.
      await locator.pressSequentially(request.text, { timeout: request.timeoutMs });
      if (request.submit) await locator.press('Enter', { timeout: request.timeoutMs });
    });
    return this.afterAction(before);
  }

  private async runOn(locator: Locator, target: ElementTarget, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const message = firstLine(error instanceof Error ? error.message : String(error));
      if (/not visible|No element matches|resolved to 0 elements|strict mode violation/i.test(message)) {
        throw new Error(
          target.kind === 'ref'
            ? `ref ${target.ref} no longer identifies a single clickable element (the page changed since the last read); call browser_read again for fresh refs. Playwright said: ${message}`
            : `the target could not be acted on: ${message}`,
        );
      }
      throw new Error(message);
    }
  }

  private async afterAction(before: number): Promise<ActionResult> {
    const page = this.requirePage();
    const after = page.url();
    const navigated = this.navigations !== before;
    this.currentUrl = after;
    return {
      url: after,
      navigated,
      note: navigated ? 'the page navigated; call browser_read for fresh refs' : 'the page did not navigate',
    };
  }

  /**
   * Resolve a model-supplied target to a Playwright locator.
   *
   * Refs resolve against the last snapshot's recorded selector. A ref is a
   * promise about the DOM at read time, and it is deliberately not a promise
   * about the DOM now: a ref that no longer matches exactly one element is an
   * error, never a best-effort click on whatever moved into its place.
   */
  private resolve(target: ElementTarget): Locator {
    const page = this.requirePage();
    switch (target.kind) {
      case 'ref': {
        const entry = this.snapshot?.find((element) => element.ref === target.ref);
        if (entry === undefined) {
          const available = this.snapshot === null ? 'none (no read yet)' : String(this.snapshot.length);
          throw new Error(
            `ref ${target.ref} is not in the current page snapshot (refs available: ${available}); call browser_read for fresh refs`,
          );
        }
        return page.locator(entry.selector).first();
      }
      case 'selector':
        return page.locator(target.selector).first();
      case 'text':
        return page.getByText(target.text, { exact: false }).first();
      case 'label':
        return page.getByLabel(target.label, { exact: false }).first();
    }
  }

  private requirePage(): Page {
    if (this.page === null) {
      throw new Error('the browser session is not open; call browser_open first');
    }
    return this.page;
  }

  private blockedHosts(): readonly string[] {
    return [...this.blocked.keys()].sort();
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.snapshot = null;
    this.currentUrl = null;
    this.launching = null;
    if (context !== null) await context.close().catch(() => undefined);
  }

  status(): EngineStatus {
    return {
      name: this.name,
      launched: this.page !== null,
      currentUrl: this.currentUrl,
      elementCount: this.snapshot?.length ?? 0,
      blockedHosts: this.blockedHosts(),
    };
  }
}

async function loadPlaywright(): Promise<typeof import('playwright-core')> {
  try {
    return await import('playwright-core');
  } catch (error) {
    throw new BrowserUnavailableError(describeEngineFailure(error));
  }
}
