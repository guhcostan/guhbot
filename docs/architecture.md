# Architecture

This document explains the design: what the pieces are, why the seams are where
they are, and how the same codebase serves a self-hosted host and a hosted
service.

For the reverse-engineering study that informed it, see
[`docs/re/00-index.md`](re/00-index.md). For the code conventions, see
[`docs/engineering.md`](engineering.md).

## The shape of the problem

The product is "an agent that works like a coworker". Three requirements follow
from that, and they pull in different directions:

1. **It keeps working when you are not looking.** So the runtime must live
   somewhere durable, not in a UI process that dies with the window.
2. **You can reach it from anywhere, including your phone.** So it must be
   reachable over a network by an untrusted client.
3. **It can do real work: run commands, drive a browser, read your messages.**
   So it holds real authority on a real machine.

(2) and (3) are in direct tension. The resolution is architectural, not
incidental: **separate the runtime from the clients, and classify every operation
by whether it needs a human present.**

## Component map

```
                       ┌──────────────────────────────────────┐
   desktop (Electron)  │  apps/desktop                        │
   ── embedded host ── │  main: bootstraps a host, opens one  │
                       │  hardened window; preload exposes a  │
                       │  connection descriptor, nothing more │
                       └───────────────┬──────────────────────┘
                                       │  ws://127.0.0.1:<port>/rpc
   phone / browser ────────────────────┤
   cloud console   ────────────────────┤  ws://<lan-or-host>:<port>/rpc
                                       │
                       ┌───────────────▼──────────────────────┐
                       │  packages/server                     │
                       │  HostServer: the only socket in the  │
                       │  repository. Framing, auth, pairing, │
                       │  event fan-out.                      │
                       │  GuhbotClient: the shared SDK.       │
                       └───────────────┬──────────────────────┘
                                       │  in-process, typed
                       ┌───────────────▼──────────────────────┐
                       │  packages/host-core                  │
                       │  Host: registry, dispatch, the       │
                       │  authorization decision, runs,       │
                       │  approvals, devices.                 │
                       │  Store: the only writer of SQLite.   │
                       └───────────────┬──────────────────────┘
                                       │  RunExecutor (injected)
                       ┌───────────────▼──────────────────────┐
                       │  packages/agent                      │
                       │  AgentLoop: inference, tool calling, │
                       │  approvals, built-in tools.          │
                       │  Capability seam for everything else. │
                       └──────────────────────────────────────┘
                                       ▲
                                       │  Capability { tools, methods, flags }
              ┌────────────────────────┼────────────────────────┐
              │            │           │          │             │
           browser        mcp        canvas     voice       messages …
```

Layering rule: `protocol` depends on `zod` and nothing else. `host-core` depends
on `protocol`. `agent` depends on both. `server` sits on top. Apps sit on
`server`. **No package reaches upward**, which is why the mobile client can
import `protocol` and `server` without dragging a database or a model client into
its bundle.

## The authorization model

This is the core idea, and it is worth stating precisely.

Every RPC method is declared with an authorization class:

| Class | Count (core) | Meaning | Example |
|---|---|---|---|
| `background` | ~30 | Safe with nobody watching | `transcript.page`, `host.status`, `approvals.list` |
| `person` | ~30 | Needs a human present | `runs.start`, `approvals.resolve`, `secrets.put` |

Enforcement lives in one place, in `Host.dispatch`, and runs in a fixed order:

1. the method exists in the registry — unknown names never reach a handler;
2. the transport is allowed — `localOnly` methods (`pairing.begin`) are refused
   over a socket;
3. the parameters match the declared schema — handlers may trust their input;
4. the authorization class is satisfied;
5. the handler runs;
6. **the output matches its own declared schema.**

Step 6 is unusual and deliberate. A handler that returns the wrong shape is a
bug that would otherwise surface as a confusing client-side parse error; here it
fails loudly at the boundary.

### What makes a device `person`

Presence is a property of the **device**, established when it was created:

- The desktop's embedded host mints itself a `person` device in-process. Anyone
  who can run that code is already the user.
- A `person` device may mint a pairing code for a new device
  (`pairing.beginForDevice`).
- **A device that redeems a pairing code is always `background`**, even if it
  asks for `person`. `claimPairing` downgrades the request rather than honouring
  it, and there is a test asserting exactly that.

