<div align="center">
<img src="website/assets/brand/guh.svg" width="96" height="96" alt="Guh Bot" />

# Guh Bot

**A little help. A lot more done.**

An open-source agent host with desktop, web and mobile clients. Run it on your own computer, connect your model or agent CLI, and give each bot a job.

[Self-hosting](#quick-start) · [Architecture](docs/architecture.md) · [Security](SECURITY.md) · [REA research](docs/research-2026-10-17.md) · [AWS deployment](deploy/aws/README.md)

Apache-2.0. No product account is required for self-hosting. Your chosen model provider's fees and limits still apply.
</div>

## Quick start

Use Node.js 24 or 26 and pnpm 11.9.0. The runtime uses built-in `node:sqlite`.

```sh
git clone https://github.com/guhcostan/guhbot.git
cd guhbot
pnpm install --frozen-lockfile
pnpm build:desktop
GUHBOT_ENGINE=codex pnpm --filter @guhbot/desktop start
```

Create a bot with **New bot**, give it instructions, and send a task. The selected CLI must already be installed and signed in. `claude-code` and `opencode` are also supported. If no engine or endpoint is specified, the desktop probes installed CLIs and uses the first available one. A failed CLI login or provider limit is shown as a failed task, not a fabricated response.

To use a model endpoint instead, set `GUHBOT_BASE_URL`, `GUHBOT_MODEL` and, when required, `GUHBOT_API_KEY`. This accepts OpenAI-compatible APIs, including a local model server.

**CLI engines run their own tools under their own permission policies.** The host records their output but does not intercept those tool calls. The built-in API model loop uses the host's tool approval system. Choose the engine's own sandbox settings accordingly.

### Standalone host and web console

```sh
node packages/server/dist/cli.js --engine codex --port 8789 --data-dir ~/.guhbot
pnpm dev:web
```

Open the local URL printed by Vite, choose **Connect a host**, and enter `ws://127.0.0.1:8789/rpc` and the credential from `~/.guhbot/operator.token`. The credential stays in the web window's memory. Remote hosts require `wss://` with a valid certificate. The web and desktop interfaces use the same client and protocol.

### Mobile companion

The mobile source is an Expo / React Native application. Build a native app instead of relying on an older Expo Go installation:

```sh
pnpm --filter @guhbot/mobile ios
# Or, with Android SDK and a device/emulator:
pnpm --filter @guhbot/mobile android
```

On desktop, open **Devices & pairing → Pair a phone**. Scan the QR code with the phone camera or enter the host address, pairing ID and code. Pairing is single-use and expires. A phone starts as a viewer. The operator can explicitly select **Grant operator access** for that device, allowing it to create bots, send tasks and resolve approvals. Tap **Reconnect** on the phone after an access change. A phone cannot grant itself operator access.

A real phone must be able to reach the host. The embedded desktop host and standalone runtime listen on loopback. For a remote desktop companion, configure a loopback sidecar and a TLS proxy:

```sh
GUHBOT_ENGINE=codex \
GUHBOT_COMPANION_PORT=8787 \
GUHBOT_PUBLIC_URL=wss://your-host.example/rpc \
pnpm --filter @guhbot/desktop start
```

Point your TLS reverse proxy at `127.0.0.1:8787`, rewriting its upstream Host header to `127.0.0.1`. The public URL must actually resolve to that proxy. For hosted gateways, the mobile endpoint can include `/t/<tenantId>/rpc`. No tunnel, domain or remote connection is automatically created.

Tokens are stored in the phone keychain. Revocation and access removal are checked by the host on subsequent requests, including existing connections.

### Docker

```sh
cp .env.example .env
# Set a reachable endpoint and the name of a model you have installed.
docker compose up --build -d host
```

The companion is published on **127.0.0.1:8787**. Put a TLS proxy or a private network in front of it for remote access. Host state persists in the `host-data` volume. Container tooling needs a running Docker daemon; provider CLI subscriptions are not automatically copied into a container.

### Site and waitlist

```sh
pnpm dev:site
# http://127.0.0.1:4173
```

The landing page has a scripted product demo, original SVG characters, local Manrope fonts, responsive layouts and a real signup handler. Local signups persist in a private file with serialized, atomic writes. The AWS deployment uses DynamoDB conditional writes for deduplication. No email is sent by a signup.

[Deploy the site and waitlist to AWS](deploy/aws/README.md). The current revision has not been deployed: the local AWS session expired and the operator elected to continue locally.

## Operator-managed hosting

```sh
# Set GUHBOT_CLOUD_OPERATOR_TOKEN to a strong secret before provisioning.
pnpm --filter @guhbot/cloud build
node apps/cloud/dist/cli.js --root ~/.guhbot-cloud --port 8788 \
  --base-url https://your-model-provider.example/v1 --model your-model
```

`POST /tenants` requires the operator's bearer token. It returns a tenant token once and an RPC path `/t/<tenantId>/rpc`. Use that URL and tenant token in **Connect a host**. A cloud client can pair a separate mobile device. Tenant metadata, token hashes, devices and transcripts survive a gateway restart.

Each tenant has separate runtime state, SQLite data and encryption keys. **The gateway shares one OS process. It is not a VM sandbox.** Shell execution is excluded from its model tools. Use a dedicated container/VM per customer before enabling customer-controlled executors. There is no self-service account system, payment collection, subscription billing or production SLA in this release. The waitlist is for the future managed offering.

## What is implemented

| Surface | Current behavior |
|---|---|
| Desktop / web | Create bots, optional per-bot model, chat streaming, Markdown, approval review, cancellation, remote connection, device management and pairing QR |
| Mobile | Pair, view bots and transcripts, reconnect, secure remote URLs, and operator-authorized task/approval controls |
| Runtime | Persistent agents, scoped file tools, tool approvals, encrypted secrets, RPC authorization and recoverable transcripts |
| Optional host capabilities | Browser, MCP, memory, canvas, schedules, webhooks and macOS Messages through the standalone host configuration |
| Hosted gateway | Operator provisioning, tenant-scoped credentials/state, persistent catalog and mobile routing |
| Landing | Scripted interactive examples, SVG art, local fonts, FAQ and persistent waitlist |

This is an independent implementation informed by REA evidence and public product behavior. It does **not** include Grok Bot's proprietary code or assets. Extracted research artifacts stay in ignored `recon/` and are never distributed.

Voice calls, remote desktop/VNC, app-store distribution, signed/notarized installers, full routine recording and multi-agent delegation are not implemented. See [the dated parity report](docs/research-2026-10-17.md) for evidence and limitations. Android source is available; Android device behavior has not been verified in this release.

## Verification and packaging

```sh
pnpm test
pnpm typecheck
pnpm --filter @guhbot/desktop typecheck
pnpm --filter @guhbot/mobile typecheck
pnpm --filter @guhbot/cloud build
pnpm package:desktop
```

`pnpm test` builds packages before running tests. Do not run Vitest against stale `dist` files. GitHub Actions additionally builds the desktop, exports the iOS bundle and builds the Docker image.

The desktop packaging command creates a macOS application for the current architecture under `release/`. It is unsigned and not notarized. Apple signing and app-store distribution require the maintainer's own developer credentials.

See [AGENTS.md](AGENTS.md) and [engineering conventions](docs/engineering.md) before contributing.
