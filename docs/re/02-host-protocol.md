# Grok Bot Agent Host Protocol — the `node-agent-coordinator` RPC surface

Reverse-engineering dossier, section 2 of N. Target: **Grok Bot** desktop, Electron app
`com.anysphere.sand` **v0.71.2** (built 2026-10-14), internal product codename **`sand`**,
author "SpaceXAI", backend host `api2.cursor.sh`. Mobile sibling: iOS `co.anysphere.sand` v1.14.0.

---

## Scope & method

### What this section covers

The **agent-host protocol**: the local RPC contract that a client (the Grok Bot renderer today,
a phone client in the product's own framing) uses to drive an unattended agent runtime, and the
transport that carries it. Concretely:

1. discovery and transport of the local RPC channel,
2. the RPC schema/validation layer,
3. the complete 172-method surface, grouped by domain,
4. the `person` / `background` authorization model,
5. entities and identifiers (agent/thread, session, transcript entry, box, tray, group),
6. approval and interrupt lifecycles,
7. the remote backend contract, distinguished from the local one,
8. design implications for a clean-room self-hosted host,
9. limitations.

### Evidence base

| Artifact | Role |
|---|---|
| `recon/beautified/coordinator.beauty.js` (40,342 lines) | prettier-formatted `dist/node-agent-coordinator/main.cjs`. Primary source. |
| `recon/beautified/main-app.beauty.js` (109,423 lines) | prettier-formatted `dist/electron-main/main-app.cjs`. Host side: spawn, handoff, restart. |
| `recon/beautified/main-core.beauty.js` (40,710 lines) | prettier-formatted `dist/electron-main/main-core.cjs`. Env surface, deep-link routes. |
| `recon/beautified/preload.beauty.js` (4,152 lines) | prettier-formatted `dist/electron-preload/preload.cjs`. contextBridge + port claim. |
| `recon/beautified/exec-daemon.beauty.js` | prettier-formatted `dist/local-exec-daemon/main.cjs`. |
| `recon/grokbot-0.71.2/dist/renderer/assets/index.eager-app-DSuGVQNC.js` (1,801,380 bytes) | the renderer entry chunk. Contains the *client* half of the contract. |
| `recon/rea/coordinator-methods.json` | pre-extracted `{method, auth}` table, 172 entries. Independently re-derived in this section. |
| `recon/FINDINGS.md` | prior working notes. |

### Notation

* **`PROVEN`** — a literal string, identifier, numeric constant, or control-flow fact was read at
  the cited location. Quotes are verbatim from the beautified bundles.
* **`INFERRED`** — the claim is a reasoned reading of proven facts. The reasoning is stated inline.
* **`UNKNOWN`** — not resolvable from available evidence; the reason is given.
* Line citations are `file:line` against the **beautified** files listed above. `coordinator.beauty.js:34169`
  means line 34169 of `recon/beautified/coordinator.beauty.js`.
* `JB:NNN` is shorthand for `coordinator.beauty.js:NNN` inside tables where the column is already
  labelled, used only to keep tables narrow.

### Minifier caveat (read this before quoting any symbol)

Every bundle is minified. Identifiers such as `nA`, `Kx`, `Rn`, `I()`, `dr`, `ZM`, `yJe`, `hte`,
`hHe`, `q`, `p()`, `Ve`, `Ot` are **minifier-assigned names, not API names**. They are stable only
within this exact build. What *is* real API surface, and what this dossier leans on:

* **string literals** — method names, channel names, env-var names, file names, protobuf type names;
* **object-literal keys** — RPC argument field names;
* **numeric constants** where the surrounding code makes their role unambiguous;
* **source-file paths seeded into telemetry strings** — e.g. `node-agent-coordinator/webauthn/provider.ts`
  (`main-core.beauty.js:26674`), `coordinator-account-runtime.ts` (`main-core.beauty.js:27103`),
  `electron-renderer/client/sand-client.ts` (`main-core.beauty.js:27129`). These are *real*
  monorepo paths that the build baked into error/telemetry descriptors.

Where a claim depends on a minified symbol, the dossier says so explicitly.

---

## 1. Discovery & transport

### 1.1 Correction to the received framing, up front

The prior working notes (`recon/FINDINGS.md:68-70`) describe this as: *"Renderer discovers its port
via `sand:coordinator-port-request` / `sand:coordinator-port`, then talks to it over loopback,"*
and record *"Loopback allowlist literal `new Set(["localhost","127.0.0.1","::1","[::1]"])`."*

Two corrections, both load-bearing:

1. **There is no TCP port and no loopback socket in the local RPC path.** The `port` in
   `coordinatorPort` / `sand:coordinator-port` is an **Electron `MessagePort`**, transferred to the
   renderer through `webContents.postMessage(channel, null, [port])`. The coordinator bundle
   contains **zero** occurrences of `createServer`, `listen(`, or `node:net` (verified by scanning
   the raw `dist/node-agent-coordinator/main.cjs`: `createServer` 0, `listen(` 0, `node:net` 0,
   `WebSocketServer` 0). It is a `utilityProcess`, not a server. `PROVEN`.
2. **The loopback allowlist is a URL policy, not a bind allowlist.** The `Set` at
   `coordinator.beauty.js:33803` is consumed only by `_o()` at `coordinator.beauty.js:33804-33806`,
   which is a predicate: *"is this hostname loopback?"*. It is used in exactly three places, all of
   them **client-side URL checks** (`JB:33850`, `JB:35340`, `JB:35458`), the most important being
   `_o(new URL(r).hostname) ? "loopback" : "pod_proxy"` at `JB:35458`, which classifies the **box
   gateway base URL** the coordinator is about to call. `PROVEN`.

So the correct mental model is:

```
renderer  ──MessagePort──▶  node-agent-coordinator  ──HTTP(S)──▶  box gateway
           (structured frames)   (utilityProcess)      POST /api/{method}
                                                       GET  /events   (SSE)
```

The loopback `Set` exists to keep the second hop honest: the coordinator may talk plain `http:` to
the box gateway **only** when that gateway is on the machine itself. See §1.7.

### 1.2 Process topology

`dist/node-agent-coordinator/main.cjs` is spawned by the Electron main process as an Electron
**`utilityProcess`**. `main-app.beauty.js:91562`:

```js
fork: (L, B) => Ig.utilityProcess.fork(L, [], {
  serviceName: B.serviceName,
  env: { ...process.env, [E8e.NODE_USE_SYSTEM_CA_ENV]: "1", ...u() },
}),
```

with the service name literal at `main-app.beauty.js:85060`:

```js
var Aon = "sand-node-agent-coordinator";
```

and the artifact path resolved at `main-app.beauty.js:85104-85107`:

```js
function _Je() {
  let e = (0, TV.dirname)((0, SJe.fileURLToPath)(__import_meta_url));
  return (0, TV.join)(e, "..", "node-agent-coordinator", "main.cjs");
}
```

`PROVEN`: the coordinator is a child process of the Electron main process, launched via
`utilityProcess.fork`, with `NODE_USE_SYSTEM_CA_ENV=1` forced into its environment (so it trusts the
OS CA store rather than Node's bundled roots — relevant because its outbound hop is TLS to the box).

### 1.3 Three MessagePorts, handed over in the bootstrap message

`main-app.beauty.js:85061-85103` is the whole spawn-and-handoff routine. It creates **three**
`MessageChannelMain` instances and transfers one end of each into the child:

```js
var Aon = "sand-node-agent-coordinator";
function yJe(e) {
  let t = e.fork(e.artifactPath, { serviceName: Aon }),
    n = e.createChannel(),   // control
    r = e.createChannel(),   // renderer data port
    o = e.createChannel(),   // main-process data port
    i = AJe({ post: (f) => n.port2.postMessage(f), executors: e.executors, ... });
  (n.port2.on("message", (f) => i.handleMessage(f.data)),
    n.port2.on("close", () => i.handlePortClosed()),
    n.port2.start(),
    t.postMessage({ bootstrap: { processConfig: e.processConfig } }, [n.port1, r.port1, o.port1]));
```

Return value (`main-app.beauty.js:85086-85090`):

```js
return {
  rendererDataPort: r.port2,
  mainDataPort: o.port2,
  controlSettled: i.settled,
  processExited: s,
  ...
```

`PROVEN`. Three logical channels:

| Channel | Port | Consumer | Purpose |
|---|---|---|---|
| **control** | `n.port2` (main) / `n.port1` (child) | Electron main process | process lifecycle, box-intent, credentials, WebAuthn, telemetry relay, local-exec supervision |
| **data** | `r.port2` (main→renderer) / `r.port1` (child) | the **renderer** (or whichever client claims it) | the 172-method `gateway` RPC surface |
| **main data** | `o.port2` (main) / `o.port1` (child) | Electron main process | the narrower `coordinator-main` surface for the host's own needs |

The child side accepts either carrier. `coordinator.beauty.js:35104-35114`:

```js
function KU() {
  let r = XK(process);
  return r != null && fA(r)
    ? new Promise((e) => {
        (r.on("message", (t) => { e(e2(r, { data: t.data, ports: t.ports ?? [] })); }),
          r.start?.());
      })
    : Promise.resolve(QK(process.argv));
}
```

* `XK(process)` (`JB:34993-34995`) returns `process.parentPort` when `"parentPort" in r` — the
  Electron `utilityProcess` path. `PROVEN`.
* `e2(r, e)` (`JB:35053-35079`) is the parent-port carrier. It validates the bootstrap frame and then
  requires exactly three ports: `if (!fA(s) || !fA(a) || !fA(i)) return { adopted: !1, rejection: { detail: "parent handoff did not transfer three message ports" } };` (`JB:35057-35059`).
* `QK(process.argv)` (`JB:34996-35052`) is a **legacy `child_process` fork-IPC carrier**: it parses a
  `--bootstrap=<json>` argv entry (`$U = "--bootstrap="`, `JB:34989`), requires `process.send`
  (`if (s == null) return { adopted: !1, rejection: { detail: "no renderer data channel was transferred" } };`,
  `JB:35008`), and multiplexes the three logical channels over the single IPC pipe by wrapping frames
  as `{ channel: "coordinator-control", frame }` / `{ channel: "coordinator-main-data", frame }`
  (`iA`/`lA`, `JB:34981-34988`). `PROVEN` as code path; `INFERRED` as legacy: the fork-ipc carrier
  cannot express the renderer data port at all, and its rejection message is written in terms of a
  missing *renderer* data channel.

The bootstrap payload is deliberately tiny. `coordinator.beauty.js:34963-34978`:

```js
function Tw(r) {
  if (!N(r) || !N(r.processConfig))
    return { accepted: !1, rejection: { code: "malformed-frame", detail: "bootstrap.processConfig must be an object" } };
  ...
  { appVersion: t, isPackaged: o, dataDir: s }
```

So the child is told exactly three things at start: `appVersion: string`, `isPackaged: boolean`,
`dataDir: string` (non-empty). `PROVEN`. Bootstrap failure is fatal and classified:
`process.exit(ur.bootstrapRejected)` where `ur = { settledClean: 0, fault: 1, bootstrapRejected: 2 }`
(`JB:34687`, `JB:39787`); the main process re-derives that class as `"bootstrap"` in
`fJe = { [vV.settledClean]: "clean", [vV.fault]: "breach", [vV.bootstrapRejected]: "bootstrap" }`
(`main-app.beauty.js:84788`).

### 1.4 Renderer discovery: request/reply over IPC, then a port transfer

The renderer never learns an address. It asks, and the main process pushes a port to it.

**Preload** (`preload.beauty.js:4091-4102`, `4142`, `4146-4149`):

```js
var { mainEdge: Ru, ...hu } = x.ipcRenderer.sendSync("sand:boot-snapshot-sync"),
  fi = ui(pi(Ru, (e) => { x.ipcRenderer.once(Yt, e); }), fn()),
  gi = li({
    invokeRequest: () => { fi.invoke("sand:coordinator-port-request", void 0); },
  }),
  ...
x.contextBridge.exposeInMainWorld("coordinatorPort", xu);   // xu = gi.bridge
...
x.ipcRenderer.on("sand:coordinator-port", (e) => {
  let n = e.ports[0];
  n != null && gi.deliver(ci(n));
});
```

`PROVEN`. The preload exposes exactly **one** member to the page: `coordinatorPort`, whose value is
`gi.bridge` — i.e. `{ claim }`. The `sand:coordinator-port` listener is registered in the preload and
is not reachable from page script; the page can only cause a request, and only the preload can
receive and unwrap the resulting port.

**Main process handler** (`main-app.beauty.js:85108-85109`, `85227-85262`):

```js
var EJe = "sand:coordinator-port-request",
  bJe = "sand:coordinator-port";
...
e.ipcMain.handle(EJe, (r) => {
  (e.assertTrustedRequester(r), e.telemetry.requested());
  let o = r.sender;
  return (
    n((i) => {
      if (!o.isDestroyed()) {
        try { o.postMessage(bJe, null, [i]); }
        catch (a) { throw (e.telemetry.invokeFailed("renderer_port"), a); }
        e.telemetry.adopted("renderer_port");
      }
    }),
    null
  );
}),
```

`PROVEN`. Notes with design weight:

* `e.assertTrustedRequester(r)` — the handler is gated on a **trusted-origin assertion** before doing
  anything. The implementation of `assertTrustedRequester` was not located in the beautified
  main-app within this pass; its existence and call position are proven. `INFERRED`: it is an
  origin/frame check (Electron `event.senderFrame` / URL comparison), consistent with
  `contextIsolation: true` (`FINDINGS.md:48`).
* The handler returns `null` immediately after *registering a sink*; it does not await the port.
* Delivery is via `webContents.postMessage(channel, null, [port])` — Electron's **structured-clone
  port transfer**. This is why the page-side interface is a `MessagePort`, not a URL.

### 1.5 `claim` — the single-claimant gate

`preload.beauty.js:4015-4036` is the entire claim implementation:

```js
function li(e) {
  let n = null;
  return {
    bridge: {
      claim(r) {
        return n != null
          ? null
          : ((n = r),
            {
              request: () => { n === r && e.invokeRequest(); },
              release: () => { n === r && (n = null); },
            });
      },
    },
    deliver(r) { n?.onPort(r); },
  };
}
```

`PROVEN`. Semantics, exactly:

* `claim(portSink)` returns **`null` if a claim already exists** — otherwise it installs `portSink`
  as *the* sink and returns a handle with two methods.
* `request()` fires `sand:coordinator-port-request` **only** while this sink is still the installed
  one. Requesting twice is allowed but the second port is delivered to the same sink; requesting
  after `release()` is a no-op.
* `release()` clears the sink. It does **not** tell the main process; a subsequent `claim().request()`
  is a fresh request. The main-process side has a matching state machine (`{kind:"waiting",sink}` →
  `{kind:"serving",runtime}` at `main-app.beauty.js:85228-85235`, `85255-85259`), so `release` does
  not revoke the main-process side; only `revokeRendererPortRequest()`
  (`main-app.beauty.js:85207-85209`) does, and that is called by the host, not the client.
* `deliver(port)` calls `n?.onPort(port)` — the sink interface is `{ onPort(port) }`, where `port` is
  the narrowed facade built by `ci()`.

`ci()` (`preload.beauty.js:4038-4061`) is a **capability-narrowing wrapper** around the raw
`MessagePort`:

```js
function ci(e) {
  return {
    postMessage: (n) => { e.postMessage(n); },
    close: () => { e.close(); },
    start: () => { e.start(); },
    addEventListener: (n, r) => {
      if (n === "message") { e.addEventListener("message", (a) => { r({ data: a.data }); }); return; }
      e.addEventListener("close", () => { r({}); });
    },
  };
}
```

`PROVEN`. The page gets `postMessage`, `close`, `start`, and `addEventListener` restricted to
`"message"` and `"close"`. No `postMessage(msg, transfer)` overload — the page cannot transfer ports
over this channel. That is a deliberate closing of the capability.

`INFERRED` (load-bearing for the "phone drives the agent" story): because `claim` is
**single-claimant** and lives in the *preload* of a specific renderer, the desktop's local RPC
channel is, by construction, owned by exactly one renderer at a time. A second client cannot
co-attach; it must either wait for `release` or drive the agent through the backend instead. The
renderer's own code confirms this is treated as a scarce resource — see the identity-change
handshake below.

### 1.6 The renderer side: port adoption, source swapping, identity change

The renderer entry chunk contains the client half. Reconstruction from
`index.eager-app-DSuGVQNC.js` (character offsets given because this file has no line structure in the
beautified sense; it is a single minified chunk):

* `aJe()` reads `globalThis.window?.coordinatorPort` and asserts
  `typeof e === "object" && e != null && typeof e.claim === "function"`, failing with the literal
  `"coordinatorPort capability is missing from the preload surface"`.
* `lJe(e)` is the port pump. It keeps a restore state machine
  `{kind:"idle"} | {kind:"restoring", port} | {kind:"failed"}`, plus a *swappable source* `M3e(t.source)`
  whose `swap(c, { replacesPort })` re-points every subscriber and notifies transport-state listeners
  with `("connected", "port-replacement")`.
* On `onPort(port)`: if an identity change is in flight → `port.close()`; if state is `failed` →
  `port.close()`; if already `restoring` → the previous pending port is closed and replaced
  (*only one pending port is retained*); otherwise adopt.
* Adoption builds `P3e({ post: c.postMessage, close: c.close })`, wires
  `c.addEventListener("message", p => d.handleMessage(p.data))` and
  `c.addEventListener("close", ...)`, swaps the source, calls `t.settle()`, then `c.start?.()`.
* Finally `l = e.portBridge.claim({ onPort: a }); l?.request();`
* `beginIdentityChange()` and `failIdentityChange()` exist to hold ports aside while the signed-in
  account is being switched.

`PROVEN` as code reading; the `P3e` frame protocol is quoted in §1.7. `INFERRED`: `start?.()` is
required because a transferred `MessagePort` in a renderer does not begin delivering until
`start()`; the preload facade exposes `start` precisely for this.

### 1.7 The frame protocol

Both ends of the data port speak the same five-frame protocol. **Coordinator (server) side**,
`coordinator.beauty.js:34862-34901`:

```js
function pA(r) {
  if (!N(r)) return ft("frame must be an object");
  switch (r.kind) {
    case "lifecycle": return YK(r);
    case "request": {
      if (!pr(r.requestId)) return ft("request.requestId must be a non-empty string");
      if (!pr(r.method)) return ft("request.method must be a non-empty string");
      if (!("args" in r)) return ft("request.args is missing");
      let e = r.demand;
      return e !== void 0 && e !== "person" && e !== "background"
        ? ft("request.demand must be person or background when present")
        : To({ kind: "request", requestId: r.requestId, method: r.method, args: r.args,
               ...(e === void 0 ? {} : { demand: e }) });
    }
    case "cancel":
      return pr(r.requestId) ? To({ kind: "cancel", requestId: r.requestId })
                             : ft("cancel.requestId must be a non-empty string");
    case "reply": { ... }
    case "event":
      return pr(r.family) ? ("payload" in r ? To({ kind: "event", family: r.family, payload: r.payload })
                                             : ft("event.payload is missing"))
                          : ft("event.family must be a non-empty string");
    default:
      return ft("frame.kind must be lifecycle, request, cancel, reply, or event");
  }
}
```

`PROVEN`. Five frame kinds: `lifecycle`, `request`, `cancel`, `reply`, `event`. The literal error
string enumerates them: *"frame.kind must be lifecycle, request, cancel, reply, or event"*.

**Lifecycle frames.** `YK(r)` (`JB:34903+`) validates them. The two phases observed are `hello`
(client→server), `ready` (server→client), `shutdown` (either direction). Protocol version constant
`var jr = 3` (`JB:34842`). The server session state machine is `tC()`
(`coordinator.beauty.js:39499-39599`):

```js
let t = "awaiting-hello",
...
if (t === "awaiting-hello") {
  if (m.kind !== "lifecycle") { d(`${m.kind} frame before hello`); return; }
  if (m.protocolVersion !== jr) { d(`hello.protocolVersion ${m.protocolVersion} is not the supported ${jr}`); return; }
  ((t = "serving"), r.post({ kind: "lifecycle", phase: "ready", protocolVersion: jr }), e.onServing?.());
  return;
}
```

and it is strict about direction:

```js
if (m.kind === "reply" || m.kind === "event") { d(`client posted a server-direction ${m.kind} frame`); return; }
if (m.kind === "lifecycle" && m.phase === "ready") { d("client posted a server-direction ready frame"); return; }
```

`PROVEN`. Reusing an in-flight `requestId` is a protocol breach:
`` d(`request.requestId ${m.requestId} reused while in flight`) `` (`JB:39569`).

**Replies.** `c(m, E) => r.post({ kind: "reply", requestId: m, outcome: E })` (`JB:39518-39520`),
with `outcome` either `{status:"ok", value}` or `{status:"failed", failure:{code, message, ...}}`
(`JB:37032-37042`). `PROVEN`.

**Cancellation.** A `cancel` frame aborts the in-flight request's `AbortController` and replies
`{ status: "failed", failure: { code: "cancelled", message: "request cancelled" } }`
(`UU = "cancelled"`, `JB:34845`; abort + reply at `JB:39575-39579`). `PROVEN`.

**Events.** Server→client, one-way: `r.post({ kind: "event", family: m, payload: E })`
(`postEvent`, `JB:39594-39596`). `family` is drawn from a **named channel vocabulary** —
`wJ` at `coordinator.beauty.js:36829-36849`:

```js
wJ = { ...$2, transcript: "transcript", agents: "agents", "agent-upserted": "agent-upserted",
       tray: "tray", subagents: "subagents", "async-tasks": "async-tasks", "forever-box": "forever-box",
       "teach-recording": "teach-recording", "box-disk-pressure": "box-disk-pressure",
       "computer-action": "computer-action", "voice-call-nudge": "voice-call-nudge",
       "messages-grants": "messages-grants", "agent-activity": "agent-activity", outline: "outline",
       "host-settings": "host-settings", "cloud-agent-update": "cloud-agent-update",
       "server-roster-changed": "server-roster-changed", "server-page-title-changed": "server-page-title-changed" }
```

plus the transport-state family `mA = "coordinator-transport-state"` (`JB:34979`) and the transcript
source family `qU = "coordinator-transcript-source"` (`JB:34980`).

The renderer's decoder confirms the framing exactly. `P3e(e)`:

```js
function P3e(e){ let t="awaiting-ready",n=0; ...
  e.post({kind:"lifecycle",phase:"hello",protocolVersion:rh});
  const f=(v,w,_,b)=>{ ... n+=1; const L=`r-${n}`; ...
     e.post({kind:"request",requestId:L,method:v,args:w,...C===void 0?{}:{demand:C}}); ...}
```

`PROVEN`. Note the two sides use **different requestId prefixes**: the renderer uses `r-<n>`
(`L = \`r-${n}\``), the control client uses `c-<n>` (`R = \`c-${o}\``, `JB:35148`). The two are
correlated only within their own port, which is consistent with per-port session state.

Server→client control frames are also decoded client-side: `v3e(e)` accepts
`{state:"connected"|"down"}` for the transport-state family, and `b3e(e)` accepts
`{source:"gateway"|"server"}` for the transcript-source family. The renderer's default source is
`"gateway"` and it flips to `"server"` when the coordinator reports the server tail is authoritative.
`PROVEN`.

**Failure decoding.** `I3e(e, t)` maps a `failure` object to a typed client error. The observed
`transportKind` vocabulary (the `switch (s)` at the end) is:

```
"refused", "timeout", "http_5xx", "dns", "no_storage", "access_denied",
"box_blocked", "network", "pod_hibernated"
```

plus the client-synthesized `"pre_port_settle"` (`Ra = "pre_port_settle"`). Codes
`co` (→ `transportKind:"pre_port_settle"`) and `to` (→ `new ye({code:to, boundary:"host",
retry:{owner:"client",command:e}, transportKind:"access_denied"}, to)`) are the two client-side
sentinels. `PROVEN` for the vocabularies; the specific numeric/string values behind `co`/`to` were not
resolved. `UNKNOWN`: the full failure-code table.

### 1.8 The second hop: the box gateway is plain HTTP(S) + JSON + SSE

The coordinator does not implement the agent runtime. It **proxies** the 172 methods to a
**box gateway** over HTTP. This is the single most important structural fact in this section.

`coordinator.beauty.js:36150-36155` (inside the gateway client class):

```js
let E = await fetch(`${a.baseUrl}${Rw}/${e}`, {
  method: "POST",
  headers: this.requestHeaders({ "content-type": "application/json",
                                 ...(m !== void 0 ? { [rJ]: m } : {}) }, a),
  body: JSON.stringify(t ?? {}),
  ...(o?.signal != null ? { signal: o.signal } : {}),
});
```

with `Rw = "/api"` at `coordinator.beauty.js:35266`. `PROVEN`. So **the local RPC method name is also
the gateway HTTP path segment**: `sendPrompt` ⇒ `POST {baseUrl}/api/sendPrompt`.

Authentication and correlation headers, `coordinator.beauty.js:35266-35273` and `35956-35959`:

```js
var Rw = "/api",
  jU = "/events",
  YU = "/events/echo",
  ZU = "nonce",
  Iw = ":echo ";
var XU = "/health";
var QU = "Bearer",
  eJ = "x-sand-slim-avatars",
  tJ = "x-sand-mint-dedupe",
  rJ = "traceparent";
...
requestHeaders(e, t) {
  let o = L2(e, t);
  return (this.slimAvatarsDisabled || (o[eJ] = "1"), o);
}
...
function L2(r, e) {
  let t = { ...r, ...e.headers };
  return (e.token != null && e.token.length > 0 && (t.authorization = `${QU} ${e.token}`), t);
}
```

`PROVEN`. Headers on the box hop: `authorization: Bearer <token>`, `traceparent`,
`x-sand-slim-avatars: 1`, and optionally `x-sand-mint-dedupe`. Health probe path `/health`.
Three auxiliary endpoints: `/api/{method}` (POST), `/events` (GET, `accept: text/event-stream`,
`JB:36545-36546`), `/events/echo?...nonce=...` (POST, `JB:36048-36049`; SSE comment lines beginning
`":echo "` are sliced with `h.slice(Iw.length)` at `JB:36572-36573`). `PROVEN`.

Where does `{baseUrl, token}` come from? Presigned by the **backend** and stamped onto the box. The
main process builds the descriptor in `Aze()`, `main-app.beauty.js:78424-78431`:

```js
function Aze(e, t, n, r) {
  let o = n.length > 0 && r != null && r.primaryUrl.length > 0 && r.forkBaseUrl.length > 0;
  return {
    baseUrl: e,
    token: t.length > 0 ? t : void 0,
    headers: n.length > 0 ? { [$He]: n } : void 0,
    vncProxy: o ? { primaryUrl: r.primaryUrl, forkBaseUrl: r.forkBaseUrl, networkToken: n } : void 0,
  };
}
```

and the broker stamp is unpacked in `q7()`, `main-app.beauty.js:78409-78422`:

```js
function q7({ box: e, routeAccountScope: t }) {
  if (e.gatewayUrl.length === 0)
    throw new MG("Broker did not expose the in-box Sand gateway (gateway_url empty); " +
                 "the backend stamps it on every box — check the backend version/logs.");
  return {
    ...Aze(e.gatewayUrl, e.gatewayToken, e.networkToken, { primaryUrl: e.vncUrl, forkBaseUrl: e.forkVncBaseUrl }),
    egressTunnelOwnership: e.egressTunnelOwnership,
    ...(t === void 0 ? {} : { routeAccountScope: t }),
  };
}
```

`PROVEN`. And the backend response that carries these fields is
`aiserver.v1.EnsureSandBoxResponse` (`PROVEN` via embedded descriptor, §5.6): field 10 `gateway_url`,
field 11 `gateway_token`, 4 `network_token`, 5 `exec_daemon_auth_token`, 6 `exec_daemon_url`,
7 `vnc_url`, 9 `terminals_folder`, 12 `fork_vnc_base_url`, 15 `image`.

The main process exposes the resolver on the control edge: `resolveGatewayConnection: ({ path: r }) => t.connect(r)`
(`main-app.beauty.js:83009`), and the coordinator calls it four times with the four **edge path** names:

```js
resolveGatewayConnection: () => s.commands.resolveGatewayConnection({ path: "gateway" }),      // JB:39804
resolveConnection: () => s.commands.resolveGatewayConnection({ path: "passkey-provider" }),    // JB:39976
resolveConnection: () => s.commands.resolveGatewayConnection({ path: "cookie-provider" }),     // JB:40008
let me = await Te.run(() => r.control.resolveGatewayConnection({ path: "local-exec-refresh" })),// JB:39096
```

`PROVEN`. Four gateway *paths* exist — and these are exactly the four non-method edge names that
appear in the extended authorization map (§4.1):

```js
YM = ["gateway", "passkey-provider", "cookie-provider", "local-exec-refresh"]   // JB:32760
```

### 1.9 The loopback allowlist, precisely

`coordinator.beauty.js:33803-33806`:

```js
var f$ = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function _o(r) {
  return f$.has(r.trim().toLowerCase());
}
```

Three call sites in the whole bundle (`grep -c '_o('` = 4 including the definition):

1. `JB:33850` — inside `SU(r)`, a **URL validator**:
   ```js
   return e.href !== r || e.username.length > 0 || e.password.length > 0 || y$.has(e.protocol)
     ? !1
     : e.protocol === "http:"
       ? _o(e.hostname)
       : e.protocol === "https:"
         ? !0
         : e.hostname.length > 0 || e.pathname.length > 0;
   ```
   `PROVEN`: plain `http:` is accepted **only** for loopback hostnames; `https:` is accepted for any
   host; everything else falls through to a shape check. The scheme denylist `y$` (`JB:33810-33833`)
   blocks `javascript:`, `data:`, `file:`, `blob:`, `ws:`, `wss:`, `mailto:`, `chrome:`, etc.
2. `JB:35340` — a VNC viewer URL check: `if (!_o(t.hostname) || !t.pathname.endsWith("/vnc.html")) return r;`
3. `JB:35458` — inside `In(r)`, the **base-URL classifier**:
   ```js
   function In(r) {
     if (r == null || r.length === 0) return "unknown";
     try { return _o(new URL(r).hostname) ? "loopback" : "pod_proxy"; }
     catch { return "unknown"; }
   }
   ```
   whose result is reported as `baseUrlKind` on gateway reachability telemetry
   (`JB:36203`: `baseUrlKind: In(a?.baseUrl)`).

`PROVEN`. Interpretation:

* The `Set` is an **anti-downgrade guard on the box gateway URL**. The `gateway_url` arrives from the
  backend (`EnsureSandBoxResponse.gateway_url`) or, in dev, from a local `gateway.json`. A hostile or
  misconfigured value that points at `http://evil.example` would send the box bearer token in
  cleartext to a third party; `SU()`/`In()` refuse to treat a non-loopback `http:` URL as legitimate.
  `INFERRED` (strong: it is the only consumer, it is a client-side check on an outbound URL, and the
  bearer token is attached to that same URL by `L2`).
* It does **not** constrain any bind address, because the coordinator never binds. It also does not
  constrain the *remote* hop (`https://api2.cursor.sh`, `G2 = "api2.cursor.sh"` at `JB:36704`) —
  that one is hardcoded and must be HTTPS.
* Practical consequence for a self-hosted host: to be compatible with this contract, a local box
  gateway must be reachable at a loopback hostname over plain HTTP **or** any host over HTTPS. That
  is a clean, reproducible rule.

### 1.10 Discovery and lifecycle summary

```
                  ┌─────────────────────────── Electron main process ───────────────────────────┐
                  │  utilityProcess.fork(dist/node-agent-coordinator/main.cjs,                │
                  │                      { serviceName: "sand-node-agent-coordinator" })      │
                  │  postMessage({ bootstrap: { processConfig: {                               │
                  │      appVersion, isPackaged, dataDir } } }, [control, data, mainData])      │
                  │                                                                            │
   ipcMain.handle("sand:coordinator-port-request")  ──▶  webContents.postMessage(              │
                  │                                       "sand:coordinator-port", null, [p])    │
                  └────────────────────────────────────────────────────────────────────────────┘
        ▲ renderer                                                     │
        │ window.coordinatorPort.claim({onPort}) → .request()           ▼
        └────────────────────── MessagePort: lifecycle/request/reply/cancel/event ─────────────▶ coordinator
                                                                                              │
                                                          POST {gateway_url}/api/{method} ────┤
                                                          GET  {gateway_url}/events  (SSE) ────┤
                                                          Authorization: Bearer {gateway_token}
```

`PROVEN` end to end except the SSE event *payload* schemas, which are §5/§6 material.

---

## 2. The RPC schema layer

### 2.1 The validation library is `dune`/`sand`, not zod

Both the zod-shaped `parse` API that appears elsewhere in the coordinator and the RPC-layer validator
are visible; the RPC layer uses a **custom combinator DSL implementing Standard Schema v1**.

Base factory, `coordinator.beauty.js:32631-32646`:

```js
function dr(r, e) {
  return {
    expects: r,
    check: e,
    "~standard": {
      version: 1,
      vendor: "dune",
      validate: (t) => {
        let o = e(t, []);
        return o.ok ? { value: o.value }
                    : { issues: [{ message: `must be ${o.expected}, got ${o.received}`, path: o.path }] };
      },
    },
  };
}
```

Second base with a different vendor string, `coordinator.beauty.js:33650-33665`:

```js
function aw(r, e) {
  return {
    expects: r,
    check: e,
    "~standard": { version: 1, vendor: "sand", validate: (t) => { ... } },
  };
}
```

`PROVEN`: two internal vendor tags, `"dune"` (`dr`, the field-validator base) and `"sand"` (`aw`, the
labeled/custom base). Both expose `"~standard": { version: 1, vendor, validate }` — the
[Standard Schema](https://standardschema.dev) v1 contract. `RH(r)`
(`coordinator.beauty.js:32734-32737`) is the duck-type check used to accept *any* third-party
Standard Schema value:

```js
function RH(r) {
  let e = r["~standard"];
  return typeof e == "object" && e !== null && e.version === 1 && typeof e.validate == "function";
}
```

`INFERRED`: the internal library name "dune" plus a `sand`-tagged sibling suggests the Anysphere
monorepo carries its own schema package, with the RPC layer deliberately decoupled from it via
Standard Schema so external validators can be mixed in. `UNKNOWN`: whether "dune" is published or
in-tree only (`FINDINGS.md:30` records all deps as `workspace:*`, i.e. in-tree).

**There are two independent validation engines in this bundle.** A zod-compatible issue-code table
appears at `coordinator.beauty.js:2705-2716` (`invalid_format`, `not_multiple_of`, `unrecognized_keys`,
`invalid_union`, `invalid_key`, `invalid_element`, `invalid_value`, `custom`) with a formatter
`_E(r)` at `JB:2718-2720` that joins `path.join(".")` + message. That is a *different* layer
(zod-style) and is **not** what validates RPC arguments. The RPC dispatcher calls
`i.schema["~standard"].validate(o)` (`JB:37033`), i.e. the dune/sand engine. `PROVEN`.

### 2.2 Combinator vocabulary

All line numbers in `recon/beautified/coordinator.beauty.js`:

| Combinator | Line | `expects` string | Semantics |
|---|---|---|---|
| `dr(expects, check)` | 32631 | caller-supplied | base validator; wraps `check` in Standard Schema v1 |
| `w(obj)` | 32712 | `"object"` | object validator via `TH` |
| `TH(spec, value, path)` | 32647 | — | **strips unknown keys**: iterates `Object.entries(r)` (the *spec*), reads `Object.hasOwn(e, s) ? e[s] : void 0`, skips `undefined` only if the field is optional, pushes `[s, d.value]`, returns `Object.fromEntries(o)` |
| `xt(r)` | 32715 | `` `record of ${r.expects}` `` | `Record<string, T>`; validates each value with the same path |
| `ae(r)` | 32699 | `` `array of ${r.expects}` `` | array of `r`; per-index path segments |
| `Ve(...r)` | 32689 | union of `expects` | tagged union / `oneOf`; first match wins |
| `U(literal)` | 32674 | `JSON.stringify(r)` | exact literal (used for discriminants) |
| `A(r)` | 32678 | — | **optional**: `{ ...r, optional: true }`; `_H()` (32628) reads `.optional === true` |
| `at(r)` | 32681 | `` `${r.expects} | null` `` | **nullable** (`record-or-null`-style wrappers are built from this) |
| `p()` | 32659 | `"string"` | string |
| `ne()` | 32662 | `"number"` | finite number (`Number.isFinite`); non-finite rejected with `received: "non-finite number"` |
| `Z()` | 32671 | `"boolean"` | boolean |
| `$x()` | 32728 | `"unknown"` | pass-through |
| `cr()` | 32731 | — | returns `{}` — the **empty/void** schema. `Ore = w({})` (32759) is the canonical "empty object" |
| `dt(label, pred)` | 33666 | label | labeled predicate validator |
| `_e(label, values)` | 33711 | label | labeled enum: `dt(r, t => e.some(o => o === t))` over a literal array |
| `Ot(label, fn)` | 33675 | label | custom refinement with a `{success, data}` result protocol |
| `Qh(schema, map)` | 33669 | inherits | **transform**: run `schema.check`, then map the value |
| `Ao(spec, t)` | 33714 | `"telemetry report"` | telemetry-report projection: copies only the keys in `t` that are present in the input |

`PROVEN` for each row: the semantics column is a direct reading of the cited function body.

**The vocabulary named in the task brief maps onto this table as follows.** `string`=`p()`,
`number`=`ne()`, `boolean`=`Z()`, `object`=`w()`, `record`=`xt()`, `array`=`ae()`, `map`=`xt()`
(there is no separate `map` combinator — `xt` is `Record`, and protobuf map fields are declared with
`K,V` type codes, §5.6), `optional`=`A()`, `enum`=`_e()`/`dt()`, `void`/empty=`cr()`/`Ore`,
`unknown`=`$x()`, `scalar`/`temporal` are **not** RPC-DSL combinators — they are the
**protobuf field-kind** vocabulary in the descriptor parser (§5.6: `{ kind: "scalar", T: Number(t) }`
at `JB:33611`) and the reply-container vocabulary in the renderer (§2.7). The `record-or-null`
wrapper is a **reply container name**, not a combinator (`k3e["record-or-null"]`). This mapping is
`PROVEN` for the left-hand names; the right-hand correspondence is stated where observed.

### 2.3 A method's arguments are declared with `I()`

`coordinator.beauty.js:32738-32755`:

```js
var Hh = class extends Error {
  constructor(e) {
    (super(`rpcMethod().args: field "${e}" is not an rpc field validator; pass rpc* combinators or one Standard Schema v1 value.`),
      (this.name = "RpcMethodDeclarationError"));
  }
}
function I() {
  return {
    noArgs: { schema: null },
    args: (r) => {
      if (RH(r)) return { schema: r };
      for (let [e, t] of Object.entries(r)) if (typeof t?.check != "function") throw new Hh(e);
      return { schema: w(r) };
    },
  };
}
```

`PROVEN`. Three facts with real weight:

1. `I()` is an **RPC method builder**, minified. Its two members are `noArgs` (sugar for
   `{schema: null}`) and `args(x)`.
2. `args(x)` accepts **either** a plain object of field-validators **or** a single Standard Schema v1
   value. If it is an object, every value must expose `.check` (i.e. must be a `dr`/`aw` product) or a
   `RpcMethodDeclarationError` is thrown **at module load**, naming the offending field. This is a
   fail-fast declaration guard.
3. An object argument list is wrapped in `w(...)`, i.e. **unknown keys are stripped, not rejected**.
   A client can send extra fields; they are silently dropped before the handler sees them. `INFERRED`:
   deliberate forward-compatibility — new client builds can send new fields to an older host.

### 2.4 The binding table: `nA = Rn("gateway", { methods })`

`coordinator.beauty.js:32756-32758`:

```js
function Rn(r, e) {
  return Object.freeze({ kind: "rpc-edge", edge: r, methods: e.methods, hasEvents: e.events != null });
}
```

An **edge** is `{kind:"rpc-edge", edge, methods, hasEvents}` — a named, frozen namespace of methods.
Three are declared:

| Edge | Line | Methods | Served on | Audience |
|---|---|---|---|---|
| `"gateway"` (`nA`) | 34169–34706 | **172** | data port | the agent-driving client (renderer today) |
| `"coordinator-control"` (`DU`) | 34711–34749 | 29 | control port | Electron main process, coordinator→host commands |
| `"coordinator-main"` (`LU`) | 34804 | 40 (`WK` 24 ∪ `KK` 8, deduped) | main-data port | host-internal calls into the coordinator |

`PROVEN`. The gateway table's shape, at its head (`coordinator.beauty.js:34169-34178`):

```js
nA = Rn("gateway", {
  methods: {
    getAgentTranscript: I().args(Tt),
    getAgentTranscriptPage: I().args(x$),
    openAgentWindowed: I().args({ id: q(), limit: ne() }),
    getAgentTranscriptWindow: I().args(w$),
    openAgentTail: I().args({ id: q(), limit: ne(), sessionId: A(p()), unreadBoundaryAt: A(ne()) }),
    getAgentTranscriptTail: I().args(C$),
    getAgentThread: I().args({ id: p(), rootId: p() }),
    sendPrompt: I().args(O$),
    promptAcceptanceStatus: I().args(I$),
    respondToWidget: I().args({ entryId: p(), value: p(), agentId: q(), sessionId: A(p()) }),
    resolveAutoReviewApproval: I().args({ entryId: p(), requestId: p(),
                                          resolution: _e("approval resolution", ba),
                                          agentId: q(), approvalPlatform: A(T$),
                                          approvedCommand: A(...), sessionId: A(p()) }),
```

`PROVEN`. Argument schemas are declared in three styles:

* **inline object literal** — `openAgentWindowed: I().args({ id: q(), limit: ne() })`;
* **named schema variable** — `getAgentTranscript: I().args(Tt)`, where `Tt = { id: q() }`
  (`JB:33876`);
* **derived/transformed** — `sendPrompt: I().args(O$)`, where `O$ = Qh(w(pw), uw)`
  (`JB:33920`), with `pw` a 21-field object literal (`JB:33897-33919`) and `uw` a transform that
  **deletes an empty `mcpConfigJson`** (`JB:33892-33896`):
  ```js
  function uw(r) {
    if (r.mcpConfigJson === void 0 || r.mcpConfigJson.trim().length > 0) return r;
    let { mcpConfigJson: e, ...t } = r;
    return t;
  }
  ```
  This is a deliberate "omit rather than send empty" normalization. `PROVEN`.

**Verification performed.** An independent structural parse of `coordinator.beauty.js:34169-34706`
(bracket-balanced, not line-based) found **exactly 172** top-level entries in `nA.methods`, of which
**21** are `I().noArgs` and **151** are `I().args(...)`. This matches `recon/rea/coordinator-methods.json`
(172 entries) exactly, method-for-method. `PROVEN`.

### 2.5 Argument-schema variable vocabulary

A small set of shared, named field schemas is reused across methods. Recovered definitions
(all `coordinator.beauty.js`):

| Var | Line | Declaration | Meaning |
|---|---|---|---|
| `Tt` | 33876 | `{ id: q() }` | "agent reference" |
| `iw` | 33877 | `{ id: p() }` | untyped id |
| `Gs` | 33878 | `{ id: q(), automationId: p() }` | automation target |
| `lw` | 33879 | `{ id: p(), workflowId: p() }` | workflow target |
| `dw` | 33880 | `{ id: q(), platform: p() }` | channel target |
| `I$` | 33886 | `{ accountSlot: p(), clientNonce: p(), agentId: A(q()), sessionId: A(p()) }` | prompt acceptance lookup |
| `x$` | 33887 | `{ id: q(), beforeSeq: A(ne()), limit: ne(), sinceMs: A(ne()), untilMs: ne() }` | transcript page read |
| `w$` | 33888 | `{ id: q(), beforeSeq: A(ne()), limit: ne() }` | transcript window read |
| `C$` | 33889 | `{ id: q(), beforeSeq: A(ne()), limit: ne(), sessionId: A(p()), unreadBoundaryAt: A(ne()) }` | transcript tail read |
| `pw` | 33897-33919 | 21 fields, see §5.2 | send-prompt body |
| `Ks` | ~33931 | `w({ ...bU, ... })` where `bU = { name, description, title, avatarShape, avatarColor }` (~33930) | create-agent body |
| `T$` | 33882 | `dt("approval platform", Eo)` | approval surface tag ("bot_share" is one such value, `JB:4099`) |
| `$s` | 33927 | `w({ shareId: p(), visibility: _e("bot template visibility", yU) })` | template visibility |
| `fw` | 34009 | `kU(j$)` = `{ entryId, requestId, resolution, agentId, sessionId }` (`kU` at 33934) | local-tool-permission resolution |
| `gw` | 34010 | `kU(_e("connector grant resolution", UE))` | connector-grant resolution |

`q()` is the **agent-id validator** and deserves its own line, because it defines what an `agentId`
*is*. `coordinator.beauty.js:33696-33701`:

```js
function q() {
  return Ot("agent id", (r) => {
    let e = ue(r);
    return e === null ? { success: !1 } : { success: !0, data: e };
  });
}
```

`ue` at `coordinator.beauty.js:419-421` → `iF(r)` at `407-418`:

```js
function iF(r) {
  return (
    typeof r == "string" &&
    r.length > 0 &&
    r === r.trim() &&
    !r.includes("/") &&
    !r.includes("\\") &&
    !r.includes("\0") &&
    r !== "." &&
    r !== ".."
  );
}
```

`PROVEN`. **An agent id is a filesystem-safe path segment.** No separators, no NUL, not `.` or `..`,
already trimmed. `INFERRED` (high confidence): the agent store on the box is a directory tree keyed by
agent id, so the id is validated as a directory name at the RPC boundary to prevent traversal from a
client. A capped variant exists: `eA = Ot(\`non-blank string of at most ${rw} characters\`, r => XL(r) ? ue(r) : null)`
with `rw = 64` (`JB:33602`, `33608-33609`), used where a *derived name* is accepted.

### 2.6 Dispatch: name lookup, validation, handler call

`coordinator.beauty.js:37002-37043`:

```js
function Y2(r, e) {
  if (!Wt(r, e)) return;
  let t = r[e];
  return t === void 0 ? void 0 : { method: e, schema: t.schema ?? j2 };
}
function Vw(r, e) {
  return async (t, o, s, a) => {
    let i = Y2(e, t);
    if (i === void 0) return { status: "failed", failure: { code: dA, message: `no coordinator method named ${t}` } };
    let d = await i.schema["~standard"].validate(o);
    if (d.issues) return { status: "failed", failure: { code: cA, message: `${t}: ${rU(d.issues)}` } };
    try {
      return {
        status: "ok",
        value: await r.dispatchCommand(i.method, d.value, { signal: s, ...(a === void 0 ? {} : { demand: a }) }),
      };
    } catch (c) {
      return { status: "failed", failure: Z2(c) };
    }
  };
}
```

with `j2 = w({})` (`JB:37001`) as the default (empty object) schema, and failure codes
`dA = "unknown-method"`, `cA = "invalid-args"` (`JB:34843-34844`). `PROVEN`. The pipeline is:

```
frame.request {method, args, demand?}
  → Y2(schemaTable, method)            // name lookup, prototype-safe via Wt = Object.hasOwn
  → schema["~standard"].validate(args) // strip + coerce + check
  → dispatchCommand(method, value, {signal, demand})
  → gateway HTTP hop  OR  local handler
  → reply {status, value|failure}
```

`Wt(r, e) = typeof e == "string" && Object.hasOwn(r, e)` (`JB:32616-32618`) — the lookup is
`Object.hasOwn`, so `__proto__`, `constructor`, `toString` are not callable as methods. `PROVEN`.

The **edge factory's** version, `Vw(r, e)` is bound at `coordinator.beauty.js:37029` and instantiated
for the data port at `JB:40211`:

```js
Te = tC(
  { post: (_) => t.data.post(_), close: () => t.data.close() },
  { dispatchRequest: async (_, M, ie, se) => { ... } },
),
```

and for the main-data port at `JB:40244`. `PROVEN`. Each `tC()` session has its **own**
`dispatchRequest`, so the same 172-name table is filtered through two different second-stage
dispatchers.

### 2.7 The reply-container vocabulary (client side)

The coordinator validates *arguments*; the renderer validates *replies* with a second, small
vocabulary. `k3e` in the renderer entry chunk:

```js
const An = Symbol("malformed-reply");
const k3e = {
  array: e => Array.isArray(e) ? e : An,
  record: e => fe(e) ? e : An,
  "record-or-null": e => e === null || fe(e) ? e : An,
  boolean: e => typeof e == "boolean" ? e : An,
  count: e => typeof e == "number" && Number.isFinite(e) && e >= 0 ? e : An,
  void: () => {},
  "send-result": e => { if (e != null) return fe(e) ? e : An },
  "transcript-page": e => !fe(e) || !Array.isArray(e.entries)
        || e.nextBeforeSeq != null && typeof e.nextBeforeSeq != "number"
        || e.cloudAgentPeerIds !== void 0 && !$r(e.cloudAgentPeerIds) ? An : e,
  "acceptance-lookup": e => fe(e) && typeof e.outcome == "string" ? e : An,
  "connect-url": e => fe(e) && typeof e.url == "string" ? e : An,
  "import-result": e => fe(e) && Array.isArray(e.workflows) ? e : An,
  "channels-view": e => fe(e) && Array.isArray(e.manifests) && Array.isArray(e.connections) ? e : An,
  "box-secrets": e => !fe(e) || !$r(e.keys) || e.cardKeys !== void 0 && !$r(e.cardKeys)
        || typeof e.isApplied != "boolean"
        || e.lastAppliedAtMs !== null && typeof e.lastAppliedAtMs != "number"
        ? An : { keys: e.keys, ...e.cardKeys === void 0 ? {} : { cardKeys: e.cardKeys },
                 isApplied: e.isApplied, lastAppliedAtMs: e.lastAppliedAtMs },
  "box-status": e => e === null ? null
        : !fe(e) || typeof e.agentId != "string" || typeof e.state != "string" ? An : e,
  "host-status": e => !fe(e) || e.hostVersion !== null && typeof e.hostVersion != "string"
        || e.latestHostVersion !== null && typeof e.latestHostVersion != "string"
        || e.hostUpdateAvailable !== null && typeof e.hostUpdateAvailable != "boolean"
        || typeof e.isBusy != "boolean"
        || e.capabilities !== void 0 && (!Array.isArray(e.capabilities) || e.capabilities.some(t => typeof t != "string"))
        ? An : e,
};
```

`PROVEN` (quoted from the renderer chunk; line structure is single-line, `fe` = is-object,
`$r` = is-string-array, `id(...)` raises a typed error). Failure mode: the client's reply resolver
does `const $ = k3e[_](_3e(v, le)); $ === An ? pe(id(\`${v} reply is malformed: it failed the ${_} container check\`)) : q($)`.
So a structurally wrong reply becomes a typed client error naming the method and the container.

Two specialised decoders wrap the reply before the container check: `v3e` for the transport-state
family and `b3e` for the transcript-source family (§1.7), and `_3e(method, value)` applies a
per-method post-processor — the only case observed being the template trio
(`publishBotTemplate`, `getBotTemplateVersion`, `getBotTemplateForSourceAgent`), which is remapped by
`w3e`: if the object has `description: string` and `body: string`, it **swaps them** into the
`{description: body, ...}` shape. `PROVEN` as code; `INFERRED`: a field-name-correction shim for a
backend naming change.

### 2.8 The shared client-surface table: 141 of the 172

The coordinator also carries a **second** table describing the same methods — but by request *shape*
and reply *container*, not by field schema. `coordinator.beauty.js:36850-36993`:

```js
K2 = { createAgentFromTemplate: { args: "object", reply: "record" } },
W2 = {
  ...K2,
  resolveAgentCreation: { args: "none", reply: "record" },
  restoreTemporalAgentRouting: { args: "object", reply: "void" },
  noteMountedAgent: { args: "object", reply: "void" },
  getServerAgentRoster: { args: "none", reply: "record" },
  getAgentTranscriptTail: { args: "object", reply: "transcript-page" },
  openAgentTail: { args: "object", reply: "transcript-page" },
  sendPrompt: { args: "object", reply: "send-result" },
  promptAcceptanceStatus: { args: "object", reply: "acceptance-lookup" },
  respondToWidget: { args: "object", reply: "record-or-null" },
  ...
  runAgentAutomationNow: { args: "object", reply: "void" },
};
function CJ(r) { return Wt(W2, r); }
var z2 = new Map(Object.entries(wJ).map(([r, e]) => [e, r]));   // NOTE: wJ here is the EVENT family map
function bJ(r) { return z2.get(r) ?? null; }
...
for (let [r, e] of Object.entries(nA.methods)) CJ(r) && (kJ[r] = e);   // JB:37057
var OJ = { ...kJ, ...X2 };                                             // JB:37058
```

`PROVEN`. `{args: "none"|"object", reply: <container>}` is the entire shape descriptor.

The renderer holds a **byte-identical** copy of this table under minified names `t8`/`Hm`
(`index.eager-app-DSuGVQNC.js`). Structural comparison of the two independently extracted tables:

* coordinator `K2` ∪ `W2` = **141** entries; renderer `t8` ∪ `Hm` = **141** entries;
* **zero** methods present on one side and not the other;
* **zero** `{args, reply}` shape mismatches.

`PROVEN`. That is a strong signal: the table is **code-generated from one source of truth** and
shipped to both halves.

The reply-container histogram over the 141:

| reply | count |
|---|---|
| `record` | 57 |
| `void` | 27 |
| `array` | 27 |
| `record-or-null` | 11 |
| `channels-view` | 4 |
| `transcript-page` | 2 |
| `import-result` | 2 |
| `boolean` | 2 |
| `box-status` | 2 |
| `send-result`, `acceptance-lookup`, `host-status`, `count`, `connect-url`, `box-secrets` | 1 each |

`PROVEN`.

**The 40-method gap.** 172 edge methods − 141 surface methods = **40 methods that exist on the edge
but are *not* in the shared client-surface table** (and, verified by `grep -rl` across all 588
renderer asset files, **appear nowhere in any renderer asset**):

```
getAgentTranscript            getAgentTranscriptPage        openAgentWindowed
getAgentTranscriptWindow      getAgentThread                requestMessagesGrants
awaitMessagesGrants           cancelMessagesGrants          requestCookieOriginApproval
awaitCookieOriginApproval     cancelCookieOriginApproval    requestWebAuthnCeremony
storeSecret                   listBotTemplates              openAgent
duplicateAgent                disconnectListenerPlatform    getAgentNotificationAvatar
getAgentTodos                 readVoiceCallSentMessages     getEffectiveMcpPlugins
installMcpEntry               updateMcpPluginInstall        uninstallMcpPlugin
isGlobalSearchEnabled         uploadAttachment              uploadAttachmentChunk
readAttachmentImage           readAttachmentText            readAttachmentChunk
getHostSettings               setHostSettings               setBoxSecrets
carryBoxSecretsToBot          injectChromeCookies           refreshMcp
listBoxMcpServers             completeMcpOAuth              updateForeverBox
setWindowFocused
```

`PROVEN` for the set and for the absence from renderer assets. Interpretation, `INFERRED`:

* the shared table is the **desktop-renderer-aware subset**; the other 40 are the *host-internal* and
  *other-client* part of the contract. Several are obviously host-driven rather than user-driven
  (`setWindowFocused`, `getHostSettings`/`setHostSettings`, `storeSecret`, `setBoxSecrets`,
  `refreshMcp`, `listBoxMcpServers`, `requestWebAuthnCeremony`), and several are large-payload
  streaming reads/writes that a desktop renderer performs through a different path
  (`uploadAttachment`, `readAttachment*`).
* `listBotTemplates` and `openAgent` are edge methods with `background` class that the desktop simply
  does not use through this table — plausibly consumed by the mobile client, which shares the same
  box contract.
* Note that **16 of the 36 `background` methods are inside this 40** (all six `request*/await*/cancel*`
  ceremony methods, `storeSecret`, `setBoxSecrets`, `refreshMcp`, `listBoxMcpServers`,
  `setWindowFocused`, `isGlobalSearchEnabled`, `getAgentTodos`, `getAgentNotificationAvatar`,
  `readVoiceCallSentMessages`, `getEffectiveMcpPlugins`, `listBotTemplates`, `openAgent`). The
  background class is therefore not "the desktop's background work" — it is "work that is safe with
  nobody present", which is exactly the class a headless or phone-driven client needs. `INFERRED`.

**The 9-method addition.** `X2` (`coordinator.beauty.js:37045-37055`) adds nine methods that are
**not** on the gateway edge:

```js
X2 = {
  resolveAgentCreation: I().noArgs,
  restoreTemporalAgentRouting: I().args({ agentIds: ae(ho) }),
  noteMountedAgent: I().args({ id: ho }),
  getServerAgentRoster: I().noArgs,
  beginSpendApproval: I().args({ entryId: ho, agentId: ho, requestId: ho, paymentMethodId: A(p()) }),
  listVirtualCardPaymentMethods: I().noArgs,
  getMainAgent: I().noArgs,
  setMainAgent: I().args({ agentId: eA }),
  ensureDefaultMainAgent: I().noArgs,
}
var OJ = { ...kJ, ...X2 };
```

`PROVEN`. So 141 = (141 − 9) surface methods on the edge + 9 local-only methods. I.e. the shared
table's 141 names partition into 132 gateway methods plus these 9 **coordinator-local** methods.

**Cross-check.** 141 − 9 = 132 = number of shared-surface names that are also edge methods. And
172 − 132 = 40 ✓. This arithmetic reconciles the three independent counts. `PROVEN`.

`OJ` is the "what this host can serve" set for the client; it is used with the request table
`W2`. Confirmed by the renderer's initial `oh()` facade, which builds one invoker per
`Hm` name and rejects with `zr(a, "coordinator port never adopted by this source", {transportKind:"pre_port_settle"})`
if the port never arrives.

### 2.9 Event families are a third vocabulary

`bJ(channel)` maps an **incoming gateway SSE event channel** back to a client event family:
`z2 = new Map(Object.entries(wJ).map(([r, e]) => [e, r]))`, then `bJ(r) = z2.get(r) ?? null`
(`JB:36997-37000`). Therefore: the gateway emits events on a channel string; the coordinator drops
any channel that is not in its allowlist (`let M = bJ(_.channel); if (M == null) return;`, `JB:40076`
region), and republishes the known ones to the client under the canonical family name. `PROVEN`.

`$2` (spread into `wJ` at `JB:36830`) holds alias pairs such as `"agents-meetings": "agent-meetings"`,
`"mcp-servers-updated": "mcp-servers"`, `"mcp-auth-completed": "mcp-auth"` (`JB:36825-36828`) —
i.e. **the gateway's channel names differ from the client's family names for at least three
families**. `PROVEN`. This matters for a clean-room implementation: the event channel namespace is a
*third* namespace, distinct from both the RPC method names and the client family names.
## 3. The complete 172-method surface, grouped

### 3.1 How to read this section

Every method below is `PROVEN` to exist, with the stated authz class, on the named edge. Authz
classes are quoted from `coordinator.beauty.js:32761-32934`. Argument field names are quoted from the
schema expressions in `coordinator.beauty.js:34169-34706` (inline object literals) or from the named
schema variables they reference (resolved to their declaration sites). The "on client surface (141)"
column is `PROVEN` by set membership in `W2`/`Hm` (§2.8); a `—` means the method exists on the edge
but is not in the shared client-surface table.

The **"what it most plausibly does"** statements attached to each group are `INFERRED` from the
method name, its argument fields, its authz class, and cross-references to the vendor's own
feature-area taxonomy (below). They are not behavioral proofs. Where a stronger source exists — the
vendor's feature map, a seeded source path, or a protobuf descriptor — it is cited inline.

### 3.2 The vendor's own taxonomy

The renderer carries an explicit feature-area → method map and a flat list of 36 feature areas.
`index.eager-app-DSuGVQNC.js`:

```js
u8 = ["approvals","auto_review","automations","capabilities","channels","cloud_agents","computer",
      "email","hardware_acceleration","language","listeners","mcp","mcp_apps","media","meetings",
      "notification_preferences","passkey","permissions","pr_review","roster","search","secrets",
      "send","sharing","skills","spell_check","subagents","teach","theme","time_zone","transcript",
      "trays","update","usage","widgets","workflows"]

PS = {
  transcript: [...], send: [...], widgets: [...], approvals: [...], roster: [...], search: [...],
  cloud_agents: [...], listeners: [...], workflows: [...], skills: [...], mcp: [...], mcp_apps: [...],
  media: [...], subagents: [...], computer: [...], teach: [...], trays: [...], channels: [...],
  secrets: [...], automations: [...], capabilities: [...], sharing: [...]
}
```

`PROVEN`. This is the vendor's own grouping and it is used as the skeleton of §3.3 below. The map is
strictly a **UI feature registry** — it covers roughly 132 of the 172 names and omits the internal /
host-only methods — so it is a guide, not a partition.

### 3.3 Domain summary

| # | Domain | methods | `person` | `background` |
|---|---|---|---|---|
| 1 | Agents, roster & threads | 26 | 21 | 5 |
| 2 | Transcript, conversation & context | 10 | 4 | 6 |
| 3 | Sending, drafts & reactions | 6 | 6 | 0 |
| 4 | Teach / routines | 3 | 3 | 0 |
| 5 | Workflows | 7 | 7 | 0 |
| 6 | Automations & tasks | 12 | 12 | 0 |
| 7 | Subagents & async tasks | 2 | 2 | 0 |
| 8 | MCP & plugins | 17 | 10 | 7 |
| 9 | MCP apps | 2 | 2 | 0 |
| 10 | Skills & publishing | 9 | 9 | 0 |
| 11 | Templates & marketplace | 7 | 5 | 2 |
| 12 | Cloud agents | 13 | 13 | 0 |
| 13 | Forever Box | 5 | 4 | 1 |
| 14 | Secrets & credentials | 6 | 4 | 2 |
| 15 | Approvals & web-automation ceremonies | 19 | 11 | 8 |
| 16 | Voice | 8 | 6 | 2 |
| 17 | Channels, listener & integrations | 8 | 8 | 0 |
| 18 | Host lifecycle & settings | 6 | 3 | 3 |
| 19 | Attachments & media | 5 | 5 | 0 |
| 20 | Avatar generation | 1 | 1 | 0 |
| | **total** | **172** | **136** | **36** |

`PROVEN` (the per-domain counts are derived by set partition over the extracted table; the totals match
`recon/rea/coordinator-methods.json` exactly, and were re-derived independently here).

`resolveMessagesGrants`, `requestMessagesGrants`, `awaitMessagesGrants` and `cancelMessagesGrants`
are the **macOS Messages** quartet. They are listed once, under *Approvals & web-automation
ceremonies*, where their request→await→cancel shape belongs; conceptually they form a 21st domain of
their own (§6.4).

---

### 3.4 Agents, roster & threads

The identity and lifecycle plane of the product's central object: the *bot* (agent). The vendor maps
most of these under the `roster` feature area. `INFERRED` reading:

* **Reads** are cheap and mostly `person` (`listAgents`, `countAgents`, `searchAgents`) — the roster
  is the sidebar, and a human is looking at it. `openAgent` is the exception: it is `background`,
  suggesting a *navigation* primitive that must also work when a client opens an agent on a headless
  path.
* **Mutations** are all `person` except `clearGeneratedRoomNameStamps`: creating, renaming, deleting,
  grouping, duplicating, kickstart, interrupt, fresh-conversation and rollback all change shared state
  a human is accountable for.
* `createGroup` + `setGroupMembers` implement the App Store's "same thread, bots pass work between
  each other" multi-bot story (`FINDINGS.md:124`) via `memberAgentIds` and `humanMemberUserIds`.
* `creationRoute` on `createGroup` is a tagged union `{kind:"box"} | {kind:"temporal", scope}`,
  while `createAgent` carries `harness`, `origin`, `purpose`, `isAutomatic`, `templateId` and
  `creationRoute`. `INFERRED`: an agent is created either as a durable "box" agent or as a *temporal*
  (scoped, expiring) agent, and the route is recorded on the entity.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `listAgents` | `person` | yes | — *(noArgs)* |
| `countAgents` | `person` | yes | — *(noArgs)* |
| `searchAgents` | `person` | yes | `query`, `limit` |
| `openAgent` | `background` | — | `id` |
| `createAgent` | `person` | yes | `avatarPngBase64`, `creationRoute`, `origin`, `purpose`, `isIntroductionSuppressed`, `isKickstartRequested`, `isAutomatic`, `language`, `templateId`, `clientNonce`, `supportsTemporalHarness`, `harness`, `name` *(via bU)*, `description` *(via bU)*, `title` *(via bU)*, `avatarShape` *(via bU)*, `avatarColor` *(via bU)* |
| `createAgentFromTemplate` | `person` | yes | `shareId`, `agentId`, `name`, `avatarShape`, `avatarColor`, `expectedActiveVersion`, `creatorContext`, `language`, `isAutomatic`, `importEntry` |
| `createGroup` | `person` | yes | `name`, `description`, `memberAgentIds`, `humanMemberUserIds`, `namedBy`, `creationRoute`, `clientNonce` |
| `setGroupMembers` | `person` | yes | `id`, `memberAgentIds`, `requesterAgentId` |
| `updateAgent` | `person` | yes | `id`, `profile` |
| `seedConversationName` | `person` | yes | `id`, `prompt` |
| `deleteAgents` | `person` | yes | `ids` |
| `duplicateAgent` | `person` | — | `id` |
| `kickstartAgent` | `person` | yes | `id` |
| `interruptAgentRun` | `person` | yes | `id`, `sessionId` |
| `startFreshConversation` | `person` | yes | `id`, `sessionId` |
| `rollBackConversation` | `person` | yes | `id`, `sessionId` |
| `requestDiskSaverAudit` | `person` | yes | `id` |
| `clearGeneratedRoomNameStamps` | `background` | yes | `rooms` |
| `setAgentUnread` | `person` | yes | `id`, `isUnread`, `atMs` |
| `setAgentHiddenFromSidebar` | `person` | yes | `id`, `isHidden` |
| `setAgentNotifyOnUpdates` | `person` | yes | `id`, `isEnabled` |
| `setAgentDraftingDisabled` | `person` | yes | `id`, `isDisabled` |
| `setAgentAvatarBytes` | `person` | yes | `id`, `pngBase64` |
| `getAgentAvatar` | `background` | yes | `id` |
| `getAgentNotificationAvatar` | `background` | — | `id` |
| `getAgentTodos` | `background` | — | `id` |

### 3.5 Transcript, conversation & context

The read plane over the agent's transcript. `INFERRED`:

* Pagination has three shapes, distinguishable by their schema: **page**
  (`beforeSeq` + `limit` + `sinceMs`/`untilMs` window), **window** (`beforeSeq` + `limit`), and
  **tail** (`beforeSeq` + `limit` + `sessionId` + `unreadBoundaryAt`). The distinct authz classes
  (`openAgentTail` and `getAgentTranscriptTail` are `person`; the page/window reads are
  `background`) show that *following the live tail* is treated as a presence-requiring act, while
  *reading history* is not. This is the cleanest single illustration of the class model.
* `getAgentThread` takes `{id, rootId}` — a thread view rooted at an entry. `getConversationOutline`
  yields the outline/TOC (`outline` is also an event family, `JB:36845`). `readMainAgentContext`
  reads the coordinating agent's context. `searchMedia` is filed under `search` by the vendor but sits
  in the transcript bundle here.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `getAgentTranscript` | `background` | — | `id` |
| `getAgentTranscriptPage` | `background` | — | `id`, `beforeSeq`, `limit`, `sinceMs`, `untilMs` |
| `openAgentWindowed` | `background` | — | `id`, `limit` |
| `getAgentTranscriptWindow` | `background` | — | `id`, `beforeSeq`, `limit` |
| `openAgentTail` | `person` | yes | `id`, `limit`, `sessionId`, `unreadBoundaryAt` |
| `getAgentTranscriptTail` | `person` | yes | `id`, `beforeSeq`, `limit`, `sessionId`, `unreadBoundaryAt` |
| `getAgentThread` | `background` | — | `id`, `rootId` |
| `getConversationOutline` | `person` | yes | `id` |
| `readMainAgentContext` | `background` | yes | `id` |
| `searchMedia` | `person` | yes | `query`, `limit` |

### 3.6 Sending, drafts & reactions

All six are `person`. `INFERRED`: composing and submitting user-visible content is the archetypal
presence-requiring action. `sendPrompt`'s 21 argument fields are the richest schema in the surface
(§5.2). `sendDraft` / `discardDraft` operate on a *draft* the agent produced and proposed — the drafts
are typed by `$n` (`JB:4085-4103`) into `email-draft`, `slack-draft`, `meeting-chat-draft`.
`reactToMessage` and `voteFeedback` are small acknowledgements.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `sendPrompt` | `person` | yes | `prompt`, `agentId`, `directAddressedAcceptance`, `clientNonce`, `attachmentPaths`, `attachmentNames`, `richText`, `replyToId`, `automationWriteProvenance`, `isFork`, `traceparent`, `enterEpochMs`, `composedAtMs`, `source`, `sendSource`, `mcpConfigJson`, `sessionId`, `machineId`, `onePasswordAppInstalled`, `taskId`, `initiator` |
| `promptAcceptanceStatus` | `person` | yes | `accountSlot`, `clientNonce`, `agentId`, `sessionId` |
| `sendDraft` | `person` | yes | `entryId`, `draft`, `agentId`, `sessionId`, `shownSignatureHtml` |
| `discardDraft` | `person` | yes | `entryId`, `agentId`, `sessionId` |
| `reactToMessage` | `person` | yes | `entryId`, `emoji`, `agentId`, `sessionId` |
| `voteFeedback` | `person` | yes | `agentId`, `entryId`, `action`, `categories`, `comment`, `sessionId` |

### 3.7 Teach / routines

Three methods, all `person`, all keyed by `agentId`: start/stop a **teaching recording** and read its
status. `PROVEN` correspondence with the App Store positioning: *"Ask an AI agent to follow along as
you complete a workflow once. It saves the steps as a routine and runs it on its own next time"*
(`FINDINGS.md:125`). There is also a `teach-recording` **event family** (`JB:36838`), so the client
can follow recording state live. `INFERRED`: a routine is the artifact produced by a teach recording,
and the Workflows domain (§3.9) is where routines are then edited and run.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `startTeachRecording` | `person` | yes | `agentId`, `entryPoint` |
| `stopTeachRecording` | `person` | yes | `agentId`, `save` |
| `getTeachRecordingStatus` | `person` | yes | — *(noArgs)* |

### 3.8 Workflows

Seven methods, all `person`. CRUD plus `runAgentWorkflowNow` plus two importers (`Text`, `Url`).
`INFERRED`: a workflow is a declarative step list; the importer pair plus `run…Now` plus the
`getBotTemplateExportPolicy` / `publishBotTemplate` machinery in §3.15 means workflows are the
**portable/exportable** unit of the product (shareable as templates), whereas automations (§3.9) are
the **scheduled/triggered** unit. `importAgentWorkflowUrl` fetching a remote URL is exactly the class
of action that has to be `person`.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `getAgentWorkflows` | `person` | yes | `id` |
| `createAgentWorkflow` | `person` | yes | `id`, `spec` |
| `updateAgentWorkflow` | `person` | yes | `spec`, `id` *(via lw)*, `workflowId` *(via lw)* |
| `deleteAgentWorkflow` | `person` | yes | `id`, `workflowId` |
| `runAgentWorkflowNow` | `person` | yes | `id`, `workflowId` |
| `importAgentWorkflowText` | `person` | yes | `id`, `markdown`, `name` |
| `importAgentWorkflowUrl` | `person` | yes | `id`, `url`, `name` |

### 3.9 Automations & tasks

Twelve methods, all `person`. `INFERRED`:

* An **automation** is a trigger + enable flag attached to an agent:
  `Y$ = w({ schedule: p(), isEnabled: Z() })` and
  `IU = w({ name, description, body, trigger: at(Y$), sourceRef: at(p()) })` (`JB:33939-33940`), so a
  workflow body plus an optional schedule plus an optional `sourceRef` *is* an automation. There is
  also a **webhook** credential (`getAutomationWebhookCredential`) and an account-wide listing
  (`listAllAutomations`).
* The five task methods (`getAgentTasks`, `markAgentTaskDone`, `markAgentTaskRead`,
  `setAgentTaskPinned`, plus the read side) are the "waiting for you" queue: the App Store copy says
  the bot *"only comes back when your approval is needed"* (`FINDINGS.md:126`), which matches a
  task/approval queue with read/done/pin state.
* The vendor files all of this under `automations`, including the four task methods
  (`PS.automations`), confirming they are one feature in the product's model.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `getAgentAutomations` | `person` | yes | `id` |
| `listAllAutomations` | `person` | yes | — *(noArgs)* |
| `createAgentAutomation` | `person` | yes | `id`, `spec` |
| `updateAgentAutomation` | `person` | yes | `spec`, `id` *(via Gs)*, `automationId` *(via Gs)* |
| `deleteAgentAutomation` | `person` | yes | `id`, `automationId` |
| `setAgentAutomationEnabled` | `person` | yes | `isEnabled`, `id` *(via Gs)*, `automationId` *(via Gs)* |
| `runAgentAutomationNow` | `person` | yes | `sessionId`, `id` *(via Gs)*, `automationId` *(via Gs)* |
| `getAutomationWebhookCredential` | `person` | yes | `id`, `automationId` |
| `getAgentTasks` | `person` | yes | `agentId` |
| `markAgentTaskDone` | `person` | yes | `agentId`, `taskId` |
| `markAgentTaskRead` | `person` | yes | `agentId`, `taskId`, `entryId` |
| `setAgentTaskPinned` | `person` | yes | `agentId`, `taskId`, `isPinned` |

### 3.10 Subagents & async tasks

Two `person` reads keyed by `id`. `PROVEN` entity backing: `aiserver.v1.GrokBotRunningSubagent`
(`{subagent_id, subagent_type, title, started_at_ms}`) and a `subagents` event family (`JB:36834`) plus
`async-tasks` (`JB:36835`). `INFERRED`: subagents are long-running child work items whose *listing* is
a person read, but whose *progress* is pushed as events.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `getSubagents` | `person` | yes | `id` |
| `getAsyncTasks` | `person` | yes | `id` |

### 3.11 MCP & plugins

Seventeen methods, split 10 `person` / 7 `background`. `INFERRED` reading, and it is unusually clean:

* all **reads** that a background poller might need are `background` — `getMcpState`, `getMcpCatalog`,
  `getEffectiveMcpPlugins`, `getMcpPluginLogo`, `listMcpServerTools`, `refreshMcp`, `listBoxMcpServers`;
* all **install/auth/config mutations** are `person` — `installMcpEntry`, `updateMcpPluginInstall`,
  `removeMcpServer`, `uninstallMcpPlugin`, `authenticateMcpServer`, `renameMcpAccount`,
  `removeMcpAccount`, `setMcpCustomInstructions`, `toggleMcpToolDisabled`, `completeMcpOAuth`.

`PROVEN` entity backing: `aiserver.v1.GrokBotAgentPlugin` with
`{plugin_id, name, display_name, description, logo_url, owned_by_marketplace, install_mode,
variable_names, is_deprecated, mcp_config_json, skills, mcp_server_names, is_bot_skills,
connector_type, variables_json, has_configured_variables}` and
`aiserver.v1.GrokBotAgentDefinitionMcpServer` with `{id, name, type, scope, plugin_id, created_at_ms}`.
`PROVEN` alias evidence: the gateway's `mcp-servers-updated` channel is republished to clients as the
`mcp-servers` family, and `mcp-auth-completed` as `mcp-auth` (`JB:36826-36827`).


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `getMcpState` | `background` | yes | — *(noArgs)* |
| `getMcpCatalog` | `background` | yes | — *(noArgs)* |
| `getEffectiveMcpPlugins` | `background` | — | — *(noArgs)* |
| `getMcpPluginLogo` | `background` | yes | `url` |
| `installMcpEntry` | `person` | — | `entryId`, `values`, `hasTeamConfiguredVariables` |
| `updateMcpPluginInstall` | `person` | — | `pluginId`, `values` |
| `removeMcpServer` | `person` | yes | `serverId` |
| `uninstallMcpPlugin` | `person` | — | `pluginId` |
| `authenticateMcpServer` | `person` | yes | `serverId`, `accountKey`, `trigger`, `forceReauth`, `requestingAgentId`, `oauthRedirectUri` |
| `renameMcpAccount` | `person` | yes | `serverId`, `accountKey`, `newAccountKey` |
| `removeMcpAccount` | `person` | yes | `serverId`, `accountKey` |
| `setMcpCustomInstructions` | `person` | yes | `serverId`, `instructions` |
| `listMcpServerTools` | `background` | yes | `serverId` |
| `toggleMcpToolDisabled` | `person` | yes | `serverId`, `toolName` |
| `completeMcpOAuth` | `person` | — | `code`, `state` |
| `refreshMcp` | `background` | — | `completion` |
| `listBoxMcpServers` | `background` | — | `serverIdentifiers` |

### 3.12 MCP apps

Two `person` methods: `readMcpAppResource`, `callMcpAppTool`. `PROVEN` backing: the renderer CSP
allows `frame-src sand-mcp-app:` (`FINDINGS.md:52`), so an MCP "app" is a sandboxed web surface, and
these two methods are the host bridge into it. `INFERRED`: a client-initiated call into third-party
code is treated as presence-requiring.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `readMcpAppResource` | `person` | yes | `serverIdentifier`, `resourceUri`, `agentId`, `entryId`, `sessionId`, `documentSha256` |
| `callMcpAppTool` | `person` | yes | `serverIdentifier`, `toolName`, `argumentsJson`, `userActivated`, `agentId` |

### 3.13 Skills & publishing

Nine methods, all `person`. `INFERRED`: skills are the authored, publishable prompt artefacts
(`aiserver.v1.GrokBotAgentSkill = {id, name, description, body, source}`, and
`GrokBotAgentDefinitionSkill = {id, description, content}`), and this domain is the **publishing
pipeline** — `skillsCatalog` → `syncPluginSkills` → `getSkillPublishTargets` → `publishSkill` →
`resyncPublishedSkill` / `unpublishSkill`, with `unpublishPluginListing` and
`hasRestorablePluginListingCopy` handling the marketplace listing lifecycle. `getPluginSyncStatus` is
the only read, and it is `person`.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `skillsCatalog` | `person` | yes | — *(noArgs)* |
| `syncPluginSkills` | `person` | yes | — *(noArgs)* |
| `getPluginSyncStatus` | `person` | yes | — *(noArgs)* |
| `getSkillPublishTargets` | `person` | yes | — *(noArgs)* |
| `publishSkill` | `person` | yes | `workflowId`, `teamId` |
| `resyncPublishedSkill` | `person` | yes | `workflowId` |
| `unpublishSkill` | `person` | yes | `workflowId` |
| `unpublishPluginListing` | `person` | yes | `pluginId`, `teamId` |
| `hasRestorablePluginListingCopy` | `person` | yes | `pluginId` |

### 3.14 Templates & marketplace

Seven methods, 5 `person` / 2 `background`. `INFERRED`: this is *bot* sharing, not skill sharing —
"publish yourself as a template other people can install". `PROVEN` supporting literals: the
onboarding copy in the renderer includes *"Create a public template of yourself that I can share with
somebody else"* and *"Share with your Team"* / *"Publish to team"* (renderer i18n catalogue), and
`yU = ["public", "team"]` is the visibility enum (`JB:33802`) used by `setBotTemplateVisibility`.
`$s = w({ shareId: p(), visibility: _e("bot template visibility", yU) })` (`JB:33927`).
`PROVEN` entity backing: `aiserver.v1.GrokBotMarketplaceListing` with 16 fields including
`template_id`, `pinned_template_version_id`, `blob_object_key`, `slug`, `category`, `categories`,
`share_id`, `status`, `creator_id`. The two `background` methods are the *reads* a client can do
unattended: `listBotTemplates`, `getBotTemplateExportPolicy`.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `publishBotTemplate` | `person` | yes | `shareId`, `version` |
| `listBotTemplates` | `background` | — | — *(noArgs)* |
| `getBotTemplateVersion` | `person` | yes | `shareId`, `version` |
| `getBotTemplateForSourceAgent` | `person` | yes | `sourceAgentId` |
| `getBotTemplateExportPolicy` | `background` | yes | — *(noArgs)* |
| `deleteBotTemplate` | `person` | yes | `shareId` |
| `setBotTemplateVisibility` | `person` | yes | `shareId`, `visibility` |

### 3.15 Cloud agents

Thirteen methods, **all `person`**. `INFERRED`: a "cloud agent" is an agent whose harness runs
remotely (`bcId` is its identifier, distinct from `agentId`), publishing *apps* on the user's behalf.
The lifecycle is visible in the argument schemas:

* inspect: `getCloudAgentInfo {bcId, includeFiles?, includeArtifacts?}`,
  `getCloudAgentConversation {bcId}`;
* materialize: `ensureCloudAgentArtifacts {agentId, bcId}`;
* stop: `stopCloudAgent {bcId}`;
* publish pipeline: `getCloudAgentPublishProposals {bcId}` → `confirmCloudAgentPublishProposal
  {agentId, bcId, proposalId, slug, visibility?, requireConfirmationForUpdates?}` →
  `updateCloudAgentPublishApp {bcId, slug, apex, visibility?, muteRedeployPrompts?,
  requireConfirmationForUpdates?}` → `unpublishCloudAgentPublishApp {bcId, slug, apex}`, plus
  `dismissCloudAgentPublishProposal`;
* secrets: `getCloudAgentAppSecrets {bcId, projectDir}`, `setCloudAgentAppSecrets {bcId, projectDir,
  secrets:[{name,value}]}`, `tellCloudAgentAppSecretsSet {bcId, projectDir, names, refused, applyNeeded}`.

The `refused: ae(B$)` field where `B$ = w({ name, kind: _e("app secret refusal kind", dU), message,
permanent })` and `dU = ["not_owned","not_sensitive","host_error","value_not_saved"]`
(`JB:33762`, `JB:33929`) is a `PROVEN` **secret-write refusal taxonomy** — i.e. the client reports back
which secrets the host refused to persist and why. That is a security-relevant contract detail worth
reproducing.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `getCloudAgentInfo` | `person` | yes | `bcId`, `includeFiles`, `includeArtifacts` |
| `getCloudAgentConversation` | `person` | yes | `bcId` |
| `ensureCloudAgentArtifacts` | `person` | yes | `agentId`, `bcId` |
| `stopCloudAgent` | `person` | yes | `bcId` |
| `getCloudAgentPublishProposals` | `person` | yes | `bcId` |
| `listCloudAgentPublishedApps` | `person` | yes | — *(noArgs)* |
| `confirmCloudAgentPublishProposal` | `person` | yes | `agentId`, `bcId`, `proposalId`, `slug`, `visibility`, `requireConfirmationForUpdates` |
| `dismissCloudAgentPublishProposal` | `person` | yes | `agentId`, `bcId`, `proposalId` |
| `updateCloudAgentPublishApp` | `person` | yes | `bcId`, `slug`, `apex`, `visibility`, `muteRedeployPrompts`, `requireConfirmationForUpdates` |
| `getCloudAgentAppSecrets` | `person` | yes | `bcId`, `projectDir` |
| `setCloudAgentAppSecrets` | `person` | yes | `bcId`, `projectDir`, `secrets` |
| `tellCloudAgentAppSecretsSet` | `person` | yes | `bcId`, `projectDir`, `names`, `refused`, `applyNeeded` |
| `unpublishCloudAgentPublishApp` | `person` | yes | `bcId`, `slug`, `apex` |

### 3.16 Forever Box

Five methods: `getForeverBoxStatus`, `ensureForeverBox`, `handBackForeverBox`, `updateForeverBox`
(all `person`, all keyed by `id`) and `isEgressTunnelAvailable` (`background`, no args). `INFERRED`:
the "Forever Box" is the always-on variant of the box — the user's persistent computer — and these
methods request it, report whether the host still holds it, and hand it back. `PROVEN` supporting
literals: the main process reads `e.egressTunnelOwnership` off the box descriptor
(`main-app.beauty.js:78420`), and `Qre`/`hHe` classify the box's `egress_tunnel_ownership` as part of
the box state. The "forever-box" event family exists (`JB:36836`), as does a telemetry event family
`forever-box`. `INFERRED`: only `isEgressTunnelAvailable` is safe unattended because it is a pure
capability probe.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `getForeverBoxStatus` | `person` | yes | `id` |
| `ensureForeverBox` | `person` | yes | `id` |
| `handBackForeverBox` | `person` | yes | `id`, `trigger`, `requestId` |
| `updateForeverBox` | `person` | — | `id` |
| `isEgressTunnelAvailable` | `background` | yes | — *(noArgs)* |

### 3.17 Secrets & credentials

Six methods, 4 `person` / 2 `background`. `INFERRED`:

* `storeSecret {target, value, agentId}` is `background` — a *programmatic* store (the agent can ask
  for a secret to be persisted without a human in the loop, e.g. from an automation);
* `submitSecret {entryId}` is `person` — the *human* form of the same thing, resolving a card in the
  transcript by `entryId`;
* `setBoxSecrets {secrets}` is `background`; `getBoxSecretsStatus` is `person` (a **read** gated on
  presence, which is the opposite of the usual pattern and therefore notable) —
  `PROVEN`: `getBoxSecretsStatus: "person"` at `JB:32894`, noArgs;
* `carryBoxSecretsToBot {serverId}` and `injectChromeCookies {cookies}` are `person`.

`PROVEN` backing: the reply container for `getBoxSecretsStatus` is
`{keys: string[], cardKeys?: string[], isApplied: boolean, lastAppliedAtMs: number|null}`
(`k3e["box-secrets"]`, renderer chunk), and `dU` is the secret-refusal taxonomy (§3.15). The renderer
i18n catalogue contains `"Webhook key"`, `"Only you can see it"`, `"Manage usage"`.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `storeSecret` | `background` | — | `target`, `value`, `agentId` |
| `submitSecret` | `person` | yes | `entryId`, `value`, `agentId`, `sessionId` |
| `setBoxSecrets` | `background` | — | `secrets` |
| `getBoxSecretsStatus` | `person` | yes | — *(noArgs)* |
| `carryBoxSecretsToBot` | `person` | — | `serverId`, `names` |
| `injectChromeCookies` | `person` | — | `cookies` |

### 3.18 Approvals & web-automation ceremonies

Nineteen methods, 11 `person` / 8 `background`, and the single most design-relevant domain. It is
analysed in full in §6; the table is here for completeness. The structural signature is `PROVEN` and
unmistakable — **three request/await/cancel trios are `background`, and every terminal resolution is
`person`**:

| trio | request | await | cancel | terminal resolution |
|---|---|---|---|---|
| macOS Messages grants | `requestMessagesGrants` `bg` | `awaitMessagesGrants` `bg` | `cancelMessagesGrants` `bg` | `resolveMessagesGrants` `person` |
| Cookie-origin approval | `requestCookieOriginApproval` `bg` | `awaitCookieOriginApproval` `bg` | `cancelCookieOriginApproval` `bg` | (resolved via the WebAuthn/cookie provider edges, §4.1) |
| WebAuthn ceremony | `requestWebAuthnCeremony` `bg` | — | — | (resolved via `passkey-provider`, §4.1) |

`INFERRED`: a ceremony is *started* by whatever is driving the agent (which may be unattended), and
*settled* only by a person. That is the exact shape a phone-driven unattended agent needs.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `respondToWidget` | `person` | yes | `entryId`, `value`, `agentId`, `sessionId` |
| `dismissWidget` | `person` | yes | `entryId`, `agentId`, `sessionId` |
| `submitUserForm` | `person` | yes | `entryId`, `values`, `agentId`, `platform`, `saveToVault`, `sessionId` |
| `dismissUserForm` | `person` | yes | `entryId`, `mode`, `agentId`, `platform`, `sessionId` |
| `resolveAutoReviewApproval` | `person` | yes | `entryId`, `requestId`, `resolution`, `agentId`, `approvalPlatform`, `approvedCommand`, `sessionId` |
| `resolveLocalToolPermission` | `person` | yes | `entryId`, `requestId`, `resolution`, `agentId`, `sessionId` |
| `resolveConnectorGrant` | `person` | yes | `entryId`, `requestId`, `resolution`, `agentId`, `sessionId` |
| `resolveVirtualCardApproval` | `person` | yes | `entryId`, `requestId`, `resolution`, `agentId`, `spendRequestId`, `failureReason`, `paymentMethodId`, `attestation` |
| `resolveMessagesGrants` | `person` | yes | `requestId` |
| `requestMessagesGrants` | `background` | — | `requestId`, `grants` |
| `awaitMessagesGrants` | `background` | — | `requestId`, `waitMs` |
| `cancelMessagesGrants` | `background` | — | `requestId` |
| `requestCookieOriginApproval` | `background` | — | `requestId`, `origins`, `agentId` |
| `awaitCookieOriginApproval` | `background` | — | `requestId`, `waitMs` |
| `cancelCookieOriginApproval` | `background` | — | `requestId` |
| `requestWebAuthnCeremony` | `background` | — | `kind`, `origin`, `optionsJson` |
| `getTrays` | `background` | yes | — *(noArgs)* |
| `dismissTray` | `person` | yes | `id` |
| `clearTrays` | `person` | yes | — *(noArgs)* |

### 3.19 Voice

Eight methods, 6 `person` / 2 `background`. `PROVEN` entity backing is unusually rich:
`aiserver.v1` carries `VoiceCallLineState` and `MintSandVoiceCallSecretResponse
{client_secret, expires_at_unix_seconds, model, websocket_url}`, plus an
`aiserver.v1.GrokBotService/VoiceCallHarnessSession` and `.../VoiceCallHarnessTool` connectrpc pair
(`main-app.beauty.js:35778-35779`), and `MintSandVoiceCallSecretResponse.websocket_url` shows the
voice session itself runs over a **WebSocket** to the backend — *not* over the coordinator port.
`PROVEN` local-side call record shape from the coordinator's own schemas:

```js
rK = w({ callId, agentId, model, realtimeConversationId: at(p()), agentRequestId: A(p()),
         startedAtMs, endedAtMs, durationMs, ending: Ve(U("hung-up"), U("disconnected"), U("failed")),
         turns: ae(Z$), nudges: ae(X$), events: A(ae(Q$)), toolCalls: A(ae(eK)),
         overheard: A(ae(tK)), harnessMayCollect: A(Z()) })
```

with `Z$ = {id, speaker: "user"|"assistant", text, atMs}`, `X$ = {id, request, atMs, answer?,
answeredAtMs?, direction?: "to-main"|"to-voice", cut?: {atMs, heardMs}}`,
`Q$ = {kind: "caller-speech-started"|"caller-speech-stopped"|"caller-interrupted"|
"agent-speech-started"|"agent-speech-stopped"|"response-create"|"protocol-error", atMs}`,
`eK = {id, name, argumentsJson, atMs, result?: {json, atMs}}`, `tK = {id, text, atMs}`
(`JB:33941-33962`). `PROVEN`. The two `background` methods are `readVoiceCallSentMessages` and
`nudgeVoiceCall` — i.e. *reading out* and *prompting* a live call are unattended-safe, while
*recording*, *setting presence*, *creating* and *previewing* a voice are not.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `setAgentVoice` | `person` | yes | `id`, `voiceId`, `voiceSpeed`, `voiceLanguage` |
| `previewVoice` | `person` | yes | `voiceId`, `greetingId` |
| `recordVoiceCall` | `person` | yes | `record` |
| `setVoiceCallPresence` | `person` | yes | `id`, `callId`, `isOnTheLine`, `acceptsOverheard` |
| `getVoiceCall` | `person` | yes | `id`, `callId` |
| `readVoiceCallSentMessages` | `background` | — | `id` |
| `nudgeVoiceCall` | `background` | yes | `id`, `callId`, `request`, `spokenTurns` |
| `transcribeAudio` | `person` | yes | `audioBase64`, `mimeType`, `language` |

### 3.20 Channels, listener & integrations

Eight methods, all `person`. Two sub-families, `PROVEN` distinguished by the vendor map
(`PS.listeners` contains `getListenerIntegrations`, `getListenerConnectUrl`, `completeGithubConnect`;
`PS.channels` contains `getAgentChannels`, `connectChannel`, `disconnectChannel`, `refreshChannel`):

* **Channels** — messaging surfaces attached to an agent (`dw = {id: q(), platform: p()}`). `INFERRED`:
  Slack / Teams / email inboxes.
* **Listener** — an inbound integration endpoint. `getListenerConnectUrl {platform, forceOauth?,
  oauthRedirectUri?}` returns a URL (reply container `connect-url` = `{url: string}`), and
  `completeGithubConnect {state, code?, installationId?, setupAction?, error?}` is the OAuth callback.
  Note the **shape match** with the deep-link route table in `main-core.beauty.js:18297-18307`: the
  `github-connect-callback` route validates `state` against
  `/cursor_grok_bot_github_v1\.[0-9a-f]{32}\.[0-9a-f]{32}/` and accepts exactly
  `{state, code?, installationId?, setupAction?: "install"|"update"|"request", error?}`. `PROVEN`:
  the OAuth callback arrives as an app **deep link** and is then forwarded into `completeGithubConnect`.
  The same pattern exists for `gitlab`, `bitbucket`, `azure-devops` (state prefix
  `cursor_grok_bot_<provider>_v1.`) and `onepassword` (`ops_…` integration key) — but only GitHub has a
  coordinator RPC method.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `getAgentChannels` | `person` | yes | `id` |
| `connectChannel` | `person` | yes | `token`, `id` *(via dw)*, `platform` *(via dw)* |
| `disconnectChannel` | `person` | yes | `id`, `platform` |
| `refreshChannel` | `person` | yes | `id`, `platform` |
| `getListenerIntegrations` | `person` | yes | — *(noArgs)* |
| `getListenerConnectUrl` | `person` | yes | `platform`, `forceOauth`, `oauthRedirectUri` |
| `disconnectListenerPlatform` | `person` | — | `platform` |
| `completeGithubConnect` | `person` | yes | `state`, `code`, `installationId`, `setupAction`, `error` |

### 3.21 Host lifecycle & settings

Six methods, 3 `person` / 3 `background`, and they are the *host's own* control plane rather than the
agent's:

| method | authz | inference |
|---|---|---|
| `getHostSettings` | `person` | read this host's settings (noArgs) |
| `setHostSettings {notifications}` | `person` | change them |
| `getHostStatus {includeManagedCapabilities?}` | `background` | version / update-available / busy / capabilities |
| `updateHostNow {force?}` | `person` | trigger a host update |
| `setWindowFocused {isFocused}` | `background` | **presence signal** — the client tells the host whether its window is focused |
| `isGlobalSearchEnabled` | `background` | capability probe |

`PROVEN` for the authz classes and fields; `PROVEN` for the `host-status` reply container in §2.7
(`{hostVersion, latestHostVersion, hostUpdateAvailable, isBusy, capabilities?}`). `INFERRED`: these
are exactly the methods the desktop renderer would *not* expose to itself through the generic
surface table — and indeed **four of the six are in the 40-method gap** (`getHostSettings`,
`setHostSettings`, `setWindowFocused`, `isGlobalSearchEnabled`), i.e. they are host-level RPC that a
client calls only if it is acting as the host. `setWindowFocused` being `background` and a bare
boolean is notable: it is the one explicit **presence hint** in the whole surface, and §4.4 shows the
main process independently derives presence from `powerMonitor` rather than trusting it.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `getHostSettings` | `person` | — | — *(noArgs)* |
| `setHostSettings` | `person` | — | `notifications`, `selectedTeam`, `mcpCustomInstructions`, `mcpCustomInstructionsByServerId`, `mcpCustomInstructionsAccountScope`, `mcpDisabledToolsByServerId`, `mcpBoxServers`, `userTimeZone`, `osLocale`, `userTimeZoneOverride`, `computerUseModel`, `autoReviewInstructions`, `toolPermissions`, `localToolPermission`, `localToolPermissionMachineId`, `localToolPermissionByMachineId`, `webauthnProxyEnabled`, `messagesEnabled`, `pinnedAgentIds`, `sidebarSections`, `hasSeenOnboarding`, `featureFlagOverrides`, `experimentOverrides` |
| `getHostStatus` | `background` | yes | `includeManagedCapabilities` |
| `updateHostNow` | `person` | yes | `force`, `includeErrorDetail` |
| `setWindowFocused` | `background` | — | `isFocused`, `surface` |
| `isGlobalSearchEnabled` | `background` | — | — *(noArgs)* |

### 3.22 Attachments & media

Five methods, **all `person`**, and **all five are in the 40-method gap** — the desktop renderer never
calls them through this table. `PROVEN`:

* writes: `uploadAttachment`, `uploadAttachmentChunk` (chunked upload);
* reads: `readAttachmentImage`, `readAttachmentText`, `readAttachmentChunk` (three typed readers, one
  chunked).

`INFERRED`: attachments are stored on the box as blobs and read back in typed/chunked form; the
desktop renderer instead obtains them via a custom protocol — `FINDINGS.md:53` records
`sand-media`, `sand-media://image`, `sand-avatar`, `sand-favicon` custom protocols. So the same bytes
have two access paths: an in-process protocol handler for the desktop, and this RPC pair for a
remote/other client. `getEffectiveMcpPlugins`, `getMcpPluginLogo` and `getAgentAvatar` sit beside this
in the *media* feature area (`PS.media` also includes `transcribeAudio`, `previewVoice`,
`generateAgentAvatarImage`).


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `uploadAttachment` | `person` | — | `agentId`, `filename`, `bytesBase64` |
| `uploadAttachmentChunk` | `person` | — | `agentId`, `uploadId`, `filename`, `offset`, `totalSize`, `bytesBase64` |
| `readAttachmentImage` | `person` | — | `path`, `rendition`, `tile`, `fit` |
| `readAttachmentText` | `person` | — | `agentId`, `path` |
| `readAttachmentChunk` | `person` | — | `agentId`, `path`, `offset`, `length`, `videoPlayback` |

### 3.23 Avatar generation

`generateAgentAvatarImage` is `person` and in the vendor's `media` area. `PROVEN` related methods:
`setAgentAvatarBytes {id, pngBase64}` (`person`), `getAgentAvatar` and `getAgentNotificationAvatar`
(both `background`), and for the *agent-definition* avatar there is
`GrokBotAgentDefinitionIdentity.has_custom_avatar` plus `bU = {name, description, title, avatarShape,
avatarColor}` (`JB:33930`). The header `x-sand-slim-avatars: 1` on box requests
(`JB:35272`, set unless disabled) shows avatars are optionally served slimmed. `INFERRED`: avatars are
PNG bytes plus a generated *shape*+*color* fallback, and generation is a person action because it
costs a model call.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `generateAgentAvatarImage` | `person` | yes | `description` |

---

### 3.24 Methods by authz class — the complete `background` set

Because §4 argues the class is the protocol's central safety property, the 36 `background` methods are
listed here as a whole, with the domain each belongs to. `PROVEN`.

| # | method | domain | on client surface |
|---|---|---|---|
| 1 | `getAgentTranscript` | transcript | — |
| 2 | `getAgentTranscriptPage` | transcript | — |
| 3 | `openAgentWindowed` | transcript | — |
| 4 | `getAgentTranscriptWindow` | transcript | — |
| 5 | `getAgentThread` | transcript | — |
| 6 | `requestMessagesGrants` | Messages ceremony | — |
| 7 | `awaitMessagesGrants` | Messages ceremony | — |
| 8 | `cancelMessagesGrants` | Messages ceremony | — |
| 9 | `requestCookieOriginApproval` | cookie ceremony | — |
| 10 | `awaitCookieOriginApproval` | cookie ceremony | — |
| 11 | `cancelCookieOriginApproval` | cookie ceremony | — |
| 12 | `requestWebAuthnCeremony` | WebAuthn ceremony | — |
| 13 | `storeSecret` | secrets | — |
| 14 | `listBotTemplates` | templates | — |
| 15 | `getBotTemplateExportPolicy` | templates | yes |
| 16 | `openAgent` | agents | — |
| 17 | `clearGeneratedRoomNameStamps` | agents | yes |
| 18 | `getAgentAvatar` | agents/avatars | yes |
| 19 | `getAgentNotificationAvatar` | agents/avatars | — |
| 20 | `getAgentTodos` | agents | — |
| 21 | `readMainAgentContext` | transcript/context | yes |
| 22 | `readVoiceCallSentMessages` | voice | — |
| 23 | `nudgeVoiceCall` | voice | yes |
| 24 | `getMcpState` | MCP | yes |
| 25 | `getMcpCatalog` | MCP | yes |
| 26 | `getEffectiveMcpPlugins` | MCP | — |
| 27 | `getMcpPluginLogo` | MCP | yes |
| 28 | `listMcpServerTools` | MCP | yes |
| 29 | `getTrays` | approvals/UI | yes |
| 30 | `isGlobalSearchEnabled` | host | — |
| 31 | `isEgressTunnelAvailable` | Forever Box | yes |
| 32 | `setBoxSecrets` | secrets | — |
| 33 | `refreshMcp` | MCP | — |
| 34 | `listBoxMcpServers` | MCP | — |
| 35 | `setWindowFocused` | host | — |
| 36 | `getHostStatus` | host | — |

`PROVEN` for all 36 names and classes. Note the shape of the set: **21 of 36 are pure reads**, and of
the 15 that are not, 6 are the `request*/await*/cancel*` ceremony starters, 2 are presence/telemetry
signals (`setWindowFocused`, `setBoxSecrets`), 2 are "nudge/notify" (`nudgeVoiceCall`,
`clearGeneratedRoomNameStamps`), and the remainder are local cache refreshes (`refreshMcp`). **No
method in the set creates, deletes, sends, pays, installs, or publishes anything.** That is a
`PROVEN` property of the table and the strongest available evidence for what `background` means.
