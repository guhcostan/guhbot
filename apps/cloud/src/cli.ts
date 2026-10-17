#!/usr/bin/env node
/**
 * `guhbot-cloud` — run the hosted gateway.
 *
 *   GUHBOT_CLOUD_OPERATOR_TOKEN=... node dist/cli.js \
 *     --root /var/lib/guhbot \
 *     --base-url https://api.openai.com/v1
 *
 * Tenant provisioning is disabled unless an operator token is set, so a gateway
 * started without one cannot be talked into creating hosts by an anonymous
 * caller. That default is deliberate: an open provisioning endpoint is an
 * unbounded-spend bug waiting for a bot to find it.
 */
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { CloudGateway } from './gateway.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: join(process.cwd(), 'guhbot-cloud') },
      port: { type: 'string', default: '8788' },
      host: {
        type: 'string',
        default: process.env['GUHBOT_CLOUD_HOST'] ?? '127.0.0.1',
      },
      'base-url': { type: 'string' },
      model: { type: 'string' },
      'max-tenants': { type: 'string', default: '100' },
      'allowed-hosts': { type: 'string', default: '' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      [
        'guhbot-cloud — hosted mode gateway',
        '',
        'Options:',
        '  --root <path>          Root directory holding one subdirectory per tenant',
        '  --port <n>             Port to bind (default 8788)',
        '  --host <address>       Bind address (default 127.0.0.1; use TLS for remote access)',
        '  --base-url <url>       OpenAI-compatible API base for every tenant',
        '  --model <name>         Default model',
        '  --max-tenants <n>      Refuse to start more than this many hosts',
        '  --allowed-hosts <csv>  Hosts agent tools may reach (default: none)',
        '',
        'Environment:',
        '  GUHBOT_CLOUD_OPERATOR_TOKEN  Required to enable POST /tenants',
        '  GUHBOT_API_KEY               Provider key passed to each tenant host',
        '',
      ].join('\n'),
    );
    return;
  }

  const operatorToken = process.env['GUHBOT_CLOUD_OPERATOR_TOKEN'];
  const gateway = new CloudGateway({
    rootDir: values.root,
    baseUrl: values['base-url'] ?? '',
    apiKey: process.env['GUHBOT_API_KEY'],
    model: values.model,
    maxTenants: Number(values['max-tenants']),
    allowedHosts: values['allowed-hosts']
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h.length > 0),
    bindHost: values.host,
  });

  const port = await gateway.listen(Number(values.port));

  process.stdout.write(
    [
      '',
      '  guhbot cloud gateway',
      '',
      `  listening        http://${values.host}:${port}`,
      `  tenant root      ${values.root}`,
      `  inference        ${values['base-url'] ? `ready (${values.model ?? 'provider default'})` : 'NOT CONFIGURED'}`,
      `  provisioning     ${operatorToken ? 'enabled (operator token set)' : 'DISABLED — set GUHBOT_CLOUD_OPERATOR_TOKEN'}`,
      '',
      '  Each tenant has separate data and keys. Shell execution is disabled in the shared gateway.',
      '  Clients connect to ws://<gateway>/t/<tenantId>/rpc?token=<tenant token>.',
      '',
    ].join('\n'),
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(
      `\n  ${signal} received, stopping ${gateway.listTenants().length} tenant host(s).\n`,
    );
    await gateway.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
