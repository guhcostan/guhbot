#!/usr/bin/env node
/**
 * `guhbot-companion` — run the network-facing sidecar.
 *
 * Configuration is flags plus environment, like `guhbot-host`: the process is
 * meant to be startable from a systemd unit, a container entrypoint or a
 * `docker run`, and flags are easier to review than a config file discovered from
 * somewhere.
 *
 * The one thing this CLI cannot do for you is verify device tokens, and it says so
 * instead of starting anyway. Tokens live in the harness, and the protocol has no
 * method that lets another process check one (`verify.ts` explains why that is
 * deliberate). `--verify-module` is the escape hatch for a standalone process;
 * an embedding launch uses `createHostVerifyToken(host)` directly.
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompanionConfigError, createCompanion, isLoopbackAddress } from './index.js';
import type { VerifyToken } from './verify.js';

const VERSION = '0.1.0';

const HELP = `guhbot-companion — the only guhbot process that binds a network interface

  The harness binds 127.0.0.1 and nothing else: it runs commands, holds your
  credentials and reads your files, and never opens a socket a phone can reach.
  This companion is the opposite: it binds the network, decides who may connect,
  and forwards to the harness over loopback with the Host header it requires.

Usage:
  guhbot-companion --harness 127.0.0.1:<port> [options]

Options:
  --harness <host:port>             The loopback harness to front (required)
  --host <address>                  Interface to bind (default 0.0.0.0)
  --port <n>                        Port to bind (default 8787; 0 = ephemeral)
  --insecure-plaintext              Acknowledge that device tokens cross the
                                    network unencrypted. Required unless --host is
                                    a loopback address.
  --verify-module <path>            Module exporting verifyToken(token) that
                                    resolves a device token to an identity
  --no-pairing                      Refuse connections that present no device
                                    token (disables pairing through the network)
  --max-connections-per-device <n>  Connection attempts per device per window (default 10)
  --max-requests-per-device <n>     Requests per device per window (default 300)
  --rate-window-ms <n>              Window those limits are measured over (default 60000)
  --allowed-host <name>             Extra hostname to answer for (repeatable).
                                    IP literals and localhost are always accepted.
  --redact-path <path>              Filesystem prefix to strip from responses,
                                    e.g. the host's data directory (repeatable)
  --identity-salt <value>           Salt for the host-id pseudonym, so two
                                    deployments do not agree on one value
  -h, --help                        This text

TLS is the deployment's job. The shape that needs no acknowledgement is a TLS
terminator on this machine (Caddy, nginx, tailscale serve) forwarding to a
companion bound to --host 127.0.0.1.
`;

function configError(message: string): CompanionConfigError {
  return new CompanionConfigError(message);
}

function parseCount(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw configError(`${flag} expects a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseHarness(value: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value.trim());
  const host = match?.[1] ?? match?.[2];
  const port = match?.[3];
  if (host === undefined || port === undefined) {
    throw configError(`--harness expects host:port, got ${JSON.stringify(value)}`);
  }
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    throw configError(`--harness port must be 1-65535, got ${JSON.stringify(port)}`);
  }
  return { host, port: parsedPort };
}

/**
 * Load a verifier from a module path.
 *
 * The module boundary is not typed, so this is the one place in the package that
 * asserts a type: everything after it is checked.
 */
