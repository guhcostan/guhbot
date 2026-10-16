import type { ContributedMethod } from '@guhbot/host-core';
import { HostError } from '@guhbot/host-core';
import { z } from 'zod';
import { CanvasError } from './errors.js';
import type { CanvasEntry, CanvasStore } from './store.js';
import { CANVAS_THEMES, canvasUrl } from './url.js';

/**
 * The client-facing half of the capability.
 *
 * Three methods, and the split is the authorization model:
 *
 *  - `canvas.list` and `canvas.get` are `background`: they observe documents
 *    this host already holds. A paired phone reading a canvas learns nothing it
 *    could not read from the transcript.
 *  - `canvas.delete` is `person`: it destroys durable state. A device that is
 *    merely paired must not be able to remove the user's documents.
 *
 * Nothing here renders, and nothing here returns bytes from an arbitrary path.
 * The HTML comes out of the store by content address or not at all.
 */
const CanvasSummarySchema = z.object({
  id: z.string().length(64),
  title: z.string().min(1).max(200),
  bytes: z.number().int().positive(),
  createdAt: z.string().min(1).max(64),
  /** Locator for a client that renders canvases. Never a source of bytes. */
  url: z.string().min(1).max(256),
});

const CanvasListInput = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});

const CanvasListOutput = z.object({ canvases: z.array(CanvasSummarySchema) });

const CanvasGetInput = z.object({
  id: z.string().min(1).max(256),
  theme: z.enum(CANVAS_THEMES).default('light'),
});

const CanvasGetOutput = CanvasSummarySchema.extend({
  html: z.string(),
  /** The policy enforced on this document, as a CSP string. */
  csp: z.string().min(1).max(8192),
});

const CanvasDeleteInput = z.object({ id: z.string().min(1).max(256) });
const CanvasDeleteOutput = z.object({ deleted: z.boolean(), id: z.string().min(1).max(256) });

export function createCanvasMethods(store: CanvasStore): Record<string, ContributedMethod> {
  return {
    'canvas.list': {
      authz: 'background',
      input: CanvasListInput,
      output: CanvasListOutput,
      summary: 'List the canvases stored on this host, newest first.',
      handler: async (_host, _session, input: z.infer<typeof CanvasListInput>) => {
        try {
          const entries = await store.list(input.limit ?? 50);
          return { canvases: entries.map((entry) => summarize(entry)) };
        } catch (error) {
          throw mapError(error);
        }
      },
    },
    'canvas.get': {
      authz: 'background',
      input: CanvasGetInput,
      output: CanvasGetOutput,
      summary: 'Fetch one canvas document by id, including the exact HTML to render.',
      handler: async (_host, _session, input: z.infer<typeof CanvasGetInput>) => {
        try {
          const { entry, bytes } = await store.get(input.id);
          return {
            ...summarize(entry, input.theme),
            html: bytes.toString('utf8'),
            csp: entry.csp,
          };
        } catch (error) {
          throw mapError(error);
        }
      },
    },
    'canvas.delete': {
      // Person: deleting durable state over RPC needs a device a human created
      // while physically present. The tool of the same name is a different
      // surface — it runs inside a run a human already started.
      authz: 'person',
      input: CanvasDeleteInput,
      output: CanvasDeleteOutput,
      summary: 'Delete a stored canvas by id. Reports whether anything was there.',
      handler: async (_host, _session, input: z.infer<typeof CanvasDeleteInput>) => {
        try {
          const deleted = await store.delete(input.id);
          // False rather than an error: a client retrying a delete after a
          // dropped response must not be told the work failed when it did not.
          return { deleted, id: input.id };
        } catch (error) {
          throw mapError(error);
        }
      },
    },
  };
}

function summarize(entry: CanvasEntry, theme: 'light' | 'dark' = 'light'): {
  id: string;
  title: string;
  bytes: number;
  createdAt: string;
  url: string;
} {
  return {
    id: entry.id,
    title: entry.title,
    bytes: entry.bytes,
    createdAt: entry.createdAt,
    url: canvasUrl(entry.id, theme),
  };
}

/**
 * Translate a refusal into the protocol's vocabulary.
 *
 * The protocol has six codes and the store has seven, and the mapping is not
 * cosmetic: an integrity failure is this host's problem (`internal`), while a
 * bad id is the caller's (`bad-request`). What never changes is the message,
 * which is what a person reading the client will actually see.
 */
function mapError(error: unknown): Error {
  if (!(error instanceof CanvasError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  switch (error.code) {
    case 'not-found':
      return new HostError('not-found', error.message);
    case 'forbidden':
      return new HostError('forbidden', error.message);
    case 'integrity':
    case 'closed':
      return new HostError('internal', error.message);
    default:
      return new HostError('bad-request', error.message);
  }
}
