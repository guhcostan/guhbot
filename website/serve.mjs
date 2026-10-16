#!/usr/bin/env node
/**
 * Local development server for the site and the waitlist.
 *
 * Runs the *same* handler that is deployed to Lambda, so the thing you test
 * locally is the thing that runs in production. The only difference is the
 * store: this uses a JSON file instead of DynamoDB, because a developer should
 * not need an AWS account to click the form.
 *
 *   node website/serve.mjs            # http://127.0.0.1:4173
 *   node website/serve.mjs --port 8080
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createWaitlistHandler } from '../apps/cloud/dist/waitlist.js';

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4173' },
    host: { type: 'string', default: '127.0.0.1' },
    'data-file': { type: 'string', default: join(here, '.waitlist-dev.json') },
  },
  allowPositionals: false,
});

/**
 * A file-backed store, so a local signup survives a restart. Flushes on every
 * write rather than buffering: this is a handful of rows and losing a test entry
 * would be more annoying than the syscall.
 */
class FileWaitlistStore {
  constructor(file) {
    this.file = file;
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFile(file, '[]\n').catch(() => undefined);
    }
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async add(email, source, at) {
    const rows = await this.read();
    const key = email.toLowerCase();
    if (rows.some((row) => row.email === key)) return 'duplicate';
    rows.push({ email: key, source, at });
    await writeFile(this.file, `${JSON.stringify(rows, null, 2)}\n`);
    return 'added';
  }
}

const handleWaitlist = createWaitlistHandler({
  store: new FileWaitlistStore(values['data-file']),
  allowedOrigin: '*',
});

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/api/waitlist') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const result = await handleWaitlist({
        requestContext: { http: { method: req.method ?? 'GET' } },
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(result.statusCode, result.headers);
      res.end(result.body);
      return;
    }

    // Static files, jailed to this directory. Join first (which normalises `..`
    // away), then compare against the root, so traversal cannot walk out — the
    // same rule the agent's own tools follow.
    //
    // `resolve` would be wrong here: given an absolute second argument it
    // discards the first, so `resolve(root, '/index.html')` is `/index.html`.
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const target = resolve(join(here, requested));
    if (target !== here && !target.startsWith(here + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    try {
      const body = await readFile(target);
      res.writeHead(200, {
        'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  })();
});

const port = Number(values.port);
server.listen(port, values.host, () => {
  process.stdout.write(`\n  site + waitlist → http://${values.host}:${port}\n  entries        → ${values['data-file']}\n\n`);
});
