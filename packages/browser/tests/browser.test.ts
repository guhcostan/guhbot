import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertCapability } from '@guhbot/agent';
import { Host } from '@guhbot/host-core';
import type { RawElement, RawLink } from '../src/in-page.js';
import { collectLinksInPage, extractPageInPage } from '../src/in-page.js';
import type {
  ActionResult,
  BrowserEngine,
  EngineStatus,
  NavigationResult,
  PageSnapshot,
  ReadBudget,
  ScreenshotResult,
} from '../src/engine.js';
import {
  BrowserUnavailableError,
  NO_ENGINE_MESSAGE,
  NullEngine,
  PlaywrightEngine,
  createRequestGuard,
  describeEngineFailure,
  hardenedLaunchOptions,
  readPngDimensions,
} from '../src/engine.js';
import type { BlockedRequest, RouteLike } from '../src/engine.js';
import { LIMITS } from '../src/limits.js';
import { assignRefs } from '../src/refs.js';
import { browserPaths, resolveScreenshotPath } from '../src/paths.js';
import {
  decideRequest,
  isDangerousScheme,
  isNavigationAllowed,
  navigationRefusal,
  parseAllowEntry,
} from '../src/policy.js';
import { BrowserSession, createBrowserCapability, createBrowserMethods, resolveBrowserOptions } from '../src/index.js';
import { boundedText, formatSearchResults, formatSnapshot, rankSearchResults, truncateToBytes } from '../src/snapshot.js';
import { withDeadline } from '../src/util.js';

/**
 * What these tests can and cannot prove.
 *
 * No test here starts a browser or opens a socket. Everything that decides what
 * the model may do — the egress policy, the ref scheme, the byte budgets, the
 * path jail, the approval flags, the authorization class of every contributed
 * method — is pure or runs against a scripted engine, and is tested for real.
 * The in-page extractor is exercised against a small fake DOM that implements
 * exactly the selector subset it uses; that is the one place where a fake could
 * drift from the browser, and it is why the browser-facing code is kept small
 * and dumb.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'guhbot-browser-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const ALLOWED = ['example.com', '.docs.example.com'];

function pngFixture(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function element(ref: number, overrides: Partial<RawElement> = {}): RawElement {
  return {
    ref,
    tag: 'a',
    kind: 'link',
    label: `Link ${ref}`,
    selector: `#link-${ref}`,
    href: `https://example.com/${ref}`,
    value: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/',
    title: 'Example',
    text: 'Hello world',
    totalChars: 11,
    elements: [element(1), element(2)],
    elementsTruncated: false,
    blockedHosts: [],
    ...overrides,
  };
}

/**
 * A browser that answers from a script.
 *
 * Every method is a promise the test can hold open (to exercise deadlines) or
 * fail (to exercise error paths), which is how the session's behaviour around
 * timeouts, redirects and refs gets tested without a browser.
 */
class ScriptedEngine implements BrowserEngine {
  readonly name = 'scripted';
  readonly calls: string[] = [];
  launchCount = 0;
  closeCount = 0;
  launched = false;
  finalUrl: string | null = null;
  hang = false;
  failWith: Error | null = null;
  text = 'Hello world';
  totalChars = 11;
  elements: RawElement[] = [element(1), element(2)];
  elementsTruncated = false;
  blockedHosts: string[] = [];
  pageLinks: RawLink[] = [];
  navigated = false;
  screenshotPath: string | null = null;
  screenshotSize = { width: 320, height: 240 };

  async launch(): Promise<void> {
    // Idempotent, like the real engine: `launchCount` counts browser starts, not
    // calls, which is what makes it usable as an assertion.
    if (this.launched) return;
    this.calls.push('launch');
    this.launchCount += 1;
    this.launched = true;
  }

  isLaunched(): boolean {
    return this.launched;
  }

  async navigate(url: string): Promise<NavigationResult> {
    await this.launch();
    this.calls.push(`navigate:${url}`);
    if (this.failWith !== null) throw this.failWith;
    if (this.hang) await new Promise(() => undefined);
    if (this.finalUrl === null) this.finalUrl = url;
    return { url: this.finalUrl, status: 200 };
  }

  async read(budget: ReadBudget): Promise<PageSnapshot> {
    await this.launch();
    this.calls.push(`read:${budget.selector ?? '*'}:${budget.maxBytes}`);
    if (this.hang) await new Promise(() => undefined);
    this.finalUrl ??= 'https://example.com/';
    return snapshot({
      url: this.finalUrl,
      text: this.text,
      totalChars: this.totalChars,
      elements: this.elements,
      elementsTruncated: this.elementsTruncated,
      blockedHosts: this.blockedHosts,
    });
  }

  async links(): Promise<readonly RawLink[]> {
    await this.launch();
    this.calls.push('links');
    return this.pageLinks;
  }

  async screenshot(request: { path: string }): Promise<ScreenshotResult> {
    await this.launch();
    this.calls.push(`screenshot:${request.path}`);
    const png = pngFixture(this.screenshotSize.width, this.screenshotSize.height);
    writeFileSync(request.path, png);
    this.screenshotPath = request.path;
    return { bytes: png.byteLength, width: this.screenshotSize.width, height: this.screenshotSize.height };
  }

  async click(): Promise<ActionResult> {
    await this.launch();
    this.calls.push('click');
    return { url: this.finalUrl ?? 'https://example.com/', navigated: this.navigated, note: 'clicked' };
  }

  async type(): Promise<ActionResult> {
    await this.launch();
    this.calls.push('type');
    return { url: this.finalUrl ?? 'https://example.com/', navigated: this.navigated, note: 'typed' };
  }

  async close(): Promise<void> {
    this.calls.push('close');
    this.closeCount += 1;
    this.launched = false;
  }

  status(): EngineStatus {
    return {
      name: this.name,
      launched: this.launched,
      currentUrl: this.finalUrl,
      elementCount: this.elements.length,
      blockedHosts: this.blockedHosts,
    };
  }
}

function sessionWith(engine: BrowserEngine, options: Parameters<typeof resolveBrowserOptions>[0] = {}) {
  const resolved = resolveBrowserOptions({
    dataDir,
    allowedHosts: ALLOWED,
    engineFactory: () => engine,
    ...options,
  });
  return new BrowserSession(resolved);
}

