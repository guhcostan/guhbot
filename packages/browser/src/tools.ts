import type { ToolDefinition, ToolExecutionContext } from '@guhbot/agent';
import type { ElementTarget } from './engine.js';
import { LIMITS } from './limits.js';
import type { BrowserSession, SessionCall } from './session.js';

/**
 * Argument narrowing.
 *
 * Tool arguments arrive as `unknown` from the model. Every field is checked here,
 * once, so no tool body has to reason about what it might have been handed.
 */
export function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error(`expected an object of arguments, got ${Array.isArray(args) ? 'an array' : typeof args}`);
  }
  return args as Record<string, unknown>;
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

export function optionalNumber(args: Record<string, unknown>, key: string, max: number): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  if (value > max) throw new Error(`${key} must be at most ${max}`);
  return value;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
  return value;
}

/**
 * Exactly one addressing mode per action.
 *
 * Being lenient here would be actively harmful: `{ref: 3, text: "Delete"}` has no
 * defensible meaning, and picking one for the model is how an agent clicks the
 * account-deletion button it did not mean to click.
 */
export function targetFrom(args: Record<string, unknown>, keys: readonly ('ref' | 'text' | 'selector' | 'label')[]): ElementTarget {
  const present = keys.filter((key) => args[key] !== undefined && args[key] !== null);
  if (present.length !== 1) {
    throw new Error(
      `give exactly one way to find the element (${keys.join(', ')}); got ${present.length === 0 ? 'none' : present.join(', ')}`,
    );
  }
  const key = present[0];
  switch (key) {
    case 'ref': {
      const value = args['ref'];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error('ref must be an integer from the last browser_read, e.g. 3 for [3]');
      }
      return { kind: 'ref', ref: value };
    }
    case 'text':
      return { kind: 'text', text: requireString(args, 'text') };
    case 'label':
      return { kind: 'label', label: requireString(args, 'label') };
    case 'selector':
      return { kind: 'selector', selector: requireString(args, 'selector') };
    default:
      throw new Error(`unsupported addressing mode ${String(key)}`);
  }
}

function callOf(context: ToolExecutionContext): SessionCall {
  return { signal: context.signal, note: context.note };
}

const NO_TARGET_NOTE =
  'Refs come from the last browser_read or browser_open and expire when the page changes. Address by text or selector when you have no ref.';

/**
 * The model-facing tool set.
 *
 * Two of these mutate a remote system, and those two ask for a human first:
 * clicking is how an agent submits a form, sends a message or spends money, and
 * typing is how it writes the words. Opening, reading, searching and
 * screenshotting are reads — they still leave the host, but they cannot change
 * anything, and blocking them would make an unattended run useless.
 *
 * There is deliberately no tool that returns cookies, storage or a page's HTML
 * source: the first two are credentials, and the third is what the ref scheme
 * exists to avoid needing. There is also no tool that evaluates JavaScript.
 */
export function createBrowserTools(browser: BrowserSession): ToolDefinition[] {
  return [
    {
      name: 'browser_open',
      description:
        'Open an http(s) URL in the browser and return the page title, its interactive elements with refs, and its visible text. Only hosts this host allows can be opened; a refusal names them.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute http(s) URL to open.' } },
        required: ['url'],
        additionalProperties: false,
      },
      requiresApproval: false,
      execute: async (args, context) => browser.open(requireString(asRecord(args), 'url'), callOf(context)),
    },
    {
      name: 'browser_read',
      description:
        'Return the visible text of the page the browser is on, or of one CSS selector, plus the interactive elements with their refs. Long pages are truncated with an explicit marker.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector to read instead of the whole page.' },
          maxBytes: { type: 'integer', description: 'Optional byte budget for the text. Larger is capped by the host.' },
        },
        additionalProperties: false,
      },
      requiresApproval: false,
      execute: async (args, context) => {
        const record = asRecord(args);
        return browser.read(
          optionalString(record, 'selector') ?? null,
          optionalNumber(record, 'maxBytes', LIMITS.maxTextBytesCeiling),
          callOf(context),
        );
      },
    },
    {
      name: 'browser_screenshot',
      description:
        'Save a PNG of the viewport (or of one element, with a selector) under the host data directory. Returns the file path and its dimensions; the image is never returned inline.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector: screenshot just that element.' },
          name: { type: 'string', description: 'Optional file name ending in .png. It cannot escape the screenshots directory.' },
          fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport.' },
        },
        additionalProperties: false,
      },
      requiresApproval: false,
      execute: async (args, context) => {
        const record = asRecord(args);
        return browser.screenshot(
          {
            selector: optionalString(record, 'selector') ?? null,
            name: optionalString(record, 'name'),
            fullPage: optionalBoolean(record, 'fullPage') ?? false,
          },
          callOf(context),
        );
      },
    },
    {
      name: 'browser_click',
      description: `Click an element, addressed by ref from the last read, by its visible text, or by CSS selector. ${NO_TARGET_NOTE} The click may submit a form, send a message or spend money, so a human approves it.`,
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: 'Ref from the last read, e.g. 3 for [3].' },
          text: { type: 'string', description: 'Visible text of the element to click.' },
          selector: { type: 'string', description: 'CSS selector for the element to click.' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Defaults to left.' },
        },
        additionalProperties: false,
      },
      requiresApproval: true,
      execute: async (args, context) => {
        const record = asRecord(args);
        const button = optionalString(record, 'button') ?? 'left';
        if (button !== 'left' && button !== 'right' && button !== 'middle') {
          throw new Error('button must be left, right or middle');
        }
        return browser.click({ target: targetFrom(record, ['ref', 'text', 'selector']), button }, callOf(context));
      },
    },
    {
      name: 'browser_type',
      description: `Type text into a field, addressed by ref from the last read, by its label, or by CSS selector. ${NO_TARGET_NOTE} Typing can send what you write, so a human approves it.`,
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: 'Ref from the last read, e.g. 4 for [4].' },
          label: { type: 'string', description: 'Accessible label or placeholder of the field.' },
          selector: { type: 'string', description: 'CSS selector for the field.' },
          text: { type: 'string', description: 'Text to type.' },
          clear: { type: 'boolean', description: 'Clear the field first. Defaults to false.' },
          submit: { type: 'boolean', description: 'Press Enter after typing. Defaults to false.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      requiresApproval: true,
      execute: async (args, context) => {
        const record = asRecord(args);
        return browser.type(
          {
            target: targetFrom(record, ['ref', 'label', 'selector']),
            text: requireString(record, 'text'),
            submit: optionalBoolean(record, 'submit') ?? false,
            clear: optionalBoolean(record, 'clear') ?? false,
          },
          callOf(context),
        );
      },
    },
    {
      name: 'browser_search',
      description:
        'Search the web through the search endpoint this host configured, and return title, URL and snippet for each result. Follow up with browser_open on a result you want to read.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms.' },
          maxResults: { type: 'integer', description: 'Optional cap on returned results.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      requiresApproval: false,
      execute: async (args, context) => {
        const record = asRecord(args);
        return browser.search(
          requireString(record, 'query'),
          optionalNumber(record, 'maxResults', LIMITS.maxSearchResultsCeiling),
          callOf(context),
        );
      },
    },
    {
      name: 'browser_close',
      description: 'Close the browser session. The next browser tool call starts a new one, with no cookies or storage carried over.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      requiresApproval: false,
      execute: async () => browser.close(),
    },
  ];
}
