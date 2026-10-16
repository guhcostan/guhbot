/**
 * Real-browser smoke verification. Not part of the test suite.
 *
 * `pnpm --filter @guhbot/browser build && pnpm --filter @guhbot/browser smoke`
 *
 * The tests deliberately run without a browser, which leaves the engine itself
 * unproven. This script closes that gap on a machine that has a browser: two
 * loopback HTTP servers, one allow-listed and one not, so navigation, refs,
 * clicking, typing, live field values, screenshots, search parsing and - most
 * importantly - the request interceptor refusing a redirect hop and a
 * subresource can be checked for real. It reaches nothing outside 127.0.0.1 and
 * downloads nothing.
 *
 * Each check prints PASS or FAIL; the script exits non-zero if any check fails.
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserCapability, isNavigationAllowed } from '../dist/index.js';

const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

function serve(routes) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const handler = routes[pathname];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(page('Not found', '<h1>404</h1>'));
      return;
    }
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const evil = await serve({
  '/': (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('Evil', '<h1>evil</h1>'));
  },
  '/pixel.png': (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  },
});

let evilPort = evil.port;
const good = await serve({
  '/': (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      page(
        'Fixture home',
        `<h1>Welcome to the fixture</h1>
         <a id="next" href="/next">Go to the next page</a>
         <button id="press" onclick="document.getElementById('out').textContent='pressed'">Press me</button>
         <input id="q" name="q" aria-label="Search box" placeholder="Search">
         <div hidden><button>Hidden button</button></div>
         <img src="http://127.0.0.1:${evil.port}/pixel.png" alt="blocked pixel">
         <p id="out">nothing yet</p>`,
      ),
    );
  },
  '/next': (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('Second page', '<h1>Second page</h1><p>You made it.</p>'));
  },
  '/redirect': (_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${evil.port}/` });
    res.end();
  },
  '/search': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      page(
        'Search results',
        `<form><input name="q"></form>
         <article><h3><a href="https://result-one.test/a">Result one</a></h3><p>Snippet for one.</p></article>
         <article><h3><a href="https://result-two.test/b">Result two</a></h3><p>Snippet for two.</p></article>`,
      ),
    );
  },
});

const dataDir = mkdtempSync(join(tmpdir(), 'guhbot-browser-smoke-'));
const allowed = [`127.0.0.1:${good.port}`];
const capability = createBrowserCapability({
  dataDir,
  allowedHosts: allowed,
  searchUrlTemplate: `http://127.0.0.1:${good.port}/search?q={query}`,
});

const tools = Object.fromEntries((capability.tools?.() ?? []).map((tool) => [tool.name, tool]));
const context = { signal: new AbortController().signal, cwd: dataDir, readSecret: () => null, note: (m) => console.log(`  [note] ${m}`) };

const results = [];
const check = (label, condition, detail = '') => {
  results.push(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` :: ${detail}`}`);
};

try {
  const open = await tools['browser_open'].execute({ url: `http://127.0.0.1:${good.port}/` }, context);
  check('open returns the title', open.includes('Fixture home'));
  check('open lists refs for interactive elements', /\[1\] link "Go to the next page"/.test(open), open.split('\n').slice(0, 12).join(' | '));
  check('hidden elements are not offered as refs', !open.includes('Hidden button'));
  check('a blocked subresource is reported', /egress policy blocked requests to: 127\.0\.0\.1/.test(open), open.split('\n')[1] ?? '');
  check('page text is extracted', open.includes('Welcome to the fixture'));

  const read = await tools['browser_read'].execute({ selector: '#out' }, context);
  check('a scoped read returns just that subtree', read.includes('nothing yet') && !read.includes('Welcome to the fixture'));

  const click = await tools['browser_click'].execute({ ref: 2 }, context);
  check('clicking a ref works', click.includes('Stayed on'), click.split('\n')[0]);
  const afterClick = await tools['browser_read'].execute({ selector: '#out' }, context);
  check('the click had its effect', afterClick.includes('pressed'));

  const typed = await tools['browser_type'].execute({ label: 'Search box', text: 'hello world', clear: true }, context);
  check('typing by label works', typed.includes('Stayed on'));
  const withValue = await tools['browser_read'].execute({}, context);
  check('the typed value is visible in the field', withValue.includes('"hello world"'), withValue.split('\n').find((l) => l.includes('field')) ?? '');

  const shot = await tools['browser_screenshot'].execute({ name: 'home.png' }, context);
  check('screenshot returns a path and dimensions', /1280x800/.test(shot), shot.split('\n')[0]);

  const navigated = await tools['browser_click'].execute({ ref: 1 }, context);
  check('clicking a link navigates', navigated.includes('Navigated to') && navigated.includes('/next'), navigated.split('\n')[0]);
  const refsGone = await tools['browser_click'].execute({ ref: 1 }, context).then(
    () => 'clicked without a snapshot',
    (error) => error.message,
  );
  check('a ref from the previous document is refused', /fresh refs|not in the current page snapshot/.test(refsGone), String(refsGone));

  const redirect = await tools['browser_open'].execute({ url: `http://127.0.0.1:${good.port}/redirect` }, context).then(
    (value) => `unexpectedly allowed: ${value.slice(0, 80)}`,
    (error) => error.message,
  );
  check('a redirect to a disallowed host is refused', /egress policy|allow list/.test(redirect), String(redirect).slice(0, 200));
  const afterRedirect = await capability.methods['browser.status'].handler({}, {}, {});
  check(
    'the interceptor saw and aborted the redirect hop',
    afterRedirect.blockedHosts.some((host) => host.includes(String(evilPort))),
    JSON.stringify(afterRedirect.blockedHosts),
  );

  const search = await tools['browser_search'].execute({ query: 'guhbot test' }, context);
  check('search parses result links', search.includes('Result one') && search.includes('https://result-one.test/a'), search.split('\n').slice(0, 5).join(' | '));
  check('search drops its own host', !search.includes('/search?q='));

  const status = await capability.methods['browser.status'].handler({}, {}, {});
  check('status reports a live session', status.launched === true && status.elementCount >= 0, JSON.stringify(status).slice(0, 200));

  const close = await tools['browser_close'].execute({}, context);
  check('close reports success', close.includes('closed'), close);
  const closed = await tools['browser_close'].execute({}, context);
  check('close is idempotent', closed.includes('already closed'), closed);

  check('a disallowed URL is refused before launch', !isNavigationAllowed('https://evil.test/', allowed));
} catch (error) {
  check('the run completed without throwing', false, `${error?.name}: ${error?.message}`);
} finally {
  await capability.dispose?.();
  await capability.dispose?.();
  good.server.close();
  evil.server.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(results.join('\n'));
const passed = results.filter((line) => line.startsWith('PASS')).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exitCode = passed === results.length ? 0 : 1;
