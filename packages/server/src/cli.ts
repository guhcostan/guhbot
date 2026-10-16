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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop, OpenAiCompatibleProvider, builtinTools } from '@guhbot/agent';
import { Host } from '@guhbot/host-core';
import { HostServer, localAddresses } from './server.js';

const VERSION = '0.1.0';

function defaultDataDir(): string {
  return join(homedir(), '.guhbot');
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

  // A host without a provider still works: it serves transcripts and settings,
  // and reports inferenceReady: false so clients can explain why runs fail.
  const executor =
    baseUrl !== undefined
      ? new AgentLoop({
          provider: new OpenAiCompatibleProvider({
            baseUrl,
            apiKey,
            ...(model !== undefined ? { defaultModel: model } : {}),
          }),
          tools: builtinTools({ allowedHosts }),
          cwd: process.cwd(),
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