function toolByName(capability: ReturnType<typeof createBrowserCapability>, name: string) {
  const tool = (capability.tools?.() ?? []).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

const CONTEXT = { signal: new AbortController().signal, note: () => undefined };

// ---------------------------------------------------------------------------
// The egress policy: the single most important unit in this package
// ---------------------------------------------------------------------------

describe('egress policy', () => {
  it('allows an exact allow-listed host over https', () => {
    expect(isNavigationAllowed('https://example.com/path?q=1', ALLOWED)).toBe(true);
  });

  it('allows an allow-listed host over http', () => {
    expect(isNavigationAllowed('http://example.com/', ALLOWED)).toBe(true);
  });

  it('denies a host that is not listed', () => {
    expect(isNavigationAllowed('https://other.example/', ALLOWED)).toBe(false);
    expect(navigationRefusal('https://other.example/', ALLOWED)).toContain('not in the browser allow list');
  });

  it('denies every host when the allow list is empty', () => {
    expect(isNavigationAllowed('https://example.com/', [])).toBe(false);
    expect(isNavigationAllowed('http://localhost:3000/', [])).toBe(false);
    expect(navigationRefusal('https://example.com/', [])).toContain('allowedHosts is empty');
  });

  it('does not let a subdomain inherit an exact entry', () => {
    // Strict by default: `a.example.com` is a different origin from `example.com`,
    // and on shared hosting it is frequently a different tenant.
    expect(isNavigationAllowed('https://a.example.com/', ['example.com'])).toBe(false);
    expect(isNavigationAllowed('https://www.example.com/', ['example.com'])).toBe(false);
  });

  it('lets a leading dot opt into subdomains', () => {
    expect(isNavigationAllowed('https://docs.example.com/', ['.docs.example.com'])).toBe(true);
    expect(isNavigationAllowed('https://docs.example.com/', ['*.docs.example.com'])).toBe(true);
    expect(isNavigationAllowed('https://deep.docs.example.com/', ['.docs.example.com'])).toBe(true);
    expect(isNavigationAllowed('https://docs.example.com/', ['.docs.example.com'])).toBe(true);
  });

  it('does not let a wildcard entry reach the parent domain', () => {
    expect(isNavigationAllowed('https://example.com/', ['.docs.example.com'])).toBe(false);
  });

  it('refuses suffix confusion', () => {
    expect(isNavigationAllowed('https://evil-example.com/', ['.example.com'])).toBe(false);
    expect(isNavigationAllowed('https://example.com.evil.test/', ['.example.com'])).toBe(false);
    expect(isNavigationAllowed('https://notexample.com/', ['example.com'])).toBe(false);
  });

  it.each(['file', 'data', 'javascript', 'blob', 'chrome', 'about'])('refuses the %s: scheme', (scheme) => {
    const url = `${scheme}:${scheme === 'about' ? 'config' : 'payload'}`;
    expect(isNavigationAllowed(url, ALLOWED)).toBe(false);
  });

  it('refuses file and javascript URLs even when the host would be allowed', () => {
    expect(navigationRefusal('file:///etc/passwd', ALLOWED)).toContain('file:');
    expect(navigationRefusal('javascript:alert(1)', ALLOWED)).toContain('javascript:');
    expect(navigationRefusal('data:text/html,<b>x</b>', ALLOWED)).toContain('data:');
  });

  it('treats about:blank as the one non-dangerous about: URL and still refuses to navigate there', () => {
    expect(isDangerousScheme('about:', 'about:blank')).toBe(false);
    expect(isDangerousScheme('about:', 'about:config')).toBe(true);
    expect(isNavigationAllowed('about:blank', ALLOWED)).toBe(false);
  });

  it('refuses a relative or malformed URL', () => {
    expect(isNavigationAllowed('/docs', ALLOWED)).toBe(false);
    expect(isNavigationAllowed('example.com', ALLOWED)).toBe(false);
    expect(isNavigationAllowed('', ALLOWED)).toBe(false);
    expect(navigationRefusal('/docs', ALLOWED)).toContain('not a valid absolute URL');
  });

  it('judges the real host, not the userinfo that precedes it', () => {
    expect(isNavigationAllowed('https://example.com@evil.test/', ALLOWED)).toBe(false);
    expect(isNavigationAllowed('https://evil.test@example.com/', ALLOWED)).toBe(true);
  });

  it('is case-insensitive and tolerates the DNS root dot in the URL', () => {
    expect(isNavigationAllowed('https://EXAMPLE.com/', ALLOWED)).toBe(true);
    expect(isNavigationAllowed('https://example.com./', ALLOWED)).toBe(true);
    expect(isNavigationAllowed('https://example.com/', ['EXAMPLE.COM'])).toBe(true);
  });

  it('matches a punycode host against an internationalised allow entry', () => {
    expect(isNavigationAllowed('https://xn--exmple-cua.com/', ['exämple.com'])).toBe(true);
  });

  it('honours an explicit port and ignores one that is absent', () => {
    expect(isNavigationAllowed('https://example.com:8443/', ['example.com:8443'])).toBe(true);
    expect(isNavigationAllowed('https://example.com/', ['example.com:8443'])).toBe(false);
    expect(isNavigationAllowed('http://example.com:8080/', ['example.com'])).toBe(true);
  });

  it('rejects an allow entry that would allow everything', () => {
    expect(() => parseAllowEntry('*')).toThrow(/matches every host/);
    expect(() => parseAllowEntry('*.')).toThrow(/matches every host/);
  });

  it('rejects malformed allow entries', () => {
    expect(() => parseAllowEntry('')).toThrow(/empty/);
    expect(() => parseAllowEntry('https://example.com/path')).toThrow(/must name a host/);
    expect(() => parseAllowEntry('example.com:notaport')).toThrow(/invalid port/);
    expect(() => parseAllowEntry('[::1')).toThrow(/unterminated/);
  });

  it('accepts common entry shapes', () => {
    expect(parseAllowEntry('example.com')).toMatchObject({ host: 'example.com', port: null, includeSubdomains: false });
    expect(parseAllowEntry('https://example.com')).toMatchObject({ host: 'example.com', includeSubdomains: false });
    expect(parseAllowEntry('.example.com')).toMatchObject({ host: 'example.com', includeSubdomains: true });
    expect(parseAllowEntry('[::1]:8080')).toMatchObject({ host: '[::1]', port: '8080' });
  });

  it('checks a redirect target, not the URL that was requested', () => {
    // The interceptor sees the redirected request as its own request, so this is
    // exactly the decision it makes after `Location: https://evil.test/`.
    const requested = decideRequest('https://example.com/', ALLOWED);
    const redirected = decideRequest('https://evil.test/', ALLOWED);
    expect(requested.allowed).toBe(true);
    expect(redirected.allowed).toBe(false);
    expect(redirected.host).toBe('evil.test');
    expect(redirected.reason).toContain('evil.test');
  });

  it('blocks a non-http scheme that arrives mid-chain', () => {
    expect(decideRequest('file:///etc/hosts', ALLOWED)).toMatchObject({ allowed: false });
    expect(decideRequest('data:text/html,hi', ALLOWED)).toMatchObject({ allowed: false });
  });
});

// ---------------------------------------------------------------------------
// Tool set: shape, approval flags, argument handling
// ---------------------------------------------------------------------------

describe('tool set', () => {
  it('contributes exactly the documented tools', () => {
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED });
    expect((capability.tools?.() ?? []).map((tool) => tool.name).sort()).toEqual([
      'browser_click',
      'browser_close',
      'browser_open',
      'browser_read',
      'browser_screenshot',
      'browser_search',
      'browser_type',
    ]);
  });

  it('states requiresApproval explicitly on every tool', () => {
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED });
    for (const tool of capability.tools?.() ?? []) {
      expect(typeof tool.requiresApproval, tool.name).toBe('boolean');
    }
  });

  it('asks for approval before anything that changes a remote system', () => {
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED });
    const approvals = new Map((capability.tools?.() ?? []).map((tool) => [tool.name, tool.requiresApproval]));
    expect(approvals.get('browser_click')).toBe(true);
    expect(approvals.get('browser_type')).toBe(true);
  });

  it('does not ask for approval to read', () => {
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED });
    const approvals = new Map((capability.tools?.() ?? []).map((tool) => [tool.name, tool.requiresApproval]));
    for (const name of ['browser_open', 'browser_read', 'browser_screenshot', 'browser_search', 'browser_close']) {
      expect(approvals.get(name), name).toBe(false);
    }
  });

  it('publishes a JSON Schema for every tool', () => {
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED });
    for (const tool of capability.tools?.() ?? []) {
      expect(tool.parameters, tool.name).toMatchObject({ type: 'object' });
      expect(tool.description.length, tool.name).toBeGreaterThan(30);
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('passes the capability validator the runtime applies at host start', () => {
    expect(() => assertCapability(createBrowserCapability({ dataDir, allowedHosts: ALLOWED }))).not.toThrow();
  });

  it('advertises the browser flag', () => {
    expect(createBrowserCapability({ dataDir }).flags).toEqual({ browser: true });
  });

  it('requires exactly one addressing mode for a click', async () => {
    const engine = new ScriptedEngine();
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED, engineFactory: () => engine });
    const click = toolByName(capability, 'browser_click');

    await expect(click.execute({}, CONTEXT)).rejects.toThrow(/exactly one way to find the element/);
    await expect(click.execute({ ref: 1, text: 'Sign in' }, CONTEXT)).rejects.toThrow(/exactly one way/);
    await expect(click.execute({ ref: 1 }, CONTEXT)).resolves.toContain('https://example.com/');
    expect(engine.calls).toContain('click');
  });

  it('rejects a ref that is not a positive integer', async () => {
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED, engineFactory: () => new ScriptedEngine() });
    const click = toolByName(capability, 'browser_click');
    await expect(click.execute({ ref: 0 }, CONTEXT)).rejects.toThrow(/ref must be an integer/);
    await expect(click.execute({ ref: 2.5 }, CONTEXT)).rejects.toThrow(/ref must be an integer/);
    await expect(click.execute({ ref: '2' }, CONTEXT)).rejects.toThrow(/ref must be an integer/);
  });

  it('accepts text and selector addressing for a click', async () => {
    const engine = new ScriptedEngine();
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED, engineFactory: () => engine });
    const click = toolByName(capability, 'browser_click');
    await expect(click.execute({ text: 'Sign in' }, CONTEXT)).resolves.toBeTruthy();
    await expect(click.execute({ selector: '#submit' }, CONTEXT)).resolves.toBeTruthy();
  });

  it('validates browser_type arguments', async () => {
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED, engineFactory: () => new ScriptedEngine() });
    const type = toolByName(capability, 'browser_type');
    await expect(type.execute({ ref: 1 }, CONTEXT)).rejects.toThrow(/text must be a non-empty string/);
    await expect(type.execute({ ref: 1, text: 'hi', label: 'Search' }, CONTEXT)).rejects.toThrow(/exactly one way/);
    await expect(type.execute({ label: 'Search', text: 'hi', submit: true }, CONTEXT)).resolves.toBeTruthy();
  });

  it('validates browser_open and browser_read arguments', async () => {
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED, engineFactory: () => new ScriptedEngine() });
    await expect(toolByName(capability, 'browser_open').execute({}, CONTEXT)).rejects.toThrow(/url must be a non-empty string/);
    await expect(toolByName(capability, 'browser_open').execute('https://example.com', CONTEXT)).rejects.toThrow(/expected an object/);
    await expect(
      toolByName(capability, 'browser_read').execute({ maxBytes: LIMITS.maxTextBytesCeiling + 1 }, CONTEXT),
    ).rejects.toThrow(/at most/);
  });

  it('reports a search that has no endpoint configured', async () => {
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED, engineFactory: () => new ScriptedEngine() });
    await expect(toolByName(capability, 'browser_search').execute({ query: 'guhbot' }, CONTEXT)).rejects.toThrow(
      /searchUrlTemplate/,
    );
  });

  it('refuses to construct a search template without a query placeholder', () => {
    expect(() =>
      createBrowserCapability({ dataDir, allowedHosts: ALLOWED, searchUrlTemplate: 'http://localhost:8888/search' }),
    ).toThrow(/\{query\}/);
  });

  it('refuses a search template whose host is not allow-listed', () => {
    expect(() =>
      createBrowserCapability({ dataDir, allowedHosts: ['example.com'], searchUrlTemplate: 'https://searx.test/search?q={query}' }),
    ).toThrow(/cannot reach/);
  });

  it('refuses a malformed allow list at construction time, not at first use', () => {
    expect(() => createBrowserCapability({ dataDir, allowedHosts: ['*'] })).toThrow(/matches every host/);
    expect(() => createBrowserCapability({ dataDir, allowedHosts: ['example.com:port'] })).toThrow(/invalid port/);
  });

  it('never exposes a way to read cookies, storage or the profile', () => {
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED });
    const names = [
      ...(capability.tools?.() ?? []).map((tool) => tool.name),
      ...Object.keys(capability.methods ?? {}),
    ];
    for (const name of names) {
      expect(name).not.toMatch(/cookie|storage|session_?state|profile|credential/i);
    }
    expect(Object.keys(capability.methods ?? {})).toEqual(['browser.status', 'browser.close']);
  });
});

