import type { ToolDefinition } from '@guhbot/agent';
import { z } from 'zod';
import type { ArtifactStore } from './artifacts.js';
import { planCanvasCsp } from './csp.js';
import { wrapCanvasDocument } from './document.js';
import { CanvasError } from './errors.js';
import type { ResolvedCanvasOptions } from './options.js';
import type { CanvasEntry, CanvasStore } from './store.js';
import { canvasUrl } from './url.js';
import { cleanTitle, parseToolArguments } from './util.js';

/**
 * The model-facing half of the capability.
 *
 * Two families of tools, and the descriptions are explicit about which is which,
 * because the model is the one choosing:
 *
 *  - `canvas_*` produce **canvases**: HTML this host sandboxes, addresses by
 *    content and can guarantee things about. This is how an agent shows the user
 *    a chart, a report or a small page instead of describing one in prose.
 *  - `artifact_*` produce **artifacts**: ordinary files in a jail. This is how an
 *    agent hands over a CSV or a document without pretending a file is a
 *    sandboxed document or the other way round.
 */

const CreateArgs = z
  .object({
    html: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    // Left as `unknown` on purpose: `planCanvasCsp` owns this validation, so a
    // declaration of `scriptHosts` is refused with a sentence about why remote
    // script is never available, rather than a generic schema error.
    csp: z.unknown().optional(),
  })
  .strict();

const IdArgs = z.object({ id: z.string().min(1).max(256) }).strict();
const ListArgs = z.object({ limit: z.number().int().min(1).max(200).optional() }).strict();

const ArtifactWriteArgs = z
  .object({
    path: z.string().min(1).max(4096),
    content: z.string(),
    encoding: z.enum(['utf-8', 'base64']).optional(),
    overwrite: z.boolean().optional(),
  })
  .strict();

const ArtifactListArgs = z.object({ limit: z.number().int().min(1).max(1000).optional() }).strict();

