#!/usr/bin/env node
/**
 * `guhbot-host` — run the host.
 *
 * Usage:
 *   guhbot-host                       # loopback only, no model configured
 *   guhbot-host --lan                 # reachable from your phone on the LAN
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
import { HostServer, localAddresses } from './server.js';

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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      port: { type: 'string' },
      lan: { type: 'boolean', default: false },
      'base-url': { type: 'string' },
      model: { type: 'string' },
      'api-key-env': { type: 'string', default: 'GUHBOT_API_KEY' },
      'allowed-hosts': { type: 'string' },
      'session-header': { type: 'string' },
      workspace: { type: 'string' },
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
        '  --lan                  Bind all interfaces so a phone can connect',
        '  --base-url <url>       OpenAI-compatible API base, e.g. https://api.openai.com/v1',
        '  --model <name>         Default model for agents',
        '  --api-key-env <name>   Env var holding the API key (default GUHBOT_API_KEY)',
        '  --allowed-hosts <csv>  Hosts http_fetch may reach (default: none)',
        '  --session-header <n>   Send a fresh UUID under header <n> on every model',
        '                         request. Some gateways refuse requests without one.',
        '  --workspace <path>     Directory agents may read and write. Defaults to',
        '                         <data-dir>/workspace, NOT the current directory.',
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
  const model = values.model ?? process.env['GUHBOT_MODEL'];
  const apiKey = process.env[values['api-key-env']];
  const allowedHosts = (values['allowed-hosts'] ?? '').split(',').map((h) => h.trim()).filter((h) => h.length > 0);
  const sessionHeader = values['session-header'];
  const workspace = values.workspace ?? join(dataDir, 'workspace');

  // A host without a provider still works: it serves transcripts and settings,
  // and reports inferenceReady: false so clients can explain why runs fail.
  const executor =
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
          tools: builtinTools({ allowedHosts }),
          // Defaulting to the current directory would hand an agent whatever
          // repository you happened to launch the host from, node_modules and
          // all. A dedicated workspace is the safe default; pointing it at a
          // real project is a deliberate act.
          cwd: workspace,
        })
      : undefined;

  const host = new Host({
    dataDir,
    version: VERSION,
    mode,
    capabilities: {
      exec: true,
      filesystem: true,
      browser: false,
      voice: false,
      messages: process.platform === 'darwin',
      vnc: false,
      egress: allowedHosts.length > 0,
    },
    ...(executor ? { executor } : {}),
  });

  mkdirSync(workspace, { recursive: true });

  const operatorToken = await ensureOperatorToken(host, dataDir);

  const server = new HostServer({
    host,
    port,
    lan: values.lan,
    onPairing: () => {
      /* CLI prints the pairing summary itself below. */
    },
  });

  const { port: boundPort, addresses } = await server.listen();
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
      `  reachable     ${values.lan ? 'from your network (LAN mode)' : 'from this machine only'}`,
      `  workspace     ${workspace}`,
      `  operator      ${join(dataDir, 'operator.token')}  (0600, person class)`,
      '',
    ].join('\n'),
  );

  if (!values.lan) {
    process.stdout.write(
      '  To connect a phone, restart with --lan and pair it:\n' +
        '    guhbot-host --lan ...\n\n' +
        '  Reminder: LAN mode exposes this host to your local network. Anyone who\n' +
        '  pairs keeps access until you revoke the device.\n\n',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\n  ${signal} received, shutting down.\n`);
    await server.close();
    await host.close(signal);
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
  } else if (values.lan) {
    const info = server.createPairing();
    process.stdout.write(`  pairing code ${info.code} (expires ${info.expiresAt})\n  uri ${info.uri}\n\n`);
  }
  void localAddresses;
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
