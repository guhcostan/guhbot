import type { Capability } from '@guhbot/agent';
import { createBrowserMethods } from './methods.js';
import type { BrowserCapabilityOptions } from './session.js';
import { BrowserSession, resolveBrowserOptions } from './session.js';
import { createBrowserTools } from './tools.js';

/**
 * The browser capability.
 *
 * The order of operations here is the safety story: options are validated before
 * anything is constructed (a bad allow list fails the host start, loudly), the
 * engine is not built until a tool actually needs it, and the browser itself is
 * not launched until then either. A host that mounts this capability and never
 * browses loads no driver and starts no process.
 */
export function createBrowserCapability(options: BrowserCapabilityOptions): Capability {
  const resolved = resolveBrowserOptions(options);
  const browser = new BrowserSession(resolved);

  return {
    name: 'browser',
    summary: 'Drives a hardened, allow-listed headless browser: read a page, click, type, screenshot.',
    flags: { browser: true },
    tools: () => createBrowserTools(browser),
    methods: createBrowserMethods(browser),
    dispose: () => browser.dispose(),
  };
}
