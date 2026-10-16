<div align="center">

# guhbot

**The agent host you can actually leave running.**

An open-source agent host that runs on your own machine. Agents do real work with
your files, your shell and your browser — and every operation they can perform is
classified by whether it needs a human present.

[![License](https://img.shields.io/badge/license-Apache--2.0-67e8a2?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-841%20passing-67e8a2?style=flat-square)](#testing)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#quick-start)

[Website](https://d1490grrgfw1sj.cloudfront.net) · [Security](SECURITY.md) · [Architecture](docs/architecture.md) · [Reverse-engineering dossier](docs/re/00-index.md)

</div>

---

## Why this exists

Everyone is shipping agents that log into your tools and act on your behalf. That
is genuinely useful, and it is also a new class of risk: you are handing a program
your sessions, your inbox, and your ability to spend money. Then you make it
reachable from your phone — so anything reachable from the phone is reachable by
whoever holds the phone.

Most products answer that with a paragraph in their terms of service. guhbot
answers it in the architecture, and the architecture is the part you can read.

## The idea, in one table

Every method the host exposes is declared as one of two things, and the host
enforces which one a caller may use. It is not a client-side check and it is not a
setting you can flip.

| | `background` | `person` |
|---|---|---|
| **Means** | Safe with nobody watching | Needs a human present |
| **Examples** | Read the transcript, check status, list tools, see pending approvals | Send a prompt, resolve an approval, write a secret, create an agent |
| **A paired phone** | Allowed | **Always refused** |

A device that redeems a pairing code joins as `background` even when it asks for
`person`. It cannot promote itself, because the code path that would do it does
not exist. The consequence is the property that matters:

> A stolen phone can read your transcripts. It cannot send a message as you, spend
> a dollar, or approve its own request.

An agent that wants to do something outside that boundary does not guess. The run
parks in `waiting-approval`, your phone shows you the request, and you resolve it
where you are.

## What it can do

Each capability is a package with its own tests and its own refusal paths.
Nothing reaches the network unless you configured what it may reach.

| Capability | State | Notes |
|---|---|---|
| Engines | ✅ | Drive Claude Code, Codex or OpenCode you already pay for, or any OpenAI-compatible endpoint. `--list-engines` probes and reports honestly, including a rate limit |
| Files and commands | ✅ | One workspace jail, symlink-safe; no shell, so metacharacters stay literal; children never inherit your API keys |
| Secrets | ✅ | AES-256-GCM under a `0600` key file; there is deliberately no `secrets.get` on the wire |
| Agent loop | ✅ | Streaming inference, tool calling, approval escalation, turn and tool-call budgets |
| MCP | ✅ | stdio, streamable HTTP and SSE; per-server tool namespacing; stdio needs an explicit opt-in |
| Browser | ✅ | Real Chromium, throwaway profile, egress denied by default and re-checked on every redirect |
| macOS Messages | ✅ | Read-only handle on `chat.db`, opt-in per conversation, sends always approved |
| Desktop app | ✅ | Electron shell with an embedded host, hardened window, no remote script |
| Canvas | ✅ | Model-authored HTML, content-addressed, own CSP, frame with no same-origin access |
| Automations | ✅ | Cron with DST handled, webhooks with sealed revocable secrets, coalesced catch-up |
| Agent memory | ✅ | Short facts an agent writes down and recalls later. Per-agent, capped, ranked by use, and readable and deletable by the human |
| Site credentials | ⚠️ | Per-origin approval, sealed at rest, released only from inside a tool execution. The vault is mounted and tested; the browser does not consume it yet |
| Reachable from a phone | ✅ | `--companion` binds the network; the runtime itself never opens a socket |
| Mobile app | ⚠️ | Complete and typechecked; the React Native bundle has not been run on a device |
| Voice | ❌ | Not built |
| Remote desktop | ❌ | Not built |
| Hosted service | ⚠️ | Gateway, tenant isolation and waitlist are built and deployed; **not for sale** (no billing yet) |

## Quick start

Node 22.5 or newer (24+ recommended). There is no native module to compile —
persistence uses the built-in `node:sqlite`.

```bash
git clone https://github.com/guhcostan/guhbot
cd guhbot
pnpm install
pnpm build
pnpm test
```

Run a host on this machine only:

```bash
node packages/server/dist/cli.js --data-dir ~/.guhbot
```

Run one your phone can reach, with a model. The host itself stays on loopback;
`--companion` adds a second, separate socket for paired devices:

```bash
export GUHBOT_API_KEY=sk-...
node packages/server/dist/cli.js \
  --companion \
  --workspace ~/work \
  --base-url https://api.openai.com/v1 \
  --model gpt-4o-mini
```

Any OpenAI-compatible endpoint works — OpenAI, Groq, Together, DeepSeek, Ollama,
vLLM, LM Studio, or a gateway. `--session-header <name>` covers gateways that
require a per-request session id.

The first start writes an operator token to `<data-dir>/operator.token` with mode
`0600`. That is the terminal's `person`-class credential; without it a host on
your own machine could only be observed, never driven. Press Enter on the console
to mint a pairing code for a phone, or start with `--companion` and scan the
printed `guhbot://pair?…` URI.

The companion binds a network socket, so it refuses to start in plaintext on a
non-loopback address unless you pass `--companion-insecure-plaintext` and mean
it. Pairing always joins as `background`: a phone can watch and ask, and cannot
act outward.

### Mounting capabilities

```bash
# Browser, reachable only where you say
--browser-hosts example.com,docs.example.com --search-url 'http://localhost:8888/search?q={query}'

# MCP servers, in the shape every MCP client uses
--mcp-config ./mcp.json --mcp-allow-stdio

# iMessage, only for the conversations you name
--messages-allow '+15551234567,team@example.com'
```

Each of these is off until configured, and `host.status` reports which ones are
real so a client can tell you rather than the agent failing mysteriously.

## Architecture

```
apps/desktop        Electron client with an embedded host
apps/mobile         React Native client            ─┐
apps/cloud          Hosted gateway, one host per   ─┼─ speak @guhbot/protocol over
                    tenant, plus the waitlist       ┘   WebSocket to a host
                                                          │
packages/server     HostServer + GuhbotClient ────────────┤  the only thing that binds a socket
packages/host-core  Runtime, store, authorization, approvals
packages/agent      Model loop, providers, tools, capabilities
packages/protocol   The wire contract. Depends on zod and nothing else.
```

Four rules hold it together:

1. **`@guhbot/protocol` depends only on `zod`.** The mobile client imports it, so
   a Node-only import there would break the phone build.
2. **Only `@guhbot/server` binds a socket.** A capability that wants to be
   reachable exposes a tool or a method, never its own listener.
3. **`@guhbot/host-core` owns every durable write.** Nothing else opens the
   database.
4. **Capabilities compose; they do not patch the runtime.** A capability
   contributes tools, methods and status flags through one interface, and the
   runtime refuses to start if one tries to shadow a core method.

The desktop is deliberately *not* special. Its renderer connects to its own host
over a loopback WebSocket, exactly as a phone does, so the two clients cannot
drift apart and a renderer compromise has the same reach as a remote device
rather than more. See [docs/architecture.md](docs/architecture.md).

## Security

The threat model has two adversaries: **content the model reads** (a web page, an
email, an MCP tool description), and **a stolen paired device**. The design
assumes the model *will* be hijacked and asks what the worst outcome is.

Each of these is a test, not a promise:

| Invariant | Test |
|---|---|
| A `background` device cannot resolve an approval | `packages/host-core/tests/host.test.ts` |
| A paired device joins as `background` even when it asks for `person` | `packages/host-core`, `apps/desktop` |
| A secret value never appears in a protocol response | `packages/host-core/tests/host.test.ts` |
| A model-supplied path cannot escape the workspace, symlinks included | `packages/agent`, `packages/server` |
| A command runs with no shell, so metacharacters stay literal | `packages/agent/tests/loop.test.ts` |
| Egress is denied unless a host is explicitly allowed | `packages/agent`, `packages/browser` |
| A capability cannot shadow a core method | `apps/desktop/tests/bootstrap.test.ts` |
| An approval past its deadline resolves to `expired`, never `granted` | `packages/host-core` |

Known limitations are listed in [SECURITY.md](SECURITY.md), including the ones we
have not solved: approval is per-tool rather than per-argument, transcripts are
stored unencrypted, and there is no cost budget per agent.

## Testing

```bash
pnpm test
```

**841 tests** across 55 files, concentrating on properties that would be dangerous
to get wrong rather than on coverage. Four more run against a live model when
credentials are present.

The suite is deterministic on purpose. Anything that needs the network lives in a
`*.live.test.ts` file and is excluded from the default run, because a provider
that is slow or declines to call a tool is not a signal about this code.

`pnpm test` builds first. Tests resolve workspace packages through their built
`dist`, so running vitest alone can silently test stale code.

### Verified against a live model

`packages/server/tests/live-model.test.ts` drives the real host, real tools and a
real client against a live model. It skips itself unless credentials are present,
so CI stays hermetic.

```bash
GUHBOT_TEST_BASE_URL=... GUHBOT_TEST_API_KEY=... GUHBOT_TEST_MODEL=... \
  pnpm vitest run packages/server/tests/live-model.test.ts
```

It asserts the model calls a tool rather than guessing, writes a file through an
approved tool call and the bytes reach disk, and is refused when it tries to read
`/etc/passwd`.

## Reverse-engineering study

This implementation began as a study of a commercial product in this space. That
work is in [docs/re/](docs/re/00-index.md): what the reference product does, how
confident each claim is, and — just as importantly — where the evidence runs out.
Every claim is marked `PROVEN`, `INFERRED` or `UNKNOWN` with a `file:line`
citation.

That study is **not** the source. No code, asset, font or string from the
reference application appears in this repository, and `recon/` (which holds
extracted artifacts) is git-ignored and must never be published. What we took was
behaviour and interface shape, which is what interoperability work has always
relied on.

The most useful thing the study produced was the `person` / `background`
distinction. Reusing those names here was a design decision, not a copy: the
reference uses them for a different mechanism, and
[docs/re/00-index.md](docs/re/00-index.md) says so explicitly.

## The hosted service

The site and the waitlist are deployed and live at
**[d1490grrgfw1sj.cloudfront.net](https://d1490grrgfw1sj.cloudfront.net)**. A
private S3 bucket behind CloudFront, one Lambda, one DynamoDB table, and no
always-on server, because there is nothing yet that needs one.

**It is not for sale, and there is no billing.** Leaving an address adds it to the
waitlist and nothing else. We are finding out whether anyone wants this before
building the part that takes money, rather than the other way round.

The hosted *agent* service (one isolated host per account) is built and tested but
deliberately switched off: provisioning requires an operator token that is not
configured in the deployment, so nobody can create a tenant on it yet.

## Contributing

[`docs/engineering.md`](docs/engineering.md) is the contract: conventions, the
capability seam, and the security posture every new capability is expected to
honour. New tools that touch the filesystem, the network or a credential need a
refusal test.

## Licence

[Apache-2.0](LICENSE).

guhbot is an independent project. It is not affiliated with, endorsed by, or
sponsored by xAI, Anysphere, or any other vendor mentioned in the documentation.
Product names are used only to describe what was studied.