There is no per-session "unlocked" flag. An earlier revision had one, and it was
a bug: the flag was only ever set for the in-process channel, so a WebSocket
`person` device was silently treated as lacking presence. Removing state that
must be kept in sync is better than remembering to sync it.

### Why approvals exist

An unattended run will eventually want to do something that should not be
automatic: run a destructive command, send a message as you, spend money. The
run does not guess. It calls `requestApproval`, which writes an `Approval` row and
parks the run in `waiting-approval`. Any client with a pending-approval view
shows it. Resolving it requires `person` class, so a phone can *see* the request
and cannot *grant* it — which is the safe direction for a stolen device.

A denied approval is returned to the model as an ordinary tool result, so the run
learns the call was refused and can choose another path rather than dying.

## Persistence

SQLite through `node:sqlite`. No native module to compile, one file to back up,
identical behaviour on a laptop and in a container.

Properties that the rest of the system relies on:

- **`entries` is append-only with a per-agent monotonic `seq`.** The max+1 read
  and the insert share one `BEGIN IMMEDIATE` transaction, so two concurrent runs
  on one agent cannot produce a duplicate or a gap. Clients resync with
  `afterSeq` and rely on that.
- **Runs left in flight by a previous process are failed at boot** with an
  explicit reason, rather than sitting in `running` forever.
- **Approvals past their deadline resolve to `expired`, never `granted`.**
- **Secret values are sealed with AES-256-GCM** under a `master.key` written with
  mode 0600 and `wx` so two concurrent starts cannot produce two keys, one of
  which would silently fail to decrypt everything the other wrote.

Schema changes go through `Store.migrate`, which refuses to open a database
newer than the build understands rather than corrupting it.

## Transport

One JSON framing over WebSocket:

```
S → C  hello   { protocolVersion, hostVersion, authRequired }
C → S  auth    { token }
S → C  ready   { deviceId, deviceClass }
C → S  req     { id, method, params }          (concurrent, any order)
S → C  res     { id, ok, result | error }
S → C  evt     { event, payload }              (unsolicited)
```

An authenticated session may call anything its class permits. An
**unauthenticated** session may call exactly three methods — `pairing.claim`,
`host.status`, `host.describe` — and that allow-list lives in the transport
rather than the dispatcher, because it is a property of the connection, not of
the method.

Events are advisory. `transcript.delta` is lossy by design; durable entries are
re-readable. That is what lets a phone drop off the network mid-run, reconnect
with backoff, and resync rather than replay.

### Binding

Loopback by default, and there is no flag that widens that bind. Exposing an
agent that runs commands on your machine to your local network is a decision that
gets its own socket rather than a wider one: `--companion` starts a second
listener for paired devices, and the harness itself never opens one. Pairing
always joins as `background`, and a non-loopback companion refuses to start in
plaintext unless you pass `--companion-insecure-plaintext`.

## Self-hosted and hosted from one codebase

The mode is a property of the host, not of the code path:

| | Self-hosted | Hosted |
|---|---|---|
| Where the runtime runs | Your machine | A service you or someone else operates |
| Who holds the data directory | You | The operator |
| Client connection | LAN or tunnel | Public endpoint |
| Pairing | QR / code on your machine | Same protocol; operator may add an account layer in front |
| Isolation | One user | One host process (or container) per tenant |

Nothing in `host-core`, `agent` or `protocol` knows which of these it is in. The
`mode` field exists so a client can *display* it, and so the hosted deployment
can attach per-tenant policy in front of `HostServer` without forking the
runtime. The intended multi-tenant shape is one host process per tenant behind a
gateway that terminates authentication — not a shared process with tenant columns
threaded through the store.

## The capability seam

A capability is a self-contained unit of extra function:

```ts
export interface Capability {
  name: string;
  summary: string;
  flags?: Record<string, boolean>;              // merged into host.status
  tools?: () => ToolDefinition[];               // tools the model can call
  methods?: Record<string, ContributedMethod>;  // RPC methods clients can call
  dispose?: () => Promise<void>;
}
```

Each contributed method carries its own `authz`, schemas and summary, so the
contract is declared where it is defined and cannot be forgotten. The runtime
builds one registry from core handlers plus contributions and **refuses to start
if a capability tries to shadow a core method** — a third-party package must not
be able to redefine `approvals.resolve`.

