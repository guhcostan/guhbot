# Reverse-engineering dossier: Grok Bot

This directory records what was learned about the reference product and, just as
importantly, how confident each statement is. It exists to support a
**clean-room reimplementation**: nothing here is copied code, and the resulting
repository does not redistribute anything from the original application.

## Targets

| | Desktop | Mobile |
|---|---|---|
| Name | Grok Bot | Grok Bot |
| Bundle id | `com.anysphere.sand` | `co.anysphere.sand` |
| Version analysed | 0.71.2 (built 2026-10-14) | 1.14.0 (released 2026-10-06) |
| Runtime | Electron 33, `app.asar` 43.8 MB, 668 files | native iOS, 85.3 MB, min iOS 18 |
| Publisher | SpaceXAI / Anysphere (`homepage: https://cursor.com`) | X Corp. |
| Internal codename | `sand` | `sand` |
| URL schemes | `grokbot`, `sand` | — |

The two share a bundle-id namespace, which is what establishes that they are one
product with two clients rather than two products.

## Method

1. **Static reconstruction with REA** (`rea-agents` 6.5.0, MIT).
   `rea analyze-javascript-application` over the extracted bundle produced a
   sealed Evidence artifact: 594 parsed JavaScript files, 6,067,269 AST nodes,
   14,806 findings, a 6,489-node application graph with 16,150 edges, and 0
   integrity contradictions against the declared `ElectronAsarIntegrity` hash.
2. **Boundary projection** from that evidence: IPC channels, contextBridge APIs,
   BrowserWindows and their `webPreferences`, native addons, workers, endpoints.
3. **String-surface mining** of the main-process bundles, because minified code
   still carries its literals. This is what surfaced the coordinator's method
   table and the backend endpoints.
4. **Targeted deep dives**, one per subsystem, each required to mark every claim
   `PROVEN` / `INFERRED` / `UNKNOWN` with a `file:line` citation.
5. **Mobile client**: App Store metadata and assets only. No IPA was obtained or
   analysed — see "What was not done" below.

## Evidence artifacts

| Artifact | What it is |
|---|---|
| `recon/rea/js-application.json` | 150 MB sealed REA Evidence, `evidence_id ev_77595523d645…` |
| `recon/rea/projection-boundaries.json` | Electron boundaries flattened from the observations |
| `recon/rea/coordinator-methods.json` | **172 coordinator RPC methods with their authorization class** |
| `recon/FINDINGS.md` | Working notes, plus errata and corrections |
| `recon/beautified/` | Prettier-formatted copies of the main-process bundles |
| `docs/re/0*.md` | The subsystem dossiers |

`recon/` is git-ignored. It contains extracted proprietary artifacts and must
never be committed, published, or shipped. Regenerate it locally from a copy of
the application you are licensed to inspect.

## The single most important finding

**The desktop app is a host, and the phone is a client of it.**

The bundle ships `dist/node-agent-coordinator/main.cjs`, which exposes an
agent-runtime RPC surface of 172 methods. It is a `utilityProcess` talking to the
renderer over **MessagePort**, not a socket: three `MessageChannelMain` ports are
transferred in one bootstrap message, and the renderer claims its port through
`sand:coordinator-port-request` → `webContents.postMessage("sand:coordinator-port", null, [port])`.
The bundle contains no `createServer`, no `listen(`, and no `net` or WebSocket
server. An earlier revision of this document described a loopback port; that was
wrong and is corrected here.

> **On the two authorization classes.** In the reference product, `person` /
> `background` is *box-wake authority*: "may this call be the reason the machine
> wakes?" A `background` call is refused while the box is parked; a `person` call
> wakes it. It is not authentication. This project reuses the same two names for a
> different property — whether a device may act without a human present — because
> that is the property a self-hosted host reachable from a phone actually needs.
> The classifications agree in practice (no `background` method in the reference
> creates, deletes, sends, pays, installs or publishes), but the mechanism is a
> deliberate divergence and should not be read as a reproduction.

The coordinator exposes **172 methods**, and every one of them is tagged with an
authorization class:

- **`background` (36)** — safe to run with nobody watching.
- **`person` (136)** — requires a human to be present.

That single distinction is the whole safety story of an always-on agent that you
can also message from your phone, and it is the idea this project adopted
directly. It also explains the product's own wording: an agent "only comes back
when your approval is needed" is a `person` method being raised from a
`background` run.

Supporting evidence that the desktop is the host: the coordinator exposes
`getHostSettings`, `setHostSettings`, `updateHostNow` and `getHostStatus`, and
the desktop drives a `Forever Box` (`ensureForeverBox`, `handBackForeverBox`) —
an always-on machine the agent keeps working on.

## What the reference product does, by subsystem

Full detail lives in the per-subsystem files; this is the map.