// ---------------------------------------------------------------------------
// Refusals that need no browser: the launcher is missing or the host is refused
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it('turns a missing browser into a message that names the install command', async () => {
    const capability = createBrowserCapability({
      dataDir,
      allowedHosts: ALLOWED,
      engineFactory: () => new NullEngine(),
    });
    await expect(toolByName(capability, 'browser_open').execute({ url: 'https://example.com/' }, CONTEXT)).rejects.toThrow(
      /npx playwright install chromium/,
    );
    await expect(toolByName(capability, 'browser_read').execute({}, CONTEXT)).rejects.toThrow(/npx playwright install/);
  });

  it('maps a missing browser binary to an actionable sentence', () => {
    const error = new Error(
      "browserType.launchPersistentContext: Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium\nPlease run the following command to download new browsers: npx playwright install",
    );
    expect(describeEngineFailure(error)).toContain('npx playwright install chromium');
  });

  it('maps a missing playwright-core package to an actionable sentence', () => {
    const error = new Error("Cannot find package 'playwright-core' imported from /app/engine.js");
    expect(describeEngineFailure(error)).toContain('pnpm add playwright-core');
  });

  it('names firefox when firefox is the configured engine', () => {
    expect(describeEngineFailure(new Error('Executable doesn\'t exist'), 'firefox')).toContain('npx playwright install firefox');
  });

  it('refuses a disallowed URL before it builds an engine', async () => {
    let factoryCalls = 0;
    const capability = createBrowserCapability({
      dataDir,
      allowedHosts: ALLOWED,
      engineFactory: () => {
        factoryCalls += 1;
        return new ScriptedEngine();
      },
    });

    await expect(toolByName(capability, 'browser_open').execute({ url: 'https://evil.test/' }, CONTEXT)).rejects.toThrow(
      /not in the browser allow list/,
    );
    await expect(toolByName(capability, 'browser_open').execute({ url: 'file:///etc/passwd' }, CONTEXT)).rejects.toThrow(
      /refused/,
    );
    // Nothing was launched, and nothing was even constructed.
    expect(factoryCalls).toBe(0);
  });

  it('never navigates anywhere when the allow list is empty', async () => {
    const engine = new ScriptedEngine();
    const session = sessionWith(engine, { allowedHosts: [] });
    await expect(session.open('https://example.com/', CONTEXT)).rejects.toThrow(/allowedHosts is empty/);
    expect(engine.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Redirects: the check that has to happen after the browser moves
// ---------------------------------------------------------------------------

describe('redirect enforcement', () => {
  it('refuses a final URL that left the allow list even though the request was allowed', async () => {
    const engine = new ScriptedEngine();
    // The engine "lands" somewhere else, which is what a redirect looks like from
    // the session's point of view.
    engine.finalUrl = 'https://evil.test/landing';
    const session = sessionWith(engine);

    await expect(session.open('https://example.com/start', CONTEXT)).rejects.toThrow(/evil.test is not in the browser allow list/);
  });

  it('refuses a final URL that switched to a dangerous scheme', async () => {
    const engine = new ScriptedEngine();
    engine.finalUrl = 'file:///etc/passwd';
    const session = sessionWith(engine);
    await expect(session.open('https://example.com/', CONTEXT)).rejects.toThrow(/refused/);
  });

  it('re-checks the URL on a read, because a page can move itself', async () => {
    const engine = new ScriptedEngine();
    const session = sessionWith(engine);
    await session.open('https://example.com/', CONTEXT);
    engine.finalUrl = 'https://tracker.test/pixel';
    await expect(session.read(null, undefined, CONTEXT)).rejects.toThrow(/tracker.test is not in the browser allow list/);
  });

  it('tells the model to open a page instead of refusing about:blank', async () => {
    const engine = new ScriptedEngine();
    engine.finalUrl = 'about:blank';
    const session = sessionWith(engine);

    await expect(session.read(null, undefined, CONTEXT)).rejects.toThrow(/no page open yet; call browser_open/);
    await expect(session.click({ target: { kind: 'ref', ref: 1 }, button: 'left' }, CONTEXT)).rejects.toThrow(
      /no page open yet/,
    );
    // about:blank is still not a legal target for browser_open itself.
    await expect(session.open('about:blank', CONTEXT)).rejects.toThrow(/refused/);
  });

  it('re-checks the URL after a click', async () => {
    const engine = new ScriptedEngine();
    const session = sessionWith(engine);
    await session.open('https://example.com/', CONTEXT);
    engine.finalUrl = 'https://evil.test/after-click';
    await expect(session.click({ target: { kind: 'ref', ref: 1 }, button: 'left' }, CONTEXT)).rejects.toThrow(
      /not in the browser allow list/,
    );
  });

  it('reports blocked subresources so a broken page is explainable', async () => {
    const engine = new ScriptedEngine();
    engine.blockedHosts = ['cdn.other.test'];
    const session = sessionWith(engine);
    const output = await session.open('https://example.com/', CONTEXT);
    expect(output).toContain('cdn.other.test');
    expect(output).toContain('add them to allowedHosts');
  });
});


// ---------------------------------------------------------------------------
// The request interceptor and the launch hardening, as values rather than
// details buried inside a browser start
// ---------------------------------------------------------------------------

class FakeRoute implements RouteLike {
  continued = 0;
  aborted: string[] = [];
  continueFails = false;

  constructor(private readonly url: string) {}

  request(): { url(): string } {
    return { url: () => this.url };
  }

  async continue(): Promise<void> {
    this.continued += 1;
    if (this.continueFails) throw new Error('target closed');
  }

  async abort(errorCode?: string): Promise<void> {
    this.aborted.push(errorCode ?? '');
  }
}

describe('request interceptor', () => {
  it('lets a request to an allowed host through', async () => {
    const blocked: BlockedRequest[] = [];
    const route = new FakeRoute('https://example.com/app.js');
    await createRequestGuard(ALLOWED, (entry) => blocked.push(entry))(route);

    expect(route.continued).toBe(1);
    expect(route.aborted).toEqual([]);
    expect(blocked).toEqual([]);
  });

  it('aborts a request to a host that is not allowed', async () => {
    const blocked: BlockedRequest[] = [];
    const route = new FakeRoute('https://evil.test/tracker.gif');
    await createRequestGuard(ALLOWED, (entry) => blocked.push(entry))(route);

    expect(route.aborted).toEqual(['blockedbyclient']);
    expect(route.continued).toBe(0);
    expect(blocked[0]).toMatchObject({ host: 'evil.test' });
    expect(blocked[0]?.reason).toContain('not in the browser allow list');
  });

  it('aborts the redirect hop that leaves the allow list, after allowing the first hop', async () => {
    const blocked: BlockedRequest[] = [];
    const guard = createRequestGuard(ALLOWED, (entry) => blocked.push(entry));

    const requested = new FakeRoute('https://example.com/start');
    await guard(requested);
    // `Location: https://evil.test/next` is a new request, and this is what the
    // browser's own redirect handling hands back to the interceptor.
    const redirected = new FakeRoute('https://evil.test/next');
    await guard(redirected);

    expect(requested.continued).toBe(1);
    expect(redirected.aborted).toEqual(['blockedbyclient']);
    expect(blocked.map((entry) => entry.host)).toEqual(['evil.test']);
  });

  it('aborts a subresource on a host the operator did not list', async () => {
    // A browser that can be told to load an arbitrary URL is an exfiltration
    // channel, so subresources pass the same gate as documents.
    const route = new FakeRoute('https://cdn.other.test/pixel.png');
    const blocked: BlockedRequest[] = [];
    await createRequestGuard(ALLOWED, (entry) => blocked.push(entry))(route);
    expect(route.aborted).toEqual(['blockedbyclient']);
    expect(blocked[0]?.host).toBe('cdn.other.test');
  });

  it('aborts a dangerous scheme mid-flight', async () => {
    const blocked: BlockedRequest[] = [];
    const guard = createRequestGuard(ALLOWED, (entry) => blocked.push(entry));
    for (const url of ['file:///etc/passwd', 'data:text/html,<b>x</b>', 'javascript:alert(1)']) {
      const route = new FakeRoute(url);
      await guard(route);
      expect(route.aborted, url).toEqual(['blockedbyclient']);
    }
    expect(blocked.map((entry) => entry.host)).toContain('file:///etc/passwd');
  });

  it('does not throw when the browser is already gone', async () => {
    const route = new FakeRoute('https://example.com/app.js');
    route.continueFails = true;
    await expect(createRequestGuard(ALLOWED, () => undefined)(route)).resolves.toBeUndefined();
  });
});

describe('launch hardening', () => {
  it('keeps the Chromium sandbox on and passes no foreign arguments', () => {
    const options = hardenedLaunchOptions({ headless: true });
    expect(options.chromiumSandbox).toBe(true);
    expect(options.headless).toBe(true);
    // Playwright defaults the Chromium sandbox to off; an `args` array is the only
    // way `--no-sandbox` could get in, so there must not be one.
    expect(options).not.toHaveProperty('args');
  });

  it('disables downloads, service workers, permissions and CSP bypasses', () => {
    const options = hardenedLaunchOptions({ headless: false });
    expect(options.acceptDownloads).toBe(false);
    expect(options.serviceWorkers).toBe('block');
    expect(options.permissions).toEqual([]);
    expect(options.bypassCSP).toBe(false);
    expect(options.ignoreHTTPSErrors).toBe(false);
    expect(options.headless).toBe(false);
  });

  it('pins the viewport so a screenshot has predictable dimensions', () => {
    expect(hardenedLaunchOptions({ headless: true }).viewport).toEqual({ width: 1280, height: 800 });
  });
});

// ---------------------------------------------------------------------------
// The ref scheme and the text the model sees
// ---------------------------------------------------------------------------

describe('refs and output', () => {
  it('numbers elements in DOM order and embeds the ref in the output', async () => {
    const engine = new ScriptedEngine();
    const session = sessionWith(engine);
    const output = await session.open('https://example.com/', CONTEXT);
    expect(output).toContain('[1] link "Link 1" -> https://example.com/1');
    expect(output).toContain('[2] link "Link 2"');
  });

  it('marks a truncated element list instead of hiding the cut', () => {
    const many = Array.from({ length: 5 }, (_unused, index) => element(index + 1));
    const output = formatSnapshot(snapshot({ elements: many, elementsTruncated: true }), { maxBytes: 4096, maxElements: 2 });
    expect(output).toContain('[2]');
    expect(output).not.toContain('[3]');
    expect(output).toContain('more elements than the 2 this host reports');
  });

  it('renders a field with its current value', () => {
    const output = formatSnapshot(
      snapshot({ elements: [element(1, { kind: 'field', tag: 'input', label: 'Search', href: null, value: 'cats' })] }),
      { maxBytes: 4096, maxElements: 10 },
    );
    expect(output).toContain('[1] field "Search" = "cats"');
  });

  it('adds an explicit truncation marker to a long page', () => {
    const long = 'x'.repeat(5000);
    const output = formatSnapshot(snapshot({ text: long, totalChars: 9000 }), { maxBytes: 1000, maxElements: 10 });
    expect(output).toContain('[truncated: showing');
    expect(output).toContain('budget 1000 bytes');
  });
});

describe('byte budgets', () => {
  it('returns short text untouched', () => {
    expect(truncateToBytes('hello', 10)).toEqual({ text: 'hello', bytes: 5, truncated: false });
  });

  it('cuts on a character boundary rather than splitting a multi-byte sequence', () => {
    const text = 'áéíóú'; // five two-byte characters
    const cut = truncateToBytes(text, 5);
    expect(cut.truncated).toBe(true);
    expect(cut.bytes).toBeLessThanOrEqual(5);
    expect(cut.text).toBe('áé');
    expect(cut.text).not.toContain('\uFFFD');
  });

  it('never splits a four-byte emoji into a replacement character', () => {
    const cut = truncateToBytes('a😀b', 3);
    expect(cut.text).toBe('a');
    expect(cut.text).not.toContain('\uFFFD');
  });

  it('keeps the total within the budget when it adds the marker', () => {
    const output = boundedText('y'.repeat(400), 100);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(100);
    expect(output).toContain('showing');
  });
});

// ---------------------------------------------------------------------------
// The in-page extractor, against a fake DOM that implements the selector subset
// it uses: tag, tag[attr], [attr="value"] and bare [attr].
// ---------------------------------------------------------------------------

interface FakeSpec {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  value?: string;
  children?: FakeSpec[];
  display?: string;
  visibility?: string;
}

class FakeNode {
  readonly tagName: string;
  readonly attrs: Record<string, string>;
  readonly parentElement: FakeNode | null;
  readonly kids: FakeNode[] = [];
  readonly ownText: string;
  readonly value: string | undefined;
  readonly style: { display: string; visibility: string };

  constructor(spec: FakeSpec, parent: FakeNode | null = null) {
    this.tagName = spec.tag.toUpperCase();
    this.attrs = spec.attrs ?? {};
    this.ownText = spec.text ?? '';
    // `value` is a live property on real form controls; the fake takes it from the
    // spec so a test can model "the user typed into this field".
    this.value = spec.value ?? spec.attrs?.['value'];
    this.parentElement = parent;
    this.style = { display: spec.display ?? 'block', visibility: spec.visibility ?? 'visible' };
    for (const child of spec.children ?? []) this.kids.push(new FakeNode(child, this));
  }

  get children(): FakeNode[] {
    return this.kids;
  }

  get textContent(): string {
    return `${this.ownText}${this.kids.map((kid) => kid.textContent).join('')}`;
  }

  get innerText(): string {
    return this.textContent;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }

  matches(selector: string): boolean {
    return matchesAny(this, selector);
  }

  closest(selector: string): FakeNode | null {
    let node: FakeNode | null = this;
    while (node !== null) {
      if (matchesAny(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector: string): FakeNode | null {
    return this.queryAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.queryAll(selector);
  }

  private queryAll(selector: string): FakeNode[] {
    const found: FakeNode[] = [];
    const visit = (node: FakeNode): void => {
      for (const kid of node.kids) {
        if (matchesAny(kid, selector)) found.push(kid);
        visit(kid);
      }
    };
    visit(this);
    return found;
  }
}

function matchesAny(node: FakeNode, selector: string): boolean {
  return selector.split(',').some((part) => matchesOne(node, part.trim()));
}

function matchesOne(node: FakeNode, part: string): boolean {
  const byId = /^#([\w-]+)$/.exec(part);
  if (byId) return node.getAttribute('id') === byId[1];
  const parsed = /^([a-z0-9]*)(?:\[([a-zA-Z-]+)(?:="([^"]*)")?\])?$/.exec(part);
  if (!parsed) throw new Error(`the fake DOM cannot evaluate the selector ${JSON.stringify(part)}`);
  const [, tag, attr, value] = parsed;
  if (tag !== undefined && tag !== '' && node.tagName.toLowerCase() !== tag) return false;
  if (attr === undefined) return true;
  if (value === undefined) return node.hasAttribute(attr);
  return node.getAttribute(attr) === value;
}

class FakeDocument {
  readonly title = 'Fake page';
  readonly location = { href: 'https://example.com/page' };
  private readonly root: FakeNode;

  constructor(spec: FakeSpec) {
    this.root = new FakeNode(spec);
  }

  querySelector(selector: string): FakeNode | null {
    if (selector === 'html') return this.root;
    return this.root.querySelector(selector);
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.root.querySelectorAll(selector);
  }
}

function installFakeDom(doc: FakeDocument): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousDocument = globals['document'];
  const previousStyle = globals['getComputedStyle'];
  globals['document'] = doc;
  globals['getComputedStyle'] = (node: { style: { display: string; visibility: string } }) => node.style;
  return () => {
    globals['document'] = previousDocument;
    globals['getComputedStyle'] = previousStyle;
  };
}

function pageSpec(): FakeSpec {
  return {
    tag: 'html',
    children: [
      {
        tag: 'body',
        children: [
          { tag: 'h1', text: 'Welcome' },
          { tag: 'a', attrs: { href: '/docs' }, text: 'Docs' },
          { tag: 'button', attrs: { 'aria-label': 'Sign in' }, text: 'ignored' },
          { tag: 'input', attrs: { name: 'q', placeholder: 'Search the site' } },
          { tag: 'div', attrs: { hidden: '' }, children: [{ tag: 'button', text: 'Hidden button' }] },
          { tag: 'div', display: 'none', children: [{ tag: 'a', attrs: { href: '/gone' }, text: 'Invisible link' }] },
          { tag: 'span', text: 'no href here' },
        ],
      },
    ],
  };
}

describe('the in-page extractor', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installFakeDom(new FakeDocument(pageSpec()));
  });

  afterEach(() => {
    restore();
  });

  it('reads the page title, URL and visible text', () => {
    const result = extractPageInPage({ selector: null, maxChars: 1000, maxElements: 10 });
    expect(result.title).toBe('Fake page');
    expect(result.url).toBe('https://example.com/page');
    expect(result.text).toContain('Welcome');
    expect(result.scopeFound).toBe(true);
  });

  it('numbers interactive elements in DOM order and skips hidden ones', () => {
    const result = extractPageInPage({ selector: null, maxChars: 1000, maxElements: 10 });
    expect(result.elements.map((entry) => entry.label)).toEqual(['Docs', 'Sign in', 'Search the site']);
    expect(result.elements.map((entry) => entry.ref)).toEqual([1, 2, 3]);
    expect(result.elements.some((entry) => entry.label === 'Hidden button')).toBe(false);
    expect(result.elements.some((entry) => entry.label === 'Invisible link')).toBe(false);
  });

  it('classifies and absolutises what it finds', () => {
    const result = extractPageInPage({ selector: null, maxChars: 1000, maxElements: 10 });
    expect(result.elements[0]).toMatchObject({ kind: 'link', tag: 'a', href: 'https://example.com/docs' });
    expect(result.elements[1]).toMatchObject({ kind: 'button', label: 'Sign in' });
    expect(result.elements[2]).toMatchObject({ kind: 'field', tag: 'input' });
  });

  it('reports what a field currently holds, not what it started with', () => {
    restore();
    restore = installFakeDom(
      new FakeDocument({
        tag: 'html',
        children: [
          { tag: 'body', children: [{ tag: 'input', attrs: { name: 'q', value: 'initial' }, value: 'typed text' }] },
        ],
      }),
    );
    const result = extractPageInPage({ selector: null, maxChars: 1000, maxElements: 10 });
    expect(result.elements[0]).toMatchObject({ kind: 'field', value: 'typed text' });
  });

  it('does not call hidden markup a truncated list', () => {
    const result = extractPageInPage({ selector: null, maxChars: 1000, maxElements: 10 });
    expect(result.elementsTruncated).toBe(false);
  });

  it('gives every element a selector that identifies it', () => {
    const result = extractPageInPage({ selector: null, maxChars: 1000, maxElements: 10 });
    expect(result.elements[0]?.selector).toMatch(/body > a/);
    expect(result.elements[2]?.selector).toContain('input');
  });

  it('bounds the element list and says that it did', () => {
    const result = extractPageInPage({ selector: null, maxChars: 1000, maxElements: 2 });
    expect(result.elements).toHaveLength(2);
    expect(result.elementsTruncated).toBe(true);
  });

  it('bounds the text in the page rather than shipping it to Node first', () => {
    const result = extractPageInPage({ selector: null, maxChars: 5, maxElements: 10 });
    expect(result.text).toHaveLength(5);
    expect(result.totalChars).toBeGreaterThan(5);
  });

  it('reports a selector that matches nothing', () => {
    const result = extractPageInPage({ selector: '#nope', maxChars: 1000, maxElements: 10 });
    expect(result.scopeFound).toBe(false);
    expect(result.text).toBe('');
  });

  it('scopes the read to one selector', () => {
    const result = extractPageInPage({ selector: 'h1', maxChars: 1000, maxElements: 10 });
    expect(result.text).toContain('Welcome');
    expect(result.text).not.toContain('Docs');
    expect(result.elements).toEqual([]);
  });

  it('collects result links and drops navigation chrome', () => {
    restore();
    restore = installFakeDom(
      new FakeDocument({
        tag: 'html',
        children: [
          {
            tag: 'body',
            children: [
              { tag: 'nav', children: [{ tag: 'a', attrs: { href: '/settings' }, text: 'Settings' }] },
              {
                tag: 'article',
                children: [
                  {
                    tag: 'h3',
                    children: [{ tag: 'a', attrs: { href: 'https://one.test/a' }, text: 'First result' }],
                  },
                  { tag: 'p', text: 'A snippet about the first result.' },
                ],
              },
              { tag: 'a', attrs: { href: 'https://one.test/a' }, text: 'First result again' },
              { tag: 'a', attrs: { href: 'javascript:alert(1)' }, text: 'Bad scheme' },
            ],
          },
        ],
      }),
    );

    const links = collectLinksInPage({ maxLinks: 10 });
    expect(links.map((link) => link.href)).toEqual(['https://one.test/a']);
    expect(links[0]?.title).toBe('First result');
    expect(links[0]?.snippet).toContain('snippet');
  });

  it('ranks search results, dropping the search host and duplicates', () => {
    const links: RawLink[] = [
      { href: 'https://searx.test/preferences', title: 'Preferences', snippet: '' },
      { href: 'https://one.test/a', title: 'One', snippet: 'first' },
      { href: 'https://one.test/a#frag', title: 'One again', snippet: '' },
      { href: 'https://two.test/b', title: 'Two', snippet: 'second' },
    ];
    const ranked = rankSearchResults(links, 'https://searx.test/search?q=x', 5);
    expect(ranked.map((link) => link.href)).toEqual(['https://one.test/a', 'https://two.test/b']);
  });

  it('caps the number of ranked results', () => {
    const links: RawLink[] = Array.from({ length: 10 }, (_unused, index) => ({
      href: `https://one.test/${index}`,
      title: `Result ${index}`,
      snippet: '',
    }));
    expect(rankSearchResults(links, 'https://searx.test/search?q=x', 3)).toHaveLength(3);
  });

  it('renders search results as title, URL and snippet', () => {
    const output = formatSearchResults([{ href: 'https://one.test/a', title: 'One', snippet: 'A snippet' }], {
      query: 'guhbot',
      maxResults: 5,
      maxSnippetBytes: 100,
    });
    expect(output).toContain('Results for "guhbot" (1):');
    expect(output).toContain('1. One');
    expect(output).toContain('https://one.test/a');
    expect(output).toContain('A snippet');
  });

  it('says so when a search parsed nothing', () => {
    const output = formatSearchResults([], { query: 'nothing', maxResults: 5, maxSnippetBytes: 100 });
    expect(output).toContain('No results parsed');
    expect(output).toContain('searchUrlTemplate');
  });
});

describe('ref assignment', () => {
  it('keeps the number an element already had, and refreshes its label', () => {
    const assignment = assignRefs([element(1), element(2)], [element(1, { label: 'Fresh label' })], 10);
    expect(assignment.shown).toEqual([expect.objectContaining({ ref: 1, label: 'Fresh label' })]);
    expect(assignment.table.map((entry) => entry.ref)).toEqual([1, 2]);
  });

  it('gives an element the scope reveals for the first time the next number', () => {
    const assignment = assignRefs([element(1), element(2)], [element(9, { selector: '#revealed' })], 10);
    expect(assignment.shown[0]?.ref).toBe(3);
    expect(assignment.table.map((entry) => entry.ref)).toEqual([1, 2, 3]);
  });

  it('stops minting numbers once the table is at its ceiling', () => {
    const assignment = assignRefs([element(1)], [element(2, { selector: '#new' })], 1);
    expect(assignment.shown).toEqual([]);
    expect(assignment.table.map((entry) => entry.ref)).toEqual([1]);
  });

  it('still shows an element the table already knows when the ceiling is reached', () => {
    const assignment = assignRefs([element(1)], [element(1)], 1);
    expect(assignment.shown.map((entry) => entry.ref)).toEqual([1]);
  });

  it('reports a blocked request as host:port so a port-only difference is visible', () => {
    const decision = decideRequest('http://127.0.0.1:61035/pixel.png', ['127.0.0.1:9']);
    expect(decision.allowed).toBe(false);
    expect(decision.host).toBe('127.0.0.1:61035');
  });
});

// ---------------------------------------------------------------------------
// Screenshots: the path jail and the PNG header
// ---------------------------------------------------------------------------

describe('screenshot paths', () => {
  it('keeps a plain name inside the directory', async () => {
    const dir = browserPaths(dataDir).screenshotDir;
    const path = await resolveScreenshotPath(dir, 'result.png');
    expect(path).toBe(join(dir, 'result.png'));
    expect(path.startsWith(resolve(dir) + sep)).toBe(true);
  });

  it('refuses a traversal out of the directory', async () => {
    const dir = browserPaths(dataDir).screenshotDir;
    await expect(resolveScreenshotPath(dir, '../../etc/passwd.png')).rejects.toThrow(/escapes the working directory/);
    await expect(resolveScreenshotPath(dir, 'nested/../../outside.png')).rejects.toThrow(/escapes/);
  });

  it('refuses an absolute path outside the directory', async () => {
    const dir = browserPaths(dataDir).screenshotDir;
    await expect(resolveScreenshotPath(dir, '/tmp/elsewhere.png')).rejects.toThrow(/escapes/);
  });

  it('refuses a name that is not a PNG', async () => {
    const dir = browserPaths(dataDir).screenshotDir;
    await expect(resolveScreenshotPath(dir, 'payload.sh')).rejects.toThrow(/must end in .png/);
    await expect(resolveScreenshotPath(dir, 'result.png.sh')).rejects.toThrow(/must end in .png/);
  });

  it('refuses a directory', async () => {
    const dir = browserPaths(dataDir).screenshotDir;
    await expect(resolveScreenshotPath(dir, 'shots/')).rejects.toThrow(/must end in .png/);
  });

  it('generates a unique name when none is given', async () => {
    const dir = browserPaths(dataDir).screenshotDir;
    const first = await resolveScreenshotPath(dir, undefined);
    const second = await resolveScreenshotPath(dir, undefined);
    expect(first).not.toBe(second);
    expect(first.endsWith('.png')).toBe(true);
  });

  it('reads the dimensions out of a PNG header', () => {
    expect(readPngDimensions(pngFixture(320, 240))).toEqual({ width: 320, height: 240 });
  });

  it('refuses bytes that are not a PNG', () => {
    expect(readPngDimensions(Buffer.from('GIF89a....................'))).toBeNull();
    expect(readPngDimensions(Buffer.alloc(4))).toBeNull();
  });

  it('writes a screenshot inside the configured directory and returns path and size', async () => {
    const engine = new ScriptedEngine();
    const session = sessionWith(engine);
    await session.open('https://example.com/', CONTEXT);

    const output = await session.screenshot({ selector: null, name: 'page.png', fullPage: false }, CONTEXT);
    const expected = join(browserPaths(dataDir).screenshotDir, 'page.png');
    expect(output).toContain(expected);
    expect(output).toContain('320x240');
    expect(output).not.toMatch(/base64/);
    expect(statSync(expected).size).toBe(24);

    await expect(session.screenshot({ selector: null, name: '../escape.png', fullPage: false }, CONTEXT)).rejects.toThrow(
      /escapes/,
    );
  });

  it('creates the screenshot directory under the host data directory', async () => {
    const engine = new ScriptedEngine();
    const session = sessionWith(engine);
    await session.open('https://example.com/', CONTEXT);
    await session.screenshot({ selector: null, name: undefined, fullPage: true }, CONTEXT);

    const dir = browserPaths(dataDir).screenshotDir;
    expect(dir.startsWith(resolve(dataDir) + sep)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(engine.screenshotPath?.startsWith(dir + sep)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: lazy launch, close, dispose, deadlines
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('does not build an engine until a tool needs one', async () => {
    let factoryCalls = 0;
    const capability = createBrowserCapability({
      dataDir,
      allowedHosts: ALLOWED,
      engineFactory: () => {
        factoryCalls += 1;
        return new ScriptedEngine();
      },
    });

    capability.tools?.();
    expect(factoryCalls).toBe(0);
    await expect(toolByName(capability, 'browser_read').execute({}, CONTEXT)).resolves.toBeTruthy();
    expect(factoryCalls).toBe(1);
  });

  it('reports a status without starting a browser', () => {
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED, searchUrlTemplate: undefined, engineFactory: () => new ScriptedEngine() });
    const methods = capability.methods ?? {};
    const status = methods['browser.status'];
    expect(status?.authz).toBe('background');
    void status?.handler({}, {}, {}).then((report) => {
      expect(report).toMatchObject({ launched: false, searchConfigured: false });
    });
  });

  it('closes the session idempotently and can relaunch afterwards', async () => {
    const engine = new ScriptedEngine();
    const session = sessionWith(engine);
    await session.open('https://example.com/', CONTEXT);
    expect(engine.launchCount).toBe(1);

    await expect(session.close()).resolves.toContain('closed');
    expect(engine.closeCount).toBe(1);
    await expect(session.close()).resolves.toContain('already closed');
    expect(engine.closeCount).toBe(1);

    await session.open('https://example.com/', CONTEXT);
    expect(engine.launchCount).toBe(2);
  });

  it('disposes idempotently when nothing was ever launched', async () => {
    const engine = new ScriptedEngine();
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED, engineFactory: () => engine });
    await expect(capability.dispose?.()).resolves.toBeUndefined();
    await expect(capability.dispose?.()).resolves.toBeUndefined();
    expect(engine.closeCount).toBe(0);
    expect(() => mkdirSync(browserPaths(dataDir).profileDir, { recursive: true })).not.toThrow();
  });

  it('disposes twice without throwing after a session was used', async () => {
    const engine = new ScriptedEngine();
    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED, engineFactory: () => engine });
    await toolByName(capability, 'browser_open').execute({ url: 'https://example.com/' }, CONTEXT);

    await capability.dispose?.();
    await capability.dispose?.();
    expect(engine.closeCount).toBe(1);
    await expect(toolByName(capability, 'browser_open').execute({ url: 'https://example.com/' }, CONTEXT)).rejects.toThrow(
      /disposed/,
    );
  });

  it('removes the ephemeral profile directory but keeps the screenshots', async () => {
    const paths = browserPaths(dataDir);
    mkdirSync(paths.profileDir, { recursive: true });
    mkdirSync(paths.screenshotDir, { recursive: true });
    writeFileSync(join(paths.screenshotDir, 'keep.png'), pngFixture(10, 10));

    const capability = createBrowserCapability({ dataDir, allowedHosts: ALLOWED, engineFactory: () => new ScriptedEngine() });
    await capability.dispose?.();

    expect(() => statSync(paths.profileDir)).toThrow();
    expect(statSync(join(paths.screenshotDir, 'keep.png')).isFile()).toBe(true);
  });

  it('bounds one call and discards the browser when the budget runs out', async () => {
    const engine = new ScriptedEngine();
    engine.hang = true;
    const session = sessionWith(engine, { callTimeoutMs: 40 });

    await expect(session.open('https://example.com/', CONTEXT)).rejects.toThrow(/exceeded its 40ms budget/);
    // A browser with an operation still in flight is not reused.
    expect(engine.closeCount).toBe(1);
  });

  it('stops waiting when the run is cancelled', async () => {
    const engine = new ScriptedEngine();
    engine.hang = true;
    const session = sessionWith(engine, { callTimeoutMs: 5000 });
    const controller = new AbortController();
    const call = { signal: controller.signal, note: () => undefined };

    const pending = session.open('https://example.com/', call);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it('refuses immediately when the run was already cancelled', async () => {
    const engine = new ScriptedEngine();
    const session = sessionWith(engine);
    const controller = new AbortController();
    controller.abort();
    await expect(session.open('https://example.com/', { signal: controller.signal })).rejects.toThrow(/cancelled before it started/);
    expect(engine.calls.filter((call) => call.startsWith('navigate'))).toEqual([]);
  });

  it('times out a promise that never settles', async () => {
    await expect(withDeadline(() => new Promise(() => undefined), { timeoutMs: 20, label: 'test' })).rejects.toThrow(
      /test exceeded its 20ms budget/,
    );
  });

  it('creates the profile directory under the data directory', () => {
    const paths = browserPaths(dataDir);
    expect(paths.root).toBe(resolve(dataDir, 'browser'));
    expect(paths.profileDir).toBe(join(paths.root, 'profile'));
    expect(paths.screenshotDir).toBe(join(paths.root, 'screenshots'));
  });

  it('exposes an engine that has not launched as a plain status', () => {
    const engine = new PlaywrightEngine({
      browser: 'firefox',
      headless: true,
      allowedHosts: ALLOWED,
      profileDir: browserPaths(dataDir).profileDir,
      navigationTimeoutMs: 1000,
    });
    expect(engine.isLaunched()).toBe(false);
    expect(engine.status()).toMatchObject({ name: 'playwright:firefox', launched: false, currentUrl: null });
  });

  it('hands the configured browser to the engine factory', async () => {
    let seen: { browser?: string; profileDir?: string; allowedHosts?: readonly string[] } | null = null;
    const session = sessionWith(new ScriptedEngine(), {
      browser: 'webkit',
      engineFactory: (options) => {
        seen = options;
        return new ScriptedEngine();
      },
    });
    expect(seen).toBeNull();
    await session.read(null, undefined, CONTEXT);
    expect(seen).toMatchObject({
      browser: 'webkit',
      profileDir: browserPaths(dataDir).profileDir,
      allowedHosts: ALLOWED,
    });
  });

  it('describes an unavailable engine in one sentence', () => {
    expect(NO_ENGINE_MESSAGE).toContain('npx playwright install chromium');
    expect(new NullEngine().status()).toMatchObject({ launched: false });
  });
});

// ---------------------------------------------------------------------------
// Contributed RPC methods, through the real host dispatch
// ---------------------------------------------------------------------------

describe('contributed methods', () => {
  it('declares an honest authorization class for each method', () => {
    const methods = createBrowserMethods(sessionWith(new ScriptedEngine()));
    expect(methods['browser.status']?.authz).toBe('background');
    expect(methods['browser.close']?.authz).toBe('person');
    for (const [name, spec] of Object.entries(methods)) {
      expect(name.startsWith('browser.'), name).toBe(true);
      expect(spec.summary.length, name).toBeGreaterThan(10);
    }
  });

  it('validates the params and the result of every method against its own schema', async () => {
    const methods = createBrowserMethods(sessionWith(new ScriptedEngine()));
    const status = methods['browser.status'];
    expect(status?.input.safeParse({}).success).toBe(true);
    const report = await status?.handler({} as never, {} as never, {} as never);
    expect(status?.output.safeParse(report).success).toBe(true);

    const close = methods['browser.close'];
    expect(close?.input.safeParse({ reason: 'done' }).success).toBe(true);
    expect(close?.input.safeParse({ reason: 'x'.repeat(500) }).success).toBe(false);
    const closed = await close?.handler({} as never, {} as never, { reason: 'done' } as never);
    expect(close?.output.safeParse(closed).success).toBe(true);
    expect(closed).toMatchObject({ closed: true, reason: 'done' });
  });

  it('lets a background device observe the session but not end it', async () => {
    const host = new Host({
      dataDir,
      version: '0.0.0-test',
      mode: 'self-hosted',
      capabilities: { browser: true },
      extraMethods: createBrowserMethods(sessionWith(new ScriptedEngine())),
    });

    const remote = host.createSession('network');
    await expect(host.dispatch(remote, 'browser.status', {})).resolves.toMatchObject({ launched: false });
    await expect(host.dispatch(remote, 'browser.close', {})).rejects.toMatchObject({ code: 'forbidden' });

    const local = host.createSession('local');
    await expect(host.dispatch(local, 'browser.close', {})).resolves.toMatchObject({ closed: true });

    await host.close();
  });
});