async function loadVerifier(spec: string): Promise<VerifyToken> {
  const modulePath = pathToFileURL(resolve(spec)).href;
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(modulePath)) as Record<string, unknown>;
  } catch (error) {
    throw configError(`could not import --verify-module ${spec}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidate = typeof loaded['verifyToken'] === 'function' ? loaded['verifyToken'] : loaded['default'];
  if (typeof candidate !== 'function') {
    throw configError(
      `--verify-module ${spec} must export verifyToken(token) (or a default export that is that function)`,
    );
  }
  return candidate as VerifyToken;
}

function missingVerifier(): CompanionConfigError {
  return configError(
    'no device-token verifier is configured, and this companion will not start without one.\n' +
      '  Device tokens live in the harness, and the protocol has no method that lets another\n' +
      '  process check one, so the check has to be connected by the deployment:\n\n' +
      '    * in the same process as the host:\n' +
      '        createCompanion({ verifyToken: createHostVerifyToken(host), ... })\n' +
      '    * as a standalone process, pointing at your own verifier:\n' +
      '        guhbot-companion --harness 127.0.0.1:<port> --verify-module ./my-verifier.mjs\n\n' +
      '  Starting without one would forward every token to the harness unchecked, which is\n' +
      '  the one thing this process exists to prevent.',
  );
}

async function main(): Promise<number | null> {
  const { values } = parseArgs({
    options: {
      harness: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'insecure-plaintext': { type: 'boolean', default: false },
      'verify-module': { type: 'string' },
      'no-pairing': { type: 'boolean', default: false },
      'max-connections-per-device': { type: 'string' },
      'max-requests-per-device': { type: 'string' },
      'rate-window-ms': { type: 'string' },
      'allowed-host': { type: 'string', multiple: true },
      'redact-path': { type: 'string', multiple: true },
      'identity-salt': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.harness === undefined) {
    process.stderr.write(`fatal: --harness <host:port> is required\n\n${HELP}`);
    return 2;
  }

  const harness = parseHarness(values.harness);
  const bindHost = values.host ?? '0.0.0.0';
  const bindPort = parseCount(values.port, '--port', 8787);
  const verifyToken = values['verify-module'] !== undefined ? await loadVerifier(values['verify-module']) : null;
  if (verifyToken === null) throw missingVerifier();

  const companion = createCompanion({
    harness,
    verifyToken,
    host: bindHost,
    port: bindPort,
    insecurePlaintext: values['insecure-plaintext'],
    allowPairing: !values['no-pairing'],
    ...(values['allowed-host'] !== undefined ? { allowedHosts: values['allowed-host'] } : {}),
    ...(values['redact-path'] !== undefined ? { redactPaths: values['redact-path'] } : {}),
    ...(values['identity-salt'] !== undefined ? { identitySalt: values['identity-salt'] } : {}),
    rateLimit: {
      maxConnectionsPerDevice: parseCount(values['max-connections-per-device'], '--max-connections-per-device', 10),
      maxRequestsPerDevice: parseCount(values['max-requests-per-device'], '--max-requests-per-device', 300),
      windowMs: parseCount(values['rate-window-ms'], '--rate-window-ms', 60_000),
    },
  });

  const { port, addresses } = await companion.listen();
  const plaintext = !isLoopbackAddress(bindHost);
  process.stdout.write(
    [
      '',
      `  guhbot companion ${VERSION}`,
      '',
      `  listening     http://${bindHost}:${port}   (the network side)`,
      `  harness       ws://${harness.host}:${harness.port}/rpc   (loopback only)`,
      `  phones use    ${addresses.map((a) => `${a}:${port}`).join('  ')}`,
      `  pairing       ${values['no-pairing'] ? 'refused: a device token is required' : 'open to pairing.claim only'}`,
      `  limits        ${values['max-connections-per-device'] ?? '10'} connections and ` +
        `${values['max-requests-per-device'] ?? '300'} requests per device per ` +
        `${values['rate-window-ms'] ?? '60000'}ms`,
      '',
      ...(plaintext
        ? [
            '  PLAINTEXT. Device tokens cross this network unencrypted: anyone who can read',
            '  the link can act as any paired device. Put a TLS terminator in front of this',
            '  port, or keep this on a network you control.',
            '',
          ]
        : []),
    ].join('\n'),
  );

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n  ${signal} received, shutting down.\n`);
    void companion.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return null;
}

main()
  .then((code) => {
    // A null code means the companion is running: the process stays up until a
    // signal, and the event loop is held by the listening socket.
    if (code !== null) process.exit(code);
  })
  .catch((error: unknown) => {
    if (error instanceof CompanionConfigError) {
      process.stderr.write(`fatal: ${error.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