This seam exists so that adding the browser, MCP, voice or the Messages bridge
never means editing `host-core` or `protocol`. It is what makes parallel
development safe: each capability is its own package with no shared files.

## Security posture

The threat model is: **the model can be manipulated by content it reads, and a
paired device can be stolen.**

| Risk | Mitigation |
|---|---|
| Prompt injection drives a destructive shell command | `run_command` requires approval; no shell, argv array only; per-host deny list |
| Prompt injection reads files outside the project | Every model-supplied path goes through `resolveInside`, which checks the resolved path and the canonical path of the nearest existing ancestor, defeating `..` and symlinks |
| Tool execution leaks credentials to a child process | Child environments are stripped of `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `AWS_*` and friends |
| A stolen phone drains an account | A paired device is always `background`; it can observe and cannot act outward |
| A stolen laptop database yields credentials | Secret values are sealed under a 0600 master key; the wire has no way to read them |
| A renderer compromise reaches the filesystem | `contextIsolation` + `sandbox` + `nodeIntegration: false`; the renderer gets a connection descriptor, and a CSP with no inline or remote script |
| An agent exfiltrates via the network | Egress defaults to **deny all**; `http_fetch` and browser navigation reach only configured hosts |
| A malicious MCP server achieves code execution | stdio transport requires an explicit `allowStdio` opt-in; tool calls require approval |
| A capability widens the API | Contributions are schema-validated and collision-checked at start |

Two things are deliberately *absent* rather than implemented badly: there is no
`secrets.get` RPC method, and there is no way for a remote device to promote
itself to `person`.

## Repository conventions that matter

- Tests resolve workspace packages through built `dist`, so `pnpm test` builds
  first. Running vitest alone can silently test stale code.
- `@guhbot/protocol` must never gain a Node-only import; the mobile client
  depends on it.
- New durable state means a new table and a method on `Store`. Nothing else
  writes SQL.
- New RPC methods get an honest `authz` class. If in doubt, `person`.

## Status

| Area | State | Verified by |
|---|---|---|
| Protocol contract | Done | Registry integrity test; `host.describe` |
| Host runtime, authorization | Done | 19 tests incl. the person/background boundary |
| Pairing and device lifecycle | Done | Single-use, rate-limited, hash-only storage, downgrade test |
| Transcript sequence and resync | Done | Contiguity, gap-free `afterSeq`, concurrency test |
| Secret sealing | Done | Ciphertext-on-disk and no-value-on-wire tests |
| Agent loop, tool calling, approvals | Done | 24 scripted-provider tests, plus 4 against a live model |
| OpenAI-compatible adapter | Done | 16 tests against a real SSE server, plus live traffic |
| WebSocket transport, event fan-out | Done | 9 end-to-end tests over a real socket |
| Built-in tools (fs, command, fetch) | Done | Path-jail, symlink, deny-list, no-shell tests |
| Desktop shell | Code complete | Bootstrap tested; GUI not launched in this environment |
| Browser capability | In progress | — |
| MCP capability | In progress | — |
| Mobile client | In progress | — |
| Canvas / artifacts | Not started | — |
| Voice | Not started | — |
| Remote desktop | Not started | — |
| macOS Messages bridge | In progress | — |
| Hosted multi-tenant service | Not started | — |

### Known gaps

- ~~No live model has been called.~~ **Closed.** `packages/server/tests/live-model.test.ts`
  runs the whole stack against a real OpenAI-compatible model
  (`deepseek-v4.1-flash` via `opencode-go`): a plain question, a filesystem read
  answered through a `read_file` tool call, a file written to disk through an
  approved `write_file`, and an attempt to read `/etc/passwd` refused by the jail.
  It skips itself when no credentials are present, so CI stays hermetic.
- **The desktop window has not been launched.** Typecheck passes and the host
  bootstrap is tested; the Electron GUI itself is unverified here.
- Tool approval is all-or-nothing: a tool either always needs a human or never
  does. Per-argument policy (for example, allow `git status` but not
  `git push --force`) is the obvious next step.
- The transcript is replayed into every run up to a fixed entry count. There is
  no summarisation and no token accounting, so a long conversation will
  eventually be truncated by the provider rather than compacted.
