/**
 * The two functions that run *inside* the page.
 *
 * Playwright serialises them and evaluates them in the renderer, so each one must
 * be completely self-contained: no module-scope helpers, no imports, no closure
 * over anything but its argument. Breaking that rule fails at runtime inside the
 * browser, where the stack trace is unhelpful, so keep helpers nested.
 *
 * This repository's tsconfig has no `lib: DOM` (the host is a Node program), so
 * the handful of browser globals used here are declared structurally below. That
 * is a deliberate trade: widening the compiler's lib for the whole package would
 * make `document` and `fetch` type-check in Node-only code too.
 *
 * Neither function accepts JavaScript from the model. Page JavaScript is never
 * evaluated on the model's behalf; these two fixed scripts are the entire
 * scripting surface, and both only read.
 */

interface InPageStyle {
  readonly display: string;
  readonly visibility: string;
}

interface InPageElement {
  readonly tagName: string;
  readonly children: ArrayLike<InPageElement>;
  readonly parentElement: InPageElement | null;
  readonly textContent: string | null;
  readonly innerText?: string;
  /** Live property, so a field reflects what was typed, not its initial attribute. */
  readonly value?: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  matches(selector: string): boolean;
  closest(selector: string): InPageElement | null;
  querySelectorAll(selector: string): ArrayLike<InPageElement>;
}

interface InPageDocument {
  readonly title: string;
  readonly location: { readonly href: string };
  querySelector(selector: string): InPageElement | null;
  querySelectorAll(selector: string): ArrayLike<InPageElement>;
}

declare const document: InPageDocument;
declare function getComputedStyle(element: InPageElement): InPageStyle;

/** One interactive element, as seen by the ref scheme. */
export interface RawElement {
  /** 1-based, assigned in DOM order. Only meaningful for the latest extract. */
  ref: number;
  tag: string;
  kind: 'link' | 'button' | 'field' | 'other';
  label: string;
  selector: string;
  href: string | null;
  value: string | null;
}

export interface ExtractArgs {
  selector: string | null;
  maxChars: number;
  maxElements: number;
}

export interface ExtractResult {
  title: string;
  url: string;
  text: string;
  totalChars: number;
  elements: RawElement[];
  elementsTruncated: boolean;
  /** False when a selector was requested and nothing on the page matches it. */
  scopeFound: boolean;
}

/** One anchor, with the text around it, for the search-results parser. */
export interface RawLink {
  href: string;
  title: string;
  snippet: string;
}

export interface LinkArgs {
  maxLinks: number;
}

