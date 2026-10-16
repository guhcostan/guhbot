/**
 * Every number that bounds a browser call lives here.
 *
 * A browser is the one tool in this host that can be told to do something
 * unbounded: a page that never finishes loading, a script that never settles, an
 * element that never appears, a response that is a gigabyte of text. Each of
 * those has a ceiling below, and the ceilings are options so an operator can
 * tighten them (and, deliberately, only slightly loosen them).
 */
export const LIMITS = {
  /** Text handed back to the model per read. */
  maxTextBytes: 64 * 1024,
  /** Hard ceiling on a per-call `maxBytes` override. */
  maxTextBytesCeiling: 512 * 1024,
  /** Interactive elements reported per read. */
  maxElements: 60,
  maxElementsCeiling: 400,
  /** One navigation. */
  navigationTimeoutMs: 20_000,
  /** One tool call, start to finish, including the launch. */
  callTimeoutMs: 30_000,
  /** Results returned by `browser_search`. */
  maxSearchResults: 10,
  maxSearchResultsCeiling: 50,
  /** Snippet bytes per search result. */
  maxSnippetBytes: 400,
} as const;
