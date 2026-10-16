import type { ContributedMethod } from '@guhbot/host-core';
import { z } from 'zod';
import type { BrowserSession } from './session.js';

/**
 * The client-facing half of the capability.
 *
 * Deliberately small: a client can see whether a browser is live and can end the
 * session. There is no method that returns page content, cookies or storage —
 * those belong to the run that asked for them, not to every paired device. If a
 * client ever needs to drive browsing directly, that is a new method with its own
 * authorization argument, not a widened `browser.status`.
 */

const BrowserStatusOutput = z.object({
  launched: z.boolean(),
  engine: z.string().max(120),
  currentUrl: z.string().max(4096).nullable(),
  elementCount: z.number().int().min(0),
  blockedHosts: z.array(z.string().max(255)).max(500),
  allowedHosts: z.array(z.string().max(255)).max(500),
  searchConfigured: z.boolean(),
  disposed: z.boolean(),
});

const BrowserCloseInput = z.object({
  /** Recorded in the transcript so a later reader knows why the session ended. */
  reason: z.string().max(200).optional(),
});

const BrowserCloseOutput = z.object({
  closed: z.boolean(),
  detail: z.string().max(500),
  reason: z.string().max(200).nullable(),
});

export function createBrowserMethods(browser: BrowserSession): Record<string, ContributedMethod> {
  return {
    'browser.status': {
      // Observation only: it reports a URL, it does not touch the page.
      authz: 'background',
      input: z.object({}),
      output: BrowserStatusOutput,
      summary: 'Whether a browser session is live, where it is, and which hosts it may reach.',
      handler: async () => browser.status(),
    },
    'browser.close': {
      // Ending the session under a running agent is disruptive, and a device that
      // is merely paired should not be able to do it.
      authz: 'person',
      input: BrowserCloseInput,
      output: BrowserCloseOutput,
      summary: 'Close the live browser session. The next tool call starts a fresh one with no carried-over state.',
      handler: async (_host, _session, input) => {
        const parsed = BrowserCloseInput.parse(input);
        const detail = await browser.close();
        return { closed: true, detail, reason: parsed.reason ?? null };
      },
    },
  };
}