export function extractPageInPage(args: ExtractArgs): ExtractResult {
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="textbox"], [role="combobox"], [contenteditable="true"], [onclick]';

  function collapse(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
  }

  // `display: none` does not inherit as a computed value, so hiding is an
  // ancestor question: a visible child of a hidden subtree is still hidden.
  function visible(element: InPageElement): boolean {
    if (element.closest('[hidden], [aria-hidden="true"]') !== null) return false;
    let node: InPageElement | null = element;
    let depth = 0;
    while (node !== null && depth < 32) {
      depth += 1;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      node = node.parentElement;
    }
    return true;
  }

  function tagOf(element: InPageElement): string {
    return collapse(element.tagName).toLowerCase();
  }

  /**
   * A CSS path that survives until the DOM next changes shape.
   *
   * An id short-circuits the walk: ids are unique by contract, and they are the
   * only anchor on a page that does not drift. Everything else is
   * `tag:nth-of-type(n)`, which is stable under sibling insertion but not under
   * reordering, which is why a stale ref is an error rather than a guess.
   */
  function cssPath(element: InPageElement): string {
    const parts: string[] = [];
    let node: InPageElement | null = element;
    let depth = 0;
    while (node !== null && depth < 32) {
      depth += 1;
      const tag = tagOf(node);
      if (tag === 'html' || tag === '') break;
      const id = collapse(node.getAttribute('id'));
      if (id !== '' && /^[A-Za-z][\w-]*$/.test(id)) {
        parts.unshift(`#${id}`);
        break;
      }
      const parent: InPageElement | null = node.parentElement;
      let part = tag;
      if (parent !== null) {
        const sameTag = Array.from(parent.children).filter((child) => tagOf(child) === tag);
        if (sameTag.length > 1) {
          const index = sameTag.findIndex((child) => child === node);
          if (index >= 0) part += `:nth-of-type(${index + 1})`;
        }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function classify(element: InPageElement, tag: string, href: string | null): RawElement['kind'] {
    if (tag === 'a' && href !== null) return 'link';
    if (tag === 'button' || tag === 'summary' || element.matches('[role="button"], [role="tab"]')) return 'button';
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || element.matches('[contenteditable="true"], [role="textbox"], [role="combobox"]')) {
      return 'field';
    }
    return 'other';
  }

  function labelOf(element: InPageElement, tag: string): string {
    const aria = collapse(element.getAttribute('aria-label'));
    if (aria !== '') return aria;
    const own = collapse(element.innerText ?? element.textContent);
    if (own !== '') return own;
    const value = collapse(element.getAttribute('value'));
    if (value !== '') return value;
    const placeholder = collapse(element.getAttribute('placeholder'));
    if (placeholder !== '') return placeholder;
    const name = collapse(element.getAttribute('name'));
    if (name !== '') return name;
    const title = collapse(element.getAttribute('title'));
    if (title !== '') return title;
    return tag;
  }

  function absolute(href: string): string | null {
    try {
      return new URL(href, document.location.href).href;
    } catch {
      return null;
    }
  }

  const scope = args.selector === null ? null : document.querySelector(args.selector);
  if (args.selector !== null && scope === null) {
    return {
      title: document.title,
      url: document.location.href,
      text: '',
      totalChars: 0,
      elements: [],
      elementsTruncated: false,
      scopeFound: false,
    };
  }

  const root: InPageElement | null = scope;
  const body = document.querySelector('body');
  let text = '';
  if (root !== null) {
    text = typeof root.innerText === 'string' ? root.innerText : collapse(root.textContent);
  } else if (body !== null) {
    text = typeof body.innerText === 'string' ? body.innerText : collapse(body.textContent);
  } else {
    text = document.title;
  }

  const totalChars = text.length;
  if (text.length > args.maxChars) text = text.slice(0, args.maxChars);

  const container = root ?? body ?? document.querySelector('html');
  const found = container === null ? [] : Array.from(container.querySelectorAll(INTERACTIVE));
  const elements: RawElement[] = [];
  let visibleCount = 0;
  for (const element of found) {
    if (!visible(element)) continue;
    const tag = tagOf(element);
    const hrefRaw = element.getAttribute('href');
    const href = tag === 'a' && hrefRaw !== null ? absolute(hrefRaw) : null;
    const label = collapse(labelOf(element, tag));
    if (tag === 'a' && href === null) continue;
    if (label === '') continue;
    const kind = classify(element, tag, href);
    visibleCount += 1;
    if (elements.length >= args.maxElements) continue;
    elements.push({
      ref: elements.length + 1,
      tag,
      kind,
      label: label.length > 160 ? `${label.slice(0, 157)}...` : label,
      selector: cssPath(element),
      href,
      value: kind === 'field' ? collapse(typeof element.value === 'string' ? element.value : element.getAttribute('value')) || null : null,
    });
  }

  return {
    title: document.title,
    url: document.location.href,
    text,
    totalChars,
    elements,
    // Counted over *visible* candidates: hidden markup is not something the model
    // is missing out on, so it must not be reported as truncation.
    elementsTruncated: visibleCount > elements.length,
    scopeFound: true,
  };
}

export function collectLinksInPage(args: LinkArgs): RawLink[] {
  function collapse(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
  }

  const anchors = Array.from(document.querySelectorAll('a[href]'));
  const results: RawLink[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    if (results.length >= args.maxLinks) break;
    if (anchor.closest('nav, header, footer, aside') !== null) continue;
    const raw = anchor.getAttribute('href');
    if (raw === null) continue;
    let href: string;
    try {
      href = new URL(raw, document.location.href).href;
    } catch {
      continue;
    }
    if (!href.startsWith('http://') && !href.startsWith('https://')) continue;
    if (seen.has(href)) continue;

    const title = collapse(anchor.innerText ?? anchor.textContent);
    if (title.length < 2 || title.length > 300) continue;

    // The snippet is the surrounding block's text minus the title itself. Walk up
    // until an ancestor holds more than the anchor alone: stopping at `h3` gives
    // no snippet, and walking all the way up gives every result the whole page.
    let snippet = '';
    let node = anchor.parentElement;
    let depth = 0;
    while (node !== null && depth < 4) {
      depth += 1;
      const text = collapse(node.textContent);
      if (text.length > title.length) {
        snippet = text.split(title).join(' ');
        break;
      }
      node = node.parentElement;
    }

    seen.add(href);
    results.push({ href, title, snippet: collapse(snippet).slice(0, 320) });
  }

  return results;
}
