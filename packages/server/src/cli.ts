#!/usr/bin/env node
/**
 * `guhbot-host` — run the host.
 *
 * Usage:
 *   guhbot-host                       # loopback only, no model configured
 *   guhbot-host --companion           # also bind a socket paired devices can reach
 *   guhbot-host --base-url https://api.openai.com/v1 --model gpt-4o-mini
 *
 * Configuration is flags plus environment. There is no config file: the host is
 * meant to be startable from a container entrypoint, a systemd unit or a
 * `docker run`, all of which are easier to reason about with explicit flags.
 */
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop, OpenAiCompatibleProvider, builtinTools } from '@guhbot/agent';
import { Host, hashToken, newToken } from '@guhbot/host-core';
import type { RunExecutor } from '@guhbot/host-core';
import { HostServer, localAddresses } from './server.js';
import { mountCapabilities } from './capabilities.js';
import type { McpServerConfig } from '@guhbot/mcp';
import { createCliEngines, createEngineRegistry } from '@guhbot/engine-cli';
import { createCompanion, createHostVerifyToken, type Companion } from '@guhbot/companion';

const VERSION = '0.1.0';

function defaultDataDir(): string {
  return join(homedir(), '.guhbot');
}


/**
 * Ensure this machine has an operator device, and return its token.
 *
 * A host on your own machine needs exactly one thing the pairing flow cannot
 * give it: a `person`-class device for whoever is sitting at the keyboard.
 * Without one, `runs.start` and `approvals.resolve` are unreachable from the
 * terminal, and the host can only be observed, never driven.
 *
 * The token is written to `<dataDir>/operator.token` with mode 0600. That file
 * is a credential, and the honest framing is that anything able to read it can
 * already read the database and the master key next to it, so the file grants
 * nothing that was not already available. Remote devices still have to pair and
 * still join as `background`.
 *
 * The token is reused across restarts so a client does not have to re-read it
 * every time.
 */
async function ensureOperatorToken(host: Host, dataDir: string): Promise<string> {
  const tokenPath = join(dataDir, 'operator.token');
  const existing = host.store.listDevices().find((d) => d.name === 'Operator (this machine)' && d.class === 'person');
  if (existing && existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, 'utf8').trim();
    if (host.authenticate(token) !== null) return token;
    // Fall through and mint a fresh one; the old token no longer authenticates.
  }

  const token = newToken();
  const { createHash } = await import('node:crypto');
  const salt = createHash('sha256').update(`operator:${host.hostId}`).digest();
  host.store.createDevice({
    name: 'Operator (this machine)',
    platform: 'cli',
    deviceClass: 'person',
    tokenSalt: salt,
    tokenHash: hashToken(token, salt),
  });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return token;
}

/**
 * Read an MCP configuration file.
 *
 * Accepts the shape every MCP client uses (`{"mcpServers": {...}}`) and a bare
 * array, because that is what people paste. A malformed file is fatal: silently
 * starting with no MCP servers when the user asked for some is worse than
 * refusing to start.
 */