| Capability | How the reference product does it | Confidence |
|---|---|---|
| Agent runtime | Coordinator RPC server; 172 methods; `person`/`background` authorization | PROVEN |
| Renderer API | One data-declared RPC edge of 308 methods behind `contextBridge` | PROVEN |
| Local execution | `local-exec-daemon` as an Electron `utilityProcess`, allow/deny rule lists | PROVEN (policy precedence UNKNOWN) |
| Web automation | **No CDP/Playwright.** An in-app `<webview>`, a remote VM desktop over noVNC, and a macOS `computer_use_*` tool surface. Cookie injection + WebAuthn via signed native helpers | PROVEN |
| Canvas / artifacts | Six privileged schemes, **no `bypassCSP`**, iframe sandbox without `allow-same-origin`, sub-second user-gesture link gate | PROVEN |
| MCP | Three transports (stdio/http/sse); **MCP Apps** in a `sand-mcp-app:` iframe, gated off by default, with a `userActivated` check before any tool call | PROVEN |
| Voice | A **WebSocket to `wss://api.x.ai/`** (no WebRTC anywhere); harness service `aiserver.v1.GrokBotService/VoiceCallHarness{Session,Tool}` | PROVEN |
| macOS Messages | A dedicated worker reading `chat.db`, with a grant/approval flow | PROVEN |
| Remote desktop | A VNC client preload with liveness/interactive/host-key channels | PROVEN |
| Mobile | App Store metadata: multi-bot threads, teach-once routines, approval gates | From published description only |

## Corroboration

The App Store description independently describes three behaviours that the
desktop bundle's method names predict:

- "Show a bot how it's done … saves the steps as a routine" ↔ `startTeachRecording`, `stopTeachRecording`, `getTeachRecordingStatus`
- "Put a few Bots in the same thread and they pass work between themselves" ↔ `createGroup`, `setGroupMembers`
- "only comes back when your approval is needed" ↔ the `person`/`background` split, `approvals.resolve`

Two independent sources agreeing is the strongest evidence in this dossier.

## Limitations — read these before trusting a number

1. **REA coverage is `partial`, not complete.** 528 of 596 JavaScript files
   parsed completely; 62 were partial and 4 failed outright, including the
   renderer's main entry chunk. The semantic graph is truncated at its exact
   40,000-node ceiling, so it is not a complete call graph, and the absence of a
   finding is not evidence of absence.
2. **`dist/electron-main/main-app.cjs` (2.6 MB) exceeded REA's recursion budget**
   ("Maximum call stack size exceeded"). The largest and most interesting bundle
   is the least analysed. Anything about main-process behaviour outside the
   string surface is under-evidenced.
3. **No source maps ship.** Every bundle is minified production output. Minifier
   identifiers such as `t.createKey` are not real API names.
4. **A 1 MiB string-byte budget was exceeded**, so some string details were
   truncated in the evidence.
5. **Extractor errata.** The first extraction pass was shifted by 2 bytes per
   file because the asar header is padded to a 4-byte boundary. It has been
   fixed and everything regenerated, but line numbers cited in the dossiers may
   be off by one and first-line columns by two. See `FINDINGS.md` §E1.
6. **Structural claims about `webPreferences` are weaker than they look.** REA
   reports some values as `{"status":"dynamic"}`. For booleans the literal is
   present and decodable; for `preload` and `additionalArguments` it is genuine
   non-resolution. Electron's defaults must not be inferred from omission.

## What was not done

- **No IPA was obtained, decrypted, or analysed.** The mobile app was described
  from its public App Store listing and assets only. No reverse engineering of
  the binary was performed, and none is recorded here. The integration protocol
  for the phone was derived from the *host* side, which is the authoritative
  half: the host defines what a client may call.
- **No network traffic was intercepted.** Endpoints were read from bundle
  literals, not observed live.
- **Nothing was executed from the analysed bundles.** All JavaScript and HTML was
  parsed as inert text; the bundle bootstrap was never run.

## Legal and ethical posture

The reference application is proprietary. This repository reproduces **no** code,
asset, font, icon or string from it. What it reproduces is **behaviour and
interface shape**, which is what interoperability work has always relied on.

Concretely, for anyone extending this:

- Do not commit anything under `recon/`. It is git-ignored, and that is not a
  formality.
- Do not lift code, prompts, or assets out of the dossiers into `packages/` or
  `apps/`. The dossiers describe behaviour so that it can be reimplemented, not
  so that it can be transcribed.
- Do not use this project to reach services you are not authorised to use. The
  backend host literals appearing in the dossiers are recorded as findings, not
  as supported endpoints, and nothing in this repository talks to them.

The point of the exercise is a self-hostable agent host of our own, not a
replica of somebody else's backend.