export function createCanvasTools(
  store: CanvasStore,
  artifacts: ArtifactStore,
  options: ResolvedCanvasOptions,
): ToolDefinition[] {
  return [
    {
      name: 'canvas_create',
      description:
        'Store an HTML document as a canvas the user can open and look at: a chart, a rendered report, a small interactive page. ' +
        'The document is content-addressed (its id is the SHA-256 of the bytes a renderer receives) and always renders in a sandbox with no access to the host. ' +
        "Inline script and style are allowed; remote scripts, remote frames and eval never are. Declare only the hosts the document really fetches from, and only if the host's egress policy already allows them.",
      parameters: {
        type: 'object',
        properties: {
          html: {
            type: 'string',
            description: 'The full HTML document. Fragments are accepted; a doctype and the enforced CSP meta tag are added for you.',
          },
          title: { type: 'string', description: 'Short label shown next to the canvas, at most 200 characters.' },
          csp: {
            type: 'object',
            description:
              'Extra origins the document may load from, on top of inline script and style and data: images. Remote script and remote frames cannot be declared. Every origin must be inside the host egress allow list.',
            properties: {
              connectHosts: {
                type: 'array',
                items: { type: 'string' },
                description: 'https:// or wss:// origins the document may fetch from (fetch, XHR, WebSocket).',
              },
              imageHosts: { type: 'array', items: { type: 'string' }, description: 'https:// origins images may load from.' },
              styleHosts: { type: 'array', items: { type: 'string' }, description: 'https:// origins stylesheets may load from.' },
              fontHosts: { type: 'array', items: { type: 'string' }, description: 'https:// origins fonts may load from.' },
              mediaHosts: { type: 'array', items: { type: 'string' }, description: 'https:// origins audio and video may load from.' },
            },
            additionalProperties: false,
          },
        },
        required: ['html'],
      },
      // Writes only inside this host's own canvas store: nothing outside the
      // host data directory, nothing sent outward, nothing spent. The convention
      // draws its line at "outside the host's own data", and this is inside it.
      requiresApproval: false,
      execute: async (rawArgs) => {
        const args = parseToolArguments(CreateArgs, rawArgs);
        const plan = planCanvasCsp(args.csp, options.egress);
        const document = wrapCanvasDocument(args.html, plan.policy);
        const entry = await store.put({
          bytes: Buffer.from(document, 'utf8'),
          title: args.title === undefined ? 'Untitled canvas' : cleanTitle(args.title) || 'Untitled canvas',
          csp: plan.policy,
        });
        return JSON.stringify({
          id: entry.id,
          url: canvasUrl(entry.id, 'light'),
          title: entry.title,
          bytes: entry.bytes,
          createdAt: entry.createdAt,
          csp: entry.csp,
          note: 'Open the url in a client that renders canvases; the sandbox and policy travel with the document.',
        });
      },
    },
    {
      name: 'canvas_list',
      description: 'List the canvases stored on this host, newest first, with their ids, titles, sizes and URLs.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Maximum number to return, 1-200. Defaults to 50.' } },
        required: [],
      },
      requiresApproval: false,
      execute: async (rawArgs) => {
        const args = parseToolArguments(ListArgs, rawArgs);
        const entries = await store.list(args.limit ?? 50);
        return JSON.stringify({ canvases: entries.map(summarize) });
      },
    },
    {
      name: 'canvas_read',
      description:
        'Return the exact HTML a renderer receives for a canvas, including the enforced CSP meta tag, so it can be revised. Revising means creating a new canvas: the id of an existing one never changes.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Canvas id: the 64-character sha256 returned by canvas_create.' } },
        required: ['id'],
      },
      requiresApproval: false,
      execute: async (rawArgs) => {
        const args = parseToolArguments(IdArgs, rawArgs);
        const { bytes } = await store.get(args.id);
        return bytes.toString('utf8');
      },
    },
    {
      name: 'canvas_delete',
      description:
        'Delete a stored canvas. This removes a document this host stored itself and touches nothing outside its own data directory.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Canvas id to delete.' } },
        required: ['id'],
      },
      // Only our own store is affected: the document lives under `<dataDir>/canvas`,
      // was produced by this host, and deleting it changes nothing a user has
      // outside the host. This is the documented boundary for `requiresApproval`
      // — it is deliberately not `true`.
      requiresApproval: false,
      execute: async (rawArgs) => {
        const args = parseToolArguments(IdArgs, rawArgs);
        const deleted = await store.delete(args.id);
        // The tool fails loudly where the RPC reports `deleted: false`: the model
        // chose this id, and a typo should be visible rather than answered with
        // a cheerful "done".
        if (!deleted) throw new CanvasError('not-found', `no canvas ${args.id}`);
        return JSON.stringify({ deleted: true, id: args.id });
      },
    },
    {
      name: 'artifact_write',
      description:
        'Write a file into the artifact directory a client can open: a CSV, a markdown report, an SVG, a JSON export. The path is jailed to that directory. An existing file is not replaced unless overwrite is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the artifact directory, e.g. reports/q3.md. Nested paths are allowed.' },
          content: { type: 'string', description: 'File contents, as text or as base64 when encoding is "base64".' },
          encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'Defaults to utf-8.' },
          overwrite: { type: 'boolean', description: 'Replace an existing file at this path. Defaults to false.' },
        },
        required: ['path', 'content'],
      },
      // Jailed to `<dataDir>/artifacts`, size- and count-bounded, and it refuses
      // to clobber an existing file without an explicit flag. Nothing here
      // reaches outside the host's own data, so no human is required to produce
      // the deliverable a run was asked for.
      requiresApproval: false,
      execute: async (rawArgs) => {
        const args = parseToolArguments(ArtifactWriteArgs, rawArgs);
        const encoding = args.encoding ?? 'utf-8';
        if (encoding === 'base64' && !/^[A-Za-z0-9+/\s]*={0,2}$/.test(args.content)) {
          throw new CanvasError('bad-request', 'content is not valid base64; omit encoding to write text');
        }
        const bytes = Buffer.from(args.content, encoding === 'base64' ? 'base64' : 'utf8');
        const entry = await artifacts.write({
          path: args.path,
          bytes,
          ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
        });
        return JSON.stringify(entry);
      },
    },
    {
      name: 'artifact_list',
      description: 'List the files in the artifact directory, sorted by path, with size and modification time.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Maximum number to return, 1-1000. Defaults to 200.' } },
        required: [],
      },
      requiresApproval: false,
      execute: async (rawArgs) => {
        const args = parseToolArguments(ArtifactListArgs, rawArgs);
        const entries = await artifacts.list(args.limit ?? 200);
        return JSON.stringify({ artifacts: entries });
      },
    },
  ];
}

function summarize(entry: CanvasEntry): {
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
    url: canvasUrl(entry.id, 'light'),
  };
}
