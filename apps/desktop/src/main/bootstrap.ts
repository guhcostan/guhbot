/**
 * Bootstrap the embedded host.
 *
 * Deliberately free of Electron imports so it can be tested in plain Node. The
 * Electron main process is a thin shell over this file.
 *
 * ## How the desktop client reaches its own host
 *
 * The host listens on loopback and the renderer connects to it over a WebSocket,
 * exactly as a phone would. That is a deliberate choice, not an accident:
 *
 *  - one client code path for desktop and mobile, so they cannot drift;
 *  - the renderer never gets `nodeIntegration`, so a compromised page has the
 *    same reach as a remote client, not more;
 *  - the host can later be moved to another machine without touching the UI.
 *
 * The desktop differs from a phone in exactly one respect: it is handed a
 * `person`-class device token. The token is minted in-process and passed to the
 * renderer through the preload bridge. It never travels over the network, so
 * possessing it is equivalent to being at the machine.
 */
import { AgentLoop, OpenAiCompatibleProvider, builtinTools, collectContributions, type Capability } from '@guhbot/agent';
import { Host } from '@guhbot/host-core';
import { HostServer } from '@guhbot/server';
import { hashToken, newToken } from '@guhbot/host-core';

export interface BootstrapOptions {
  dataDir: string;
  version: string;
  /** Extra capabilities to mount, e.g. the browser and MCP packages. */
  capabilities?: Capability[];
  /** OpenAI-compatible base URL. When absent the host reports inferenceReady: false. */
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  /** Working directory handed to filesystem-scoped tools. */
  cwd: string;
  /** Hosts agent tools may reach. Empty means no network egress. */
  allowedHosts?: string[];
  /** Fixed port, mainly for tests. Defaults to an ephemeral port. */
  port?: number;
  /** Bind to the LAN as well, so a phone can pair without restarting. */
  lan?: boolean;
  mode?: 'self-hosted' | 'hosted';
}

export interface BootstrapResult {
  host: Host;
  server: HostServer;
  /** Loopback URL the renderer should connect to. */
  hostUrl: string;
  /** Person-class token for the embedded renderer. Treat as a credential. */
  rendererToken: string;
  rendererDeviceId: string;
  port: number;
  close: () => Promise<void>;
}

export async function bootstrapHost(options: BootstrapOptions): Promise<BootstrapResult> {
  const capabilities = options.capabilities ?? [];
  const { tools: capabilityTools, extraMethods, flags } = collectContributions(capabilities);

  const provider =
    options.baseUrl !== undefined
      ? new OpenAiCompatibleProvider({
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          ...(options.model !== undefined ? { defaultModel: options.model } : {}),
        })
      : null;

  const host = new Host({
    dataDir: options.dataDir,
    version: options.version,
    mode: options.mode ?? 'self-hosted',
    capabilities: {
      exec: true,
      filesystem: true,
      browser: false,
      voice: false,
      messages: false,
      vnc: false,
      egress: (options.allowedHosts ?? []).length > 0,
      // Whatever the mounted capabilities declare wins over the defaults above,
      // so a client is told what this build can really do.
      ...flags,
    },
    ...(provider
      ? {
          executor: new AgentLoop({
            provider,
            tools: [...builtinTools({ allowedHosts: options.allowedHosts ?? [] }), ...capabilityTools],
            cwd: options.cwd,
          }),
        }
      : {}),
    ...(Object.keys(extraMethods).length > 0 ? { extraMethods } : {}),
  });

  const server = new HostServer({
    host,
    ...(options.port !== undefined ? { port: options.port } : {}),
    lan: options.lan ?? false,
  });
  const { port } = await server.listen();

  // Mint the renderer's own person-class device. This is the one place a device
  // is created without the pairing flow, and it is legitimate because this code
  // is already running as the user on the host.
  const token = newToken();
  const { createHash } = await import('node:crypto');
  const salt = createHash('sha256').update(`renderer:${host.hostId}`).digest();
  const device = host.store.createDevice({
    name: 'This computer',
    platform: 'desktop',
    deviceClass: 'person',
    tokenSalt: salt,
    tokenHash: hashToken(token, salt),
  });
  // Sanity check: the token we are about to hand the renderer must actually
  // authenticate, or the app would start with a dead connection.
  const verified = host.authenticate(token);
  if (verified === null) {
    throw new Error('bootstrap minted a renderer device whose token does not authenticate');
  }

  return {
    host,
    server,
    hostUrl: `ws://127.0.0.1:${port}/rpc`,
    rendererToken: token,
    rendererDeviceId: device.id,
    port,
    close: async () => {
      await server.close();
      for (const capability of capabilities) {
        await capability.dispose?.().catch(() => {
          /* a failing dispose must not block shutdown */
        });
      }
      await host.close('desktop quit');
    },
  };
}