function readMcpConfig(path: string): McpServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`could not read MCP config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Array.isArray(parsed)) return parsed as McpServerConfig[];
  const named = (parsed as { mcpServers?: Record<string, unknown> }).mcpServers;
  if (named !== undefined && typeof named === 'object') {
    return Object.entries(named).map(([name, entry]) => ({ name, ...(entry as object) })) as McpServerConfig[];
  }
  throw new Error(`MCP config at ${path} has neither an array nor an "mcpServers" object`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      port: { type: 'string' },
      'base-url': { type: 'string' },
      model: { type: 'string' },
      'api-key-env': { type: 'string', default: 'GUHBOT_API_KEY' },
      'allowed-hosts': { type: 'string' },
      'session-header': { type: 'string' },
      workspace: { type: 'string' },
      'browser-hosts': { type: 'string' },
      'search-url': { type: 'string' },
      'mcp-config': { type: 'string' },
      'mcp-allow-stdio': { type: 'boolean', default: false },
      'messages-allow': { type: 'string' },
      engine: { type: 'string' },
      'list-engines': { type: 'boolean', default: false },
      companion: { type: 'boolean', default: false },
      'companion-port': { type: 'string' },
      'companion-insecure-plaintext': { type: 'boolean', default: false },
      mode: { type: 'string', default: 'self-hosted' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      [
        'guhbot-host — self-hostable agent host',
        '',
        'Options:',
        '  --data-dir <path>      Where the database and secrets live (default ~/.guhbot)',
        '  --port <n>             Port to bind (default: an ephemeral port)',
        '  --base-url <url>       OpenAI-compatible API base, e.g. https://api.openai.com/v1',
        '  --model <name>         Default model for agents',
        '  --api-key-env <name>   Env var holding the API key (default GUHBOT_API_KEY)',
        '  --allowed-hosts <csv>  Hosts http_fetch may reach (default: none)',
        '  --session-header <n>   Send a fresh UUID under header <n> on every model',
        '                         request. Some gateways refuse requests without one.',
        '  --workspace <path>     Directory agents may read and write. Defaults to',
        '                         <data-dir>/workspace, NOT the current directory.',
        '  --browser-hosts <csv>  Hosts the browser may navigate to. Empty disables',
        '                         the browser capability entirely (no egress).',
        '  --search-url <tpl>     Search endpoint containing {query}, for browser_search.',
        '  --mcp-config <path>    JSON file of MCP servers ({"mcpServers":{...}}).',
        '  --mcp-allow-stdio      Permit MCP servers that spawn local processes.',
        '  --messages-allow <csv> iMessage chats/handles this host may read and send to.',
        '  --engine <id>          Run agents through an installed CLI instead of a model',
        '                         API: claude-code, codex or opencode. No API key needed',
        '                         when you already have a subscription for one of them.',
        '  --list-engines         Probe the installed agent CLIs and exit.',
        '  --companion            Also bind a network socket so a phone can connect.',
        '  --companion-port <n>   Port for the companion (default 8787).',
        '  --companion-insecure-plaintext',
        '                         Required acknowledgement: without TLS, device tokens',
        '                         cross the network in the clear.',
        '  --mode <m>             self-hosted | hosted (default self-hosted)',
        '',
      ].join('\n'),
    );
    return;
  }

  const dataDir = values['data-dir'] ?? defaultDataDir();
  const port = values.port !== undefined ? Number(values.port) : 0;
  const mode = values.mode === 'hosted' ? 'hosted' : 'self-hosted';

  const baseUrl = values['base-url'] ?? process.env['GUHBOT_BASE_URL'];
  void values;
  const model = values.model ?? process.env['GUHBOT_MODEL'];
  const apiKey = process.env[values['api-key-env']];
  const allowedHosts = (values['allowed-hosts'] ?? '').split(',').map((h) => h.trim()).filter((h) => h.length > 0);
  const sessionHeader = values['session-header'];
  const workspace = values.workspace ?? join(dataDir, 'workspace');
  const browserHosts = (values['browser-hosts'] ?? '').split(',').map((h) => h.trim()).filter((h) => h.length > 0);
  const messagesAllow = (values['messages-allow'] ?? '').split(',').map((h) => h.trim()).filter((h) => h.length > 0);

  // -- Engines --------------------------------------------------------------
  //
  // Handled before capabilities are mounted. `mountCapabilities` starts the
  // scheduler, whose timer keeps the event loop alive; returning early after that
  // leaves the process hanging instead of exiting. Anything that can return
  // before the host is constructed has to run before that point.-----------------------------------------------------------
  const engineRegistry = createEngineRegistry(createCliEngines());

  if (values['list-engines'] === true) {
    process.stdout.write('\n  Installed agent CLIs this host can drive:\n\n');
    for (const descriptor of engineRegistry.list()) {
      const engine = engineRegistry.get(descriptor.id);
      const probe = engine ? await engine.probe() : null;
      const state = probe === null ? '?' : !probe.available ? `not found (${probe.reason ?? 'no reason given'})` : probe.blocked !== null ? `installed, ${probe.blocked}` : `ready${probe.version !== null ? ` (${probe.version})` : ''}`;
      process.stdout.write(`    ${descriptor.id.padEnd(14)} ${state}\n`);
      if (probe !== null && probe.available && probe.blocked === null) {
        process.stdout.write(`    ${' '.repeat(14)} needs: ${descriptor.requirement}\n`);
      }
    }
    process.stdout.write('\n  Use one with --engine <id>.\n\n');
    return;
  }

  const requestedEngine = values.engine;
  let cliExecutor: RunExecutor | undefined;
  if (requestedEngine !== undefined) {
    const engine = engineRegistry.require(requestedEngine);
    const probe = await engine.probe();
    if (!probe.available) {
      // Refusing to start is the honest response. Starting and failing on the
      // first prompt would look like the agent is broken.
      process.stderr.write(
        `fatal: engine "${requestedEngine}" is not usable here: ${probe.reason ?? 'unknown reason'}\n` +
          `       ${engine.requirement}\n`,
      );
      process.exit(2);
    }
    if (probe.blocked !== null) {
      // A blocked engine is installed but cannot work right now. Warn rather than
      // refuse: a rate limit resets, and the user may still want the host up.
      process.stderr.write(`warning: engine "${requestedEngine}" is ${probe.blocked}; runs will fail until that clears\n`);
    }
    cliExecutor = engine.createExecutor({ cwd: workspace });
    process.stdout.write(
      `\n  engine        ${engine.name}${probe.version !== null ? ` ${probe.version}` : ''}\n` +
        '                this engine runs its own tools and applies its own permission\n' +
        '                rules, so this host records the run but does not gate its tools\n',
    );
  }


  const mcpServers = values['mcp-config'] !== undefined ? readMcpConfig(values['mcp-config']) : [];
  // The scheduler starts runs on a host that does not exist yet, because the host
  // needs the scheduler's tools at construction. A late-bound getter breaks the
  // cycle: the capability declares its tools now and only dereferences the host
  // from its first tick, which runs after this function has finished building it.
  let hostRef: Host | undefined;
  const hostGetter = (): Host => {
    if (hostRef === undefined) {
      throw new Error('the scheduler ran before the host was constructed; this is a bug in the CLI wiring');
    }
    return hostRef;
  };

  const mounted = await mountCapabilities({
    dataDir,
    allowedHosts,
    searchUrlTemplate: values['search-url'],
    browser: { enabled: browserHosts.length > 0 },
    mcp: { allowStdio: values['mcp-allow-stdio'], servers: mcpServers },
    messages: { allowed: messagesAllow },
    // On by default: a canvas only ever writes inside this host's own store, and
    // "works while you sleep" is the point of a host you leave running.
    canvas: { enabled: true },
    scheduler: { host: hostGetter },
    // Memory writes only inside this host's own store, and credentials reach
    // nothing until a human puts a value in. Both are on by default so a fresh
    // host has them; neither opens a socket or spends anything.
    memory: { host: hostGetter },
    credentials: { host: hostGetter },
  });
  // The browser shares the egress list with http_fetch, so a host that allows
  // one allows the other; `--allowed-hosts` alone is enough for both.
  const egressHosts = allowedHosts.length > 0 ? allowedHosts : browserHosts;

  // A host without a provider still works: it serves transcripts and settings,
  // and reports inferenceReady: false so clients can explain why runs fail.
  const apiExecutor =
    baseUrl !== undefined
      ? new AgentLoop({
          provider: new OpenAiCompatibleProvider({
            baseUrl,
            apiKey,
            ...(model !== undefined ? { defaultModel: model } : {}),
            // A fresh id per request, because a routing gateway uses it to keep
            // concurrent conversations apart.
            ...(sessionHeader !== undefined
              ? { headers: () => ({ [sessionHeader]: randomUUID() }) }
              : {}),
          }),
          tools: [...builtinTools({ allowedHosts: egressHosts }), ...mounted.tools],
          // What a capability wants in front of the model without spending a
          // tool call on it — memory's recall, for instance.
          contextSections: mounted.contextSections,
          // Defaulting to the current directory would hand an agent whatever
          // repository you happened to launch the host from, node_modules and
          // all. A dedicated workspace is the safe default; pointing it at a
          // real project is a deliberate act.
          cwd: workspace,
        })
      : undefined;

  const executor: RunExecutor | undefined = cliExecutor ?? apiExecutor;

  const host = new Host({
    dataDir,
    version: VERSION,
    mode,
    capabilities: {
      exec: true,
      filesystem: true,
      // Defaults, then whatever the mounted capabilities actually declare wins.
      browser: false,
      voice: false,
      messages: false,
      vnc: false,
      memory: false,
      credentials: false,
      egress: egressHosts.length > 0,
      ...mounted.flags,
    },
    ...(executor ? { executor } : {}),
    ...(Object.keys(mounted.extraMethods).length > 0 ? { extraMethods: mounted.extraMethods } : {}),
  });
  hostRef = host;

  // Harmless to do after construction, and honest about the end state: if a
  // capability could not prepare, it says so on the console rather than at the
  // first run.
  for (const note of mounted.notes) {
    process.stderr.write(`  note          ${note}\n`);
  }

  mkdirSync(workspace, { recursive: true });

  const operatorToken = await ensureOperatorToken(host, dataDir);

  const server = new HostServer({ host, port,
    onPairing: () => {
      /* CLI prints the pairing summary itself below. */
    },
  });

  const { port: boundPort, addresses } = await server.listen();

  // The companion is the only process that binds a network socket, and it runs
  // inside this one so it can reach the host's device table directly. The
  // alternative, a separate process, cannot verify a token without either a new
  // RPC that hands one process another's auth decision, or a second opener of
  // data.db; both are worse than a thread.
  let companion: Companion | null = null;
  if (values.companion === true) {
    const companionPort = values['companion-port'] !== undefined ? Number(values['companion-port']) : 8787;
    const insecurePlaintext = values['companion-insecure-plaintext'] === true;
    try {
      companion = createCompanion({
        harness: { port: boundPort },
        verifyToken: createHostVerifyToken(host),
        port: companionPort,
        insecurePlaintext,
        // The pairing URI must point at the companion, not at the loopback
        // harness, or a scanned code sends the phone to an address only this
        // machine can reach.
        advertisedAddresses: localAddresses(),
        redactPaths: [dataDir, workspace],
      });
      await companion.listen();
    } catch (error) {
      process.stderr.write(
        `fatal: the companion could not start: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      await server.close();
      await host.close('companion failed');
      process.exit(2);
    }
  }

  const status = host.status();

  process.stdout.write(
    [
      '',
      `  guhbot host ${VERSION}  (${mode})`,
      '',
      `  data dir      ${dataDir}`,
      `  host id       ${status.hostId}`,
      `  listening     ${addresses.map((a) => `http://${a}:${boundPort}`).join('  ')}`,
      `  inference     ${status.inferenceReady ? `ready (${model ?? 'provider default'})` : 'NOT CONFIGURED — set --base-url and --model'}`,
      `  reachable     from this machine only (loopback)`,
      values.companion === true
        ? `  for phones    ws://${localAddresses()[0] ?? '0.0.0.0'}:${companion?.port ?? 0}/rpc  (companion)`
        : '  for phones    not exposed; restart with --companion to bind a network socket',
      `  workspace     ${workspace}`,
      `  capabilities  ${mounted.mounted.length > 0 ? mounted.mounted.join(', ') : 'none beyond built-in tools'}`,
      `  operator      ${join(dataDir, 'operator.token')}  (0600, person class)`,
      '',
    ].join('\n'),
  );

  if (values.companion !== true) {
    process.stdout.write(
      '  To reach this host from a phone, restart with --companion.\n' +
        '  The harness itself never binds a network socket.\n\n',
    );
  } else if (values['companion-insecure-plaintext'] === true) {
    process.stdout.write(
      '  WARNING: plaintext. Device tokens cross your network in the clear.\n' +
        '  Put a TLS terminator in front, or use a tailnet.\n\n',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\n  ${signal} received, shutting down.\n`);
    await companion?.close();
    await server.close();
    await host.close(signal);
    await mounted.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Pairing on demand: mint a code when stdin receives a newline, so the CLI can
  // stay in the foreground without printing a code nobody is ready to use.
  if (process.stdin.isTTY) {
    process.stdout.write('  Press Enter to mint a pairing code, Ctrl-C to quit.\n\n');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', () => {
      const info = server.createPairing();
      process.stdout.write(
        [
          '  ── pairing ──────────────────────────────────────────────',
          `  code     ${info.code}`,
          `  expires  ${new Date(info.expiresAt).toLocaleTimeString()}`,
          `  uri      ${info.uri}`,
          `  try      ${info.addresses.map((a) => `${a}:${info.port}`).join(', ')}`,
          '  ─────────────────────────────────────────────────────────',
          '',
        ].join('\n'),
      );
    });
  }
  void localAddresses;
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
