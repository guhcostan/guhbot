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
| `recon/beautified/node-agent-coordinator.beauty.js` (40,341 lines) | prettier-formatted `dist/node-agent-coordinator/main.cjs`. Primary source. |
| `recon/beautified/main-app.beauty.js` (109,422 lines) | prettier-formatted `dist/electron-main/main-app.cjs`. Host side: spawn, handoff, restart. |
| `recon/beautified/main-core.beauty.js` (40,709 lines) | prettier-formatted `dist/electron-main/main-core.cjs`. Env surface, deep-link routes. |
| `recon/beautified/preload.beauty.js` (4,151 lines) | prettier-formatted `dist/electron-preload/preload.cjs`. contextBridge + port claim. |
| `recon/beautified/local-exec-daemon.beauty.js` | prettier-formatted `dist/local-exec-daemon/main.cjs`. |
| `recon/grokbot-0.71.2/dist/renderer/assets/index.eager-app-DSuGVQNC.js` (1,801,380 bytes) | the renderer entry chunk. Contains the *client* half of the contract. |
| `recon/rea/coordinator-methods.json` | pre-extracted `{method, auth}` table, 172 entries. Independently re-derived in this section. |
| `recon/FINDINGS.md` | prior working notes. |

### Notation

* **`PROVEN`** — a literal string, identifier, numeric constant, or control-flow fact was read at
  the cited location. Quotes are verbatim from the beautified bundles.
* **`INFERRED`** — the claim is a reasoned reading of proven facts. The reasoning is stated inline.
* **`UNKNOWN`** — not resolvable from available evidence; the reason is given.
* Line citations are `file:line` against the **beautified** files listed above. `node-agent-node-agent-coordinator.beauty.js:34168`
  means line 34169 of `recon/beautified/node-agent-coordinator.beauty.js`.
* `JB:NNN` is shorthand for `node-agent-coordinator.beauty.js:NNN` inside tables where the column is already
  labelled, used only to keep tables narrow.

### Minifier caveat (read this before quoting any symbol)

Every bundle is minified. Identifiers such as `nA`, `Kx`, `Rn`, `I()`, `dr`, `ZM`, `yJe`, `hte`,
`hHe`, `q`, `p()`, `Ve`, `Ot` are **minifier-assigned names, not API names**. They are stable only
within this exact build. What *is* real API surface, and what this dossier leans on:

* **string literals** — method names, channel names, env-var names, file names, protobuf type names;
* **object-literal keys** — RPC argument field names;
* **numeric constants** where the surrounding code makes their role unambiguous;
* **source-file paths seeded into telemetry strings** — e.g. `node-agent-coordinator/webauthn/provider.ts`
  (`main-core.beauty.js:26673`), `coordinator-account-runtime.ts` (`main-core.beauty.js:27102`),
  `electron-renderer/client/sand-client.ts` (`main-core.beauty.js:27128`). These are *real*
  monorepo paths that the build baked into error/telemetry descriptors.

Where a claim depends on a minified symbol, the dossier says so explicitly.

### Artifact note (line numbers)

The beautified artifacts were **regenerated with new file names while this section was being written**
(`coordinator.beauty.js` → `node-agent-coordinator.beauty.js`, `exec-daemon.beauty.js` →
`local-exec-daemon.beauty.js`), and the re-format shifted some line numbers by one to a few lines in
a handful of regions. All line numbers in this dossier were therefore **re-derived by content search
against the artifacts as they now stand**, and 193 representative citations were re-checked
line-by-line after the correction pass. Treat the **quoted literal**, not the line number, as the
durable anchor: every non-obvious claim here is accompanied by enough verbatim text (a method name, a
field list, a channel or env-var name, an error string) to locate it in any build. The 851/861
protobuf descriptors, the 172-method table and the 141-method surface table are all reproduced from
independent parses, so a reader can regenerate every table in §3 from the bundles without trusting a
single line number.

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
   `node-agent-node-agent-coordinator.beauty.js:33802` is consumed only by `_o()` at `node-agent-node-agent-coordinator.beauty.js:33803-33806`,
   which is a predicate: *"is this hostname loopback?"*. It is used in exactly three places, all of
   them **client-side URL checks** (`JB:33849`, `JB:35339`, `JB:35457`), the most important being
   `_o(new URL(r).hostname) ? "loopback" : "pod_proxy"` at `JB:35457`, which classifies the **box
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
**`utilityProcess`**. `main-app.beauty.js:91561`:

```js
fork: (L, B) => Ig.utilityProcess.fork(L, [], {
  serviceName: B.serviceName,
  env: { ...process.env, [E8e.NODE_USE_SYSTEM_CA_ENV]: "1", ...u() },
}),
```

with the service name literal at `main-app.beauty.js:85059`:

```js
var Aon = "sand-node-agent-coordinator";
```

and the artifact path resolved at `main-app.beauty.js:85103-85107`:

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

`main-app.beauty.js:85060-85103` is the whole spawn-and-handoff routine. It creates **three**
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

Return value (`main-app.beauty.js:85085-85090`):

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

The child side accepts either carrier. `node-agent-node-agent-coordinator.beauty.js:35103-35114`:

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

* `XK(process)` (`JB:34992-34995`) returns `process.parentPort` when `"parentPort" in r` — the
  Electron `utilityProcess` path. `PROVEN`.
* `e2(r, e)` (`JB:35052-35079`) is the parent-port carrier. It validates the bootstrap frame and then
  requires exactly three ports: `if (!fA(s) || !fA(a) || !fA(i)) return { adopted: !1, rejection: { detail: "parent handoff did not transfer three message ports" } };` (`JB:35056-35059`).
* `QK(process.argv)` (`JB:34995-35052`) is a **legacy `child_process` fork-IPC carrier**: it parses a
  `--bootstrap=<json>` argv entry (`$U = "--bootstrap="`, `JB:34988`), requires `process.send`
  (`if (s == null) return { adopted: !1, rejection: { detail: "no renderer data channel was transferred" } };`,
  `JB:35007`), and multiplexes the three logical channels over the single IPC pipe by wrapping frames
  as `{ channel: "coordinator-control", frame }` / `{ channel: "coordinator-main-data", frame }`
  (`iA`/`lA`, `JB:34980-34988`). `PROVEN` as code path; `INFERRED` as legacy: the fork-ipc carrier
  cannot express the renderer data port at all, and its rejection message is written in terms of a
  missing *renderer* data channel.

The bootstrap payload is deliberately tiny. `node-agent-node-agent-coordinator.beauty.js:34962-34978`:

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
(`JB:34686`, `JB:39786`); the main process re-derives that class as `"bootstrap"` in
`fJe = { [vV.settledClean]: "clean", [vV.fault]: "breach", [vV.bootstrapRejected]: "bootstrap" }`
(`main-app.beauty.js:84780`).

### 1.4 Renderer discovery: request/reply over IPC, then a port transfer

The renderer never learns an address. It asks, and the main process pushes a port to it.

**Preload** (`preload.beauty.js:4090-4102`, `4142`, `4146-4149`):

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

**Main process handler** (`main-app.beauty.js:85107-85109`, `85227-85262`):

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

`preload.beauty.js:4014-4036` is the entire claim implementation:

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
  `{kind:"serving",runtime}` at `main-app.beauty.js:85227-85235`, `85255-85259`), so `release` does
  not revoke the main-process side; only `revokeRendererPortRequest()`
  (`main-app.beauty.js:85206-85209`) does, and that is called by the host, not the client.
* `deliver(port)` calls `n?.onPort(port)` — the sink interface is `{ onPort(port) }`, where `port` is
  the narrowed facade built by `ci()`.

`ci()` (`preload.beauty.js:4037-4061`) is a **capability-narrowing wrapper** around the raw
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
`node-agent-node-agent-coordinator.beauty.js:34861-34901`:

```js
function pA(r) {
  if (!N(r)) return ft("frame must be an object");
  switch (r.kind) {
    case "lifecycle": return YK(r);
    case "request": {
      if (!pr(r.requestId)) return ft("request.requestId must be a non-empty string");
      if (!pr(r.method))    return ft("request.method must be a non-empty string");
      if (!("args" in r))   return ft("request.args is missing");
      let e = r.demand;
      return e !== void 0 && e !== "person" && e !== "background"
        ? ft("request.demand must be person or background when present")
        : To({ kind: "request", requestId: r.requestId, method: r.method, args: r.args,
               ...(e === void 0 ? {} : { demand: e }) });
    }
    case "cancel": return pr(r.requestId) ? To({ kind: "cancel", requestId: r.requestId }) : ft("…");
    case "reply":  { /* outcome = {status:"ok",value} | {status:"failed",failure} */ }
    case "event":  return pr(r.family) ? ("payload" in r ? To({ kind: "event", family: r.family,
               payload: r.payload }) : ft("event.payload is missing")) : ft("event.family must be a non-empty string");
    default: return ft("frame.kind must be lifecycle, request, cancel, reply, or event");
  }
}
```

`PROVEN`. Five frame kinds: `lifecycle`, `request`, `cancel`, `reply`, `event`. The literal error
string enumerates them: *"frame.kind must be lifecycle, request, cancel, reply, or event"*.

**Lifecycle frames.** `YK(r)` (`JB:34902+`) validates them. The two phases observed are `hello`
(client→server), `ready` (server→client), `shutdown` (either direction). Protocol version constant
`var jr = 3` (`JB:34841`). The server session state machine is `tC()`
(`node-agent-node-agent-coordinator.beauty.js:39498-39599`):

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
`` d(`request.requestId ${m.requestId} reused while in flight`) `` (`JB:39568`).

**Replies.** `c(m, E) => r.post({ kind: "reply", requestId: m, outcome: E })` (`JB:39517-39520`),
with `outcome` either `{status:"ok", value}` or `{status:"failed", failure:{code, message, ...}}`
(`JB:37031-37042`). `PROVEN`.

**Cancellation.** A `cancel` frame aborts the in-flight request's `AbortController` and replies
`{ status: "failed", failure: { code: "cancelled", message: "request cancelled" } }`
(`UU = "cancelled"`, `JB:34844`; abort + reply at `JB:39574-39579`). `PROVEN`.

**Events.** Server→client, one-way: `r.post({ kind: "event", family: m, payload: E })`
(`postEvent`, `JB:39593-39596`). `family` is drawn from a **named channel vocabulary** —
`wJ` at `node-agent-node-agent-coordinator.beauty.js:36828-36849`:

```js
wJ = { ...$2, transcript: "transcript", agents: "agents", "agent-upserted": "agent-upserted",
       tray: "tray", subagents: "subagents", "async-tasks": "async-tasks", "forever-box": "forever-box",
       "teach-recording": "teach-recording", "box-disk-pressure": "box-disk-pressure",
       "computer-action": "computer-action", "voice-call-nudge": "voice-call-nudge",
       "messages-grants": "messages-grants", "agent-activity": "agent-activity", outline: "outline",
       "host-settings": "host-settings", "cloud-agent-update": "cloud-agent-update",
       "server-roster-changed": "server-roster-changed", "server-page-title-changed": "server-page-title-changed" }
```

plus the transport-state family `mA = "coordinator-transport-state"` (`JB:34978`) and the transcript
source family `qU = "coordinator-transcript-source"` (`JB:34979`).

The renderer's decoder confirms the framing exactly. `P3e(e)`:

```js
function P3e(e){ let t="awaiting-ready",n=0; ...
  e.post({kind:"lifecycle",phase:"hello",protocolVersion:rh});
  const f=(v,w,_,b)=>{ ... n+=1; const L=`r-${n}`; ...
     e.post({kind:"request",requestId:L,method:v,args:w,...C===void 0?{}:{demand:C}}); ...}
```

`PROVEN`. Note the two sides use **different requestId prefixes**: the renderer uses `r-<n>`
(`L = \`r-${n}\``), the control client uses `c-<n>` (`R = \`c-${o}\``, `JB:35147`). The two are
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

`node-agent-node-agent-coordinator.beauty.js:36149-36155` (inside the gateway client class):

```js
let E = await fetch(`${a.baseUrl}${Rw}/${e}`, {
  method: "POST",
  headers: this.requestHeaders({ "content-type": "application/json",
                                 ...(m !== void 0 ? { [rJ]: m } : {}) }, a),
  body: JSON.stringify(t ?? {}),
  ...(o?.signal != null ? { signal: o.signal } : {}),
});
```

with `Rw = "/api"` at `node-agent-node-agent-coordinator.beauty.js:35265`. `PROVEN`. So **the local RPC method name is also
the gateway HTTP path segment**: `sendPrompt` ⇒ `POST {baseUrl}/api/sendPrompt`.

Authentication and correlation headers, `node-agent-node-agent-coordinator.beauty.js:35265-35273` and `35956-35959`:

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
`JB:36544-36546`), `/events/echo?...nonce=...` (POST, `JB:36047-36049`; SSE comment lines beginning
`":echo "` are sliced with `h.slice(Iw.length)` at `JB:36571-36573`). `PROVEN`.

Where does `{baseUrl, token}` come from? Presigned by the **backend** and stamped onto the box. The
main process builds the descriptor in `Aze()`, `main-app.beauty.js:78423-78431`:

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

and the broker stamp is unpacked in `q7()`, `main-app.beauty.js:78412-78422`:

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
(`main-app.beauty.js:83008`), and the coordinator calls it four times with the four **edge path** names:

```js
resolveGatewayConnection: () => s.commands.resolveGatewayConnection({ path: "gateway" }),      // JB:39803
resolveConnection: () => s.commands.resolveGatewayConnection({ path: "passkey-provider" }),    // JB:39975
resolveConnection: () => s.commands.resolveGatewayConnection({ path: "cookie-provider" }),     // JB:40007
let me = await Te.run(() => r.control.resolveGatewayConnection({ path: "local-exec-refresh" })),// JB:39095
```

`PROVEN`. Four gateway *paths* exist — and these are exactly the four non-method edge names that
appear in the extended authorization map (§4.1):

```js
YM = ["gateway", "passkey-provider", "cookie-provider", "local-exec-refresh"]   // JB:32759
```

### 1.9 The loopback allowlist, precisely

`node-agent-node-agent-coordinator.beauty.js:33802-33806`:

```js
var f$ = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function _o(r) {
  return f$.has(r.trim().toLowerCase());
}
```

Three call sites in the whole bundle (`grep -c '_o('` = 4 including the definition):

1. `JB:33849` — inside `SU(r)`, a **URL validator**:
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
   host; everything else falls through to a shape check. The scheme denylist `y$` (`JB:33809-33833`)
   blocks `javascript:`, `data:`, `file:`, `blob:`, `ws:`, `wss:`, `mailto:`, `chrome:`, etc.
2. `JB:35339` — a VNC viewer URL check: `if (!_o(t.hostname) || !t.pathname.endsWith("/vnc.html")) return r;`
3. `JB:35457` — inside `In(r)`, the **base-URL classifier**:
   ```js
   function In(r) {
     if (r == null || r.length === 0) return "unknown";
     try { return _o(new URL(r).hostname) ? "loopback" : "pod_proxy"; }
     catch { return "unknown"; }
   }
   ```
   whose result is reported as `baseUrlKind` on gateway reachability telemetry
   (`JB:36202`: `baseUrlKind: In(a?.baseUrl)`).

`PROVEN`. Interpretation:

* The `Set` is an **anti-downgrade guard on the box gateway URL**. The `gateway_url` arrives from the
  backend (`EnsureSandBoxResponse.gateway_url`) or, in dev, from a local `gateway.json`. A hostile or
  misconfigured value that points at `http://evil.example` would send the box bearer token in
  cleartext to a third party; `SU()`/`In()` refuse to treat a non-loopback `http:` URL as legitimate.
  `INFERRED` (strong: it is the only consumer, it is a client-side check on an outbound URL, and the
  bearer token is attached to that same URL by `L2`).
* It does **not** constrain any bind address, because the coordinator never binds. It also does not
  constrain the *remote* hop (`https://api2.cursor.sh`, `G2 = "api2.cursor.sh"` at `JB:36703`) —
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

Base factory, `node-agent-node-agent-coordinator.beauty.js:32630-32646`:

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

Second base with a different vendor string, `node-agent-node-agent-coordinator.beauty.js:33649-33665`:

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
(`node-agent-node-agent-coordinator.beauty.js:32733-32737`) is the duck-type check used to accept *any* third-party
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
appears at `node-agent-node-agent-coordinator.beauty.js:2704-2716` (`invalid_format`, `not_multiple_of`, `unrecognized_keys`,
`invalid_union`, `invalid_key`, `invalid_element`, `invalid_value`, `custom`) with a formatter
`_E(r)` at `JB:2713-2716` that joins `path.join(".")` + message. That is a *different* layer
(zod-style) and is **not** what validates RPC arguments. The RPC dispatcher calls
`i.schema["~standard"].validate(o)` (`JB:37032`), i.e. the dune/sand engine. `PROVEN`.

### 2.2 Combinator vocabulary

All line numbers in `recon/beautified/node-agent-coordinator.beauty.js`:

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
| `at(r)` | 32681 | (label: the inner type plus the literal suffix `null`) | **nullable** — `record-or-null`-style wrappers are built from this |
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
at `JB:33610`) and the reply-container vocabulary in the renderer (§2.7). The `record-or-null`
wrapper is a **reply container name**, not a combinator (`k3e["record-or-null"]`). This mapping is
`PROVEN` for the left-hand names; the right-hand correspondence is stated where observed.

### 2.3 A method's arguments are declared with `I()`

`node-agent-node-agent-coordinator.beauty.js:32737-32755`:

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

`node-agent-node-agent-coordinator.beauty.js:32755-32758`:

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

`PROVEN`. The gateway table's shape, at its head (`node-agent-node-agent-coordinator.beauty.js:34168-34178`):

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
  (`JB:33875`);
* **derived/transformed** — `sendPrompt: I().args(O$)`, where `O$ = Qh(w(pw), uw)`
  (`JB:33919`), with `pw` a 21-field object literal (`JB:33896-33919`) and `uw` a transform that
  **deletes an empty `mcpConfigJson`** (`JB:33891-33896`):
  ```js
  function uw(r) {
    if (r.mcpConfigJson === void 0 || r.mcpConfigJson.trim().length > 0) return r;
    let { mcpConfigJson: e, ...t } = r;
    return t;
  }
  ```
  This is a deliberate "omit rather than send empty" normalization. `PROVEN`.

**Verification performed.** An independent structural parse of `node-agent-node-agent-coordinator.beauty.js:34168-34706`
(bracket-balanced, not line-based) found **exactly 172** top-level entries in `nA.methods`, of which
**21** are `I().noArgs` and **151** are `I().args(...)`. This matches `recon/rea/coordinator-methods.json`
(172 entries) exactly, method-for-method. `PROVEN`.

### 2.5 Argument-schema variable vocabulary

A small set of shared, named field schemas is reused across methods. Recovered definitions
(all `node-agent-coordinator.beauty.js`):

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
| `T$` | 33882 | `dt("approval platform", Eo)` | approval surface tag ("bot_share" is one such value, `JB:4098`) |
| `$s` | 33927 | `w({ shareId: p(), visibility: _e("bot template visibility", yU) })` | template visibility |
| `fw` | 34009 | `kU(j$)` = `{ entryId, requestId, resolution, agentId, sessionId }` (`kU` at 33934) | local-tool-permission resolution |
| `gw` | 34010 | `kU(_e("connector grant resolution", UE))` | connector-grant resolution |

`q()` is the **agent-id validator** and deserves its own line, because it defines what an `agentId`
*is*. `node-agent-node-agent-coordinator.beauty.js:33695-33701`:

```js
function q() {
  return Ot("agent id", (r) => {
    let e = ue(r);
    return e === null ? { success: !1 } : { success: !0, data: e };
  });
}
```

`ue` at `node-agent-node-agent-coordinator.beauty.js:418-421` → `iF(r)` at `407-418`:

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
with `rw = 64` (`JB:33701`, `33608-33609`), used where a *derived name* is accepted.

### 2.6 Dispatch: name lookup, validation, handler call

`node-agent-node-agent-coordinator.beauty.js:37001-37043`:

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

with `j2 = w({})` (`JB:37000`) as the default (empty object) schema, and failure codes
`dA = "unknown-method"`, `cA = "invalid-args"` (`JB:34842-34844`). `PROVEN`. The pipeline is:

```
frame.request {method, args, demand?}
  → Y2(schemaTable, method)            // name lookup, prototype-safe via Wt = Object.hasOwn
  → schema["~standard"].validate(args) // strip + coerce + check
  → dispatchCommand(method, value, {signal, demand})
  → gateway HTTP hop  OR  local handler
  → reply {status, value|failure}
```

`Wt(r, e) = typeof e == "string" && Object.hasOwn(r, e)` (`JB:32615-32618`) — the lookup is
`Object.hasOwn`, so `__proto__`, `constructor`, `toString` are not callable as methods. `PROVEN`.

The **edge factory's** version, `Vw(r, e)` is bound at `node-agent-node-agent-coordinator.beauty.js:37028` and instantiated
for the data port at `JB:40210`:

```js
Te = tC(
  { post: (_) => t.data.post(_), close: () => t.data.close() },
  { dispatchRequest: async (_, M, ie, se) => { ... } },
),
```

and for the main-data port at `JB:40243`. `PROVEN`. Each `tC()` session has its **own**
`dispatchRequest`, so the same 172-name table is filtered through two different second-stage
dispatchers.

### 2.7 The reply-container vocabulary (client side)

The coordinator validates *arguments*; the renderer validates *replies* with a second, small
vocabulary. `k3e` in the renderer entry chunk:

```js
const An = Symbol("malformed-reply");
const An = Symbol("malformed-reply");
const k3e = {
  array:  e => Array.isArray(e) ? e : An,
  record: e => fe(e) ? e : An,
  "record-or-null": e => e === null || fe(e) ? e : An,
  boolean: e => typeof e == "boolean" ? e : An,
  count:   e => typeof e == "number" && Number.isFinite(e) && e >= 0 ? e : An,
  void:    () => {},
  "send-result": e => { if (e != null) return fe(e) ? e : An },
  "transcript-page": e => !fe(e) || !Array.isArray(e.entries)
        || e.nextBeforeSeq != null && typeof e.nextBeforeSeq != "number"
        || e.cloudAgentPeerIds !== void 0 && !$r(e.cloudAgentPeerIds) ? An : e,
  "acceptance-lookup": e => fe(e) && typeof e.outcome == "string" ? e : An,
  "connect-url":       e => fe(e) && typeof e.url == "string" ? e : An,
  "import-result":     e => fe(e) && Array.isArray(e.workflows) ? e : An,
  "channels-view":     e => fe(e) && Array.isArray(e.manifests) && Array.isArray(e.connections) ? e : An,
  "box-secrets": e => … requires $r(keys), optional $r(cardKeys), boolean isApplied,
                        number|null lastAppliedAtMs; returns a normalised {keys,cardKeys?,isApplied,lastAppliedAtMs} …,
  "box-status":  e => e === null ? null : (!fe(e) || typeof e.agentId != "string"
                        || typeof e.state != "string" ? An : e),
  "host-status": e => … requires hostVersion, latestHostVersion, hostUpdateAvailable,
                        isBusy; optional string[] capabilities …,
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
and reply *container*, not by field schema. `node-agent-node-agent-coordinator.beauty.js:36849-36993`:

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
for (let [r, e] of Object.entries(nA.methods)) CJ(r) && (kJ[r] = e);   // JB:37056
var OJ = { ...kJ, ...X2 };                                             // JB:37057
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
getAgentTranscript            getAgentTranscriptPage        openAgentWindowed             getAgentTranscriptWindow      
getAgentThread                requestMessagesGrants         awaitMessagesGrants           cancelMessagesGrants          
requestCookieOriginApproval   awaitCookieOriginApproval     cancelCookieOriginApproval    requestWebAuthnCeremony       
storeSecret                   listBotTemplates              openAgent                     duplicateAgent                
disconnectListenerPlatform    getAgentNotificationAvatar    getAgentTodos                 readVoiceCallSentMessages     
getEffectiveMcpPlugins        installMcpEntry               updateMcpPluginInstall        uninstallMcpPlugin            
isGlobalSearchEnabled         uploadAttachment              uploadAttachmentChunk         readAttachmentImage           
readAttachmentText            readAttachmentChunk           getHostSettings               setHostSettings               
setBoxSecrets                 carryBoxSecretsToBot          injectChromeCookies           refreshMcp                    
listBoxMcpServers             completeMcpOAuth              updateForeverBox              setWindowFocused              
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

**The 9-method addition.** `X2` (`node-agent-node-agent-coordinator.beauty.js:37044-37055`) adds nine methods that are
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
(`JB:36996-37000`). Therefore: the gateway emits events on a channel string; the coordinator drops
any channel that is not in its allowlist (`let M = bJ(_.channel); if (M == null) return;`, `JB:39907`
region), and republishes the known ones to the client under the canonical family name. `PROVEN`.

`$2` (spread into `wJ` at `JB:36829`) holds alias pairs such as `"agents-meetings": "agent-meetings"`,
`"mcp-servers-updated": "mcp-servers"`, `"mcp-auth-completed": "mcp-auth"` (`JB:36824-36828`) —
i.e. **the gateway's channel names differ from the client's family names for at least three
families**. `PROVEN`. This matters for a clean-room implementation: the event channel namespace is a
*third* namespace, distinct from both the RPC method names and the client family names.
## 3. The complete 172-method surface, grouped

### 3.1 How to read this section

Every method below is `PROVEN` to exist, with the stated authz class, on the named edge. Authz
classes are quoted from `node-agent-node-agent-coordinator.beauty.js:32760-32934`. Argument field names are quoted from the
schema expressions in `node-agent-node-agent-coordinator.beauty.js:34168-34706` (inline object literals) or from the named
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
  yields the outline/TOC (`outline` is also an event family, `JB:36844`). `readMainAgentContext`
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
are typed by `$n` (`JB:4062-4080`) into `email-draft`, `slack-draft`, `meeting-chat-draft`.
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
(`FINDINGS.md:125`). There is also a `teach-recording` **event family** (`JB:36837`), so the client
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
  `IU = w({ name, description, body, trigger: at(Y$), sourceRef: at(p()) })` (`JB:34012-34014`), so a
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
(`{subagent_id, subagent_type, title, started_at_ms}`) and a `subagents` event family (`JB:36833`) plus
`async-tasks` (`JB:36834`). `INFERRED`: subagents are long-running child work items whose *listing* is
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
`mcp-servers` family, and `mcp-auth-completed` as `mcp-auth` (`JB:36825-36827`).


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
`yU = ["public", "team"]` is the visibility enum (`JB:33801`) used by `setBotTemplateVisibility`.
`$s = w({ shareId: p(), visibility: _e("bot template visibility", yU) })` (`JB:33926`).
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
(`JB:33761`, `JB:33928`) is a `PROVEN` **secret-write refusal taxonomy** — i.e. the client reports back
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
(`main-app.beauty.js:78419`), and `Qre`/`hHe` classify the box's `egress_tunnel_ownership` as part of
the box state. The "forever-box" event family exists (`JB:36835`), as does a telemetry event family
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
  `PROVEN`: `getBoxSecretsStatus: "person"` at `JB:32893`, noArgs;
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
(`main-app.beauty.js:35777-35779`), and `MintSandVoiceCallSecretResponse.websocket_url` shows the
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
(`JB:34013-34037`). `PROVEN`. The two `background` methods are `readVoiceCallSentMessages` and
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
  Note the **shape match** with the deep-link route table in `main-core.beauty.js:18296-18307`: the
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
avatarColor}` (`JB:33931`). The header `x-sand-slim-avatars: 1` on box requests
(`JB:35271`, set unless disabled) shows avatars are optionally served slimmed. `INFERRED`: avatars are
PNG bytes plus a generated *shape*+*color* fallback, and generation is a person action because it
costs a model call.


| method | authz | on client surface (141) | argument fields (from `nA.methods`) |
|---|---|---|---|
| `generateAgentAvatarImage` | `person` | yes | `description` |

---

### 3.24 Methods by authz class — the complete `background` set

The 36 `background` methods are enumerated in §4.2 with their classes derived from the same
literal map, and are identifiable in the tables above by the `background` value in the authz column.
`PROVEN` for all 36 names and classes. Note the shape of the set: **21 of 36 are pure reads**, and of
the 15 that are not, 6 are the `request*/await*/cancel*` ceremony starters, 2 are presence/telemetry
signals (`setWindowFocused`, `setBoxSecrets`), 2 are "nudge/notify" (`nudgeVoiceCall`,
`clearGeneratedRoomNameStamps`), and the remainder are local cache refreshes (`refreshMcp`). **No
method in the set creates, deletes, sends, pays, installs, or publishes anything.** That is a
`PROVEN` property of the table and the strongest available evidence for what `background` means.
## 4. The authorization model

This is the section a clean-room host must get right, so it separates **what is proven** from **what
is inferred** more aggressively than the rest of the dossier.

### 4.1 The map, and the extended map

The literal map is `Kx` at `node-agent-node-agent-coordinator.beauty.js:32760-32934` — 172 keys, each value exactly
`"person"` or `"background"`. `PROVEN`; count verified by independent parse.

A second, extended map adds the four **edge paths** and one new class value,
`node-agent-node-agent-coordinator.beauty.js:32934-32941`:

```js
Qre = {
  gateway: "background",
  "passkey-provider": "background",
  "cookie-provider": "background",
  "local-exec-refresh": "describes",
  ...Kx,
};
```

`PROVEN`. Notes:

* The key `gateway` is **shadowed** by nothing — `Kx` has no `gateway` key, so the edge entry
  survives the spread. The extended map therefore has 176 keys: 172 methods + 4 edges.
* `"describes"` is a **third class value** that exists only for `local-exec-refresh`. It appears
  nowhere else in either bundle. `INFERRED`: it means *"this connection is read-only / describing
  only"*, i.e. resolving it reports state and cannot cause work. That reading is consistent with the
  only thing the coordinator does with that path — a single call at `JB:39095` that fetches a
  connection to refresh local-exec state.
* The extended map has **exactly one consumer in the coordinator** (the spread itself is unused!):
  `grep -n 'Qre' node-agent-coordinator.beauty.js` returns only the declaration. `PROVEN` negative.

The **same extended map** reappears in the Electron main process at
`main-app.beauty.js:74172-74356` under a different minified name (`R6t` for the 172, `hHe` for the
176), with byte-identical values, and there it *is* consumed — once. `PROVEN`.

### 4.2 The 36 `background` methods

`PROVEN`, complete; the `person` complement is the other 136.

| # | method | # | method | # | method |
|---|---|---|---|---|---|
| 1 | `getAgentTranscript` | 13 | `storeSecret` | 25 | `getMcpCatalog` |
| 2 | `getAgentTranscriptPage` | 14 | `listBotTemplates` | 26 | `getEffectiveMcpPlugins` |
| 3 | `openAgentWindowed` | 15 | `getBotTemplateExportPolicy` | 27 | `getMcpPluginLogo` |
| 4 | `getAgentTranscriptWindow` | 16 | `openAgent` | 28 | `listMcpServerTools` |
| 5 | `getAgentThread` | 17 | `clearGeneratedRoomNameStamps` | 29 | `getTrays` |
| 6 | `requestMessagesGrants` | 18 | `getAgentAvatar` | 30 | `isGlobalSearchEnabled` |
| 7 | `awaitMessagesGrants` | 19 | `getAgentNotificationAvatar` | 31 | `isEgressTunnelAvailable` |
| 8 | `cancelMessagesGrants` | 20 | `getAgentTodos` | 32 | `setBoxSecrets` |
| 9 | `requestCookieOriginApproval` | 21 | `readMainAgentContext` | 33 | `refreshMcp` |
| 10 | `awaitCookieOriginApproval` | 22 | `readVoiceCallSentMessages` | 34 | `listBoxMcpServers` |
| 11 | `cancelCookieOriginApproval` | 23 | `nudgeVoiceCall` | 35 | `setWindowFocused` |
| 12 | `requestWebAuthnCeremony` | 24 | `getMcpState` | 36 | `getHostStatus` |

Structural observation (`PROVEN` by inspection of the table): the set contains **no** create, delete,
send, pay, install, publish, or permission-granting method. It contains 21 pure reads, 6
`request*/await*/cancel*` ceremony starters, 2 presence/settings signals (`setWindowFocused`,
`setBoxSecrets`), 2 notification-ish operations (`nudgeVoiceCall`,
`clearGeneratedRoomNameStamps`), and 5 local cache/state refreshes (`refreshMcp`,
`listBoxMcpServers`, `getMcpPluginLogo`, `getMcpState`, `getMcpCatalog`). This is the strongest
single piece of evidence about the class's meaning.

### 4.3 The two predicates

`node-agent-node-agent-coordinator.beauty.js:32941-32947` is the entire enforcement surface in the coordinator:

```js
function IH(r) {
  return Object.hasOwn(Kx, r);
}
function ZM(r, e) {
  return !IH(r) || e === "background" ? !1 : Kx[r] === "person";
}
```

`PROVEN`. Read carefully:

* `IH(method)` — *"is this a declared gateway method?"* One consumer: inside `ZM`.
* `ZM(method, demand)` — *"is this a person-demand call?"* Returns `false` if the method is unknown,
  if the caller declared `demand === "background"`, or if the method is `background`-class.
  Otherwise `Kx[method] === "person"`. One consumer.

`grep -n 'ZM('` returns exactly two lines: the definition and the single call site. `PROVEN`.

**So there is precisely one place in the coordinator where the class changes behaviour**, and it does
not deny. `node-agent-node-agent-coordinator.beauty.js:36247-36250`:

```js
dispatchCommand(e, t, o) {
  return this.clientPause === null && ZM(e, o?.demand) ? this.dispatchPersonCall(e, t, o) : this.dispatchNow(e, t, o);
}
```

`PROVEN`.

### 4.4 Where the class is consumed, exhaustively

There are exactly **three** functional consumers of the class value across the entire desktop
app, plus one table that is compiled but never read. `PROVEN` by `grep` across all beautified
bundles:

| # | Site | Code | Effect |
|---|---|---|---|
| 1 | `node-agent-node-agent-coordinator.beauty.js:36248` | `this.clientPause === null && ZM(e, o?.demand) ? dispatchPersonCall : dispatchNow` | routes a gateway call through the *box-intent* path |
| 2 | `main-app.beauty.js:74895` | `if (t === "parked" && hHe[se] === "background") throw new LS();` | refuses to wake a present-parked box for a `background`-class edge |
| 3 | `node-agent-node-agent-coordinator.beauty.js:32934-32941` | `Qre = { gateway: …, … , ...Kx }` | declares edge classes; **never read** in the coordinator |

Consumer 2 needs its surrounding function to be read correctly. `main-app.beauty.js:74891-74907`
(fragment of the transport-adoption loop; `se` is the **edge path** being resolved):

```js
async function J(se) {
  for (;;) {
    if ((q(), t === "live")) return await L(j);
    if (t === "away-parked") throw new yp();
    if (t === "parked" && hHe[se] === "background") throw new LS();
    let { seq: Ae, described: fe } = await P(j),
      X = U(Ae, fe.kind);
    if (X === null) { … }
    if (X === "away-parked") throw new yp();
    if (X === "parked") throw new LS();
    return fe.kind === "running" ? fe.connection : X === "live" ? await L(j) : await j.connect();
  }
}
```

The two error classes, `main-app.beauty.js:74697-74712`:

```js
var yp = class extends u7.SandDomainError {
    name = "SandAwayParkedError";
    failureMetadata = { kind: "box-blocked", reason: J5, display: null };
    constructor() { super("sand box is left asleep while nobody is at this computer"); }
  },
  LS = class extends u7.SandDomainError {
    name = "SandPresentParkedError";
    failureMetadata = { kind: "box-blocked", reason: UF, display: null };
    constructor() { super("sand box is left asleep until something on this computer needs it"); }
  };
```

`PROVEN`. **This is the inversion that gives the class its real meaning**, and it is worth stating
plainly:

* In **present-park** (`t === "parked"`, gated by `sand_desktop_present_park`, `main-app.beauty.js:74644`),
  a `background`-class call is **refused** — and the refusal reason is that the box is intentionally
  asleep. A `person`-class call **falls through and wakes it** (`P(j)` → `U(...)` → `j.connect()`).
* In **away-park** (`sand_desktop_away_park`, `main-app.beauty.js:74643`), *everything* is refused with
  `SandAwayParkedError`: nobody is at the computer at all.

So the class does not mean *"is a human present?"*. It means **"may this call be the reason the box
wakes up?"** — `person` = yes, `background` = no. A `background` call must be answerable from
already-running state or be deferred. `person` calls are, by construction, the ones for which a human
is waiting on the result.

Helper functions that make the same distinction in the coordinator, `JB:36250-36286`:

```js
async dispatchPersonCall(e, t, o) {
  this.presentParkOn && (await this.requestBoxIntent({}));
  try { return await this.dispatchNow(e, t, o); }
  catch (s) { if (!this.mayRetryAsAsleep(o) || !M2(e, s)) throw s; }
  try { return await this.dispatchAfterBoxFoundAsleep(e, t, o); }
  catch (s) { if (!this.mayRetryAsAsleep(o) || !So(s)) throw s;
              return await this.dispatchAfterBoxFoundAsleep(e, t, o); }
}
mayRetryAsAsleep(e) { return !this.isClosed && e?.signal?.aborted !== !0; }
async dispatchAfterBoxFoundAsleep(e, t, o) {
  return (this.options.onBoxAsleep?.(),
          await this.requestBoxIntent({ boxFoundAsleep: !0 }),
          await this.dispatchNow(e, t, o));
}
```

`PROVEN`. A person call (a) declares box intent before dispatching, (b) is retried once if the box
turns out to be asleep, and (c) notifies the host that the box was found asleep so the host can
re-classify. `dispatchNow` then applies a small per-method `commandPolicies` override table
(`JB:36224-36244`) for `sendPrompt`, `getForeverBoxStatus`, `ensureForeverBox`, `listAgents`,
`countAgents`, `openAgentTail`, `getAgentTranscriptTail`, `getCloudAgentInfo`, `transcribeAudio`,
`createAgent`, `setDevGatewayOffline`, `setGatewayPaused`, `noteNetworkReturn`, `noteBoxAsleep` —
i.e. per-method deadlines, roster/transcript read budgets, and a `createAgent` retry loop that
dedupes by proven `baseUrl` (`createAgentWithRetry`, `JB:36287-36326`). `PROVEN`.

### 4.5 The `demand` field: how a client declares itself

The class alone does not decide anything — it is combined with a **`demand`** the caller supplies per
call. This is the mechanism by which an unattended client (a phone, a cron, a headless worker) tells
the host *"do not wake the box for me"*.

**On the wire.** `demand` is an optional field of the `request` frame, and it is validated to exactly
two values. `node-agent-node-agent-coordinator.beauty.js:34870-34880`:

```js
let e = r.demand;
return e !== void 0 && e !== "person" && e !== "background"
  ? ft("request.demand must be person or background when present")
  : To({ ...(e === void 0 ? {} : { demand: e }) });
```

`PROVEN`. Note what is *absent*: `demand` is validated for **spelling only**. It is not signed, not
rate-limited, not bound to a session, not checked against any caller identity.

**Producer side (renderer).** `index.eager-app-DSuGVQNC.js`:

```js
const On = { demand: "person" };
const da = { demand: "background" };
let Sh = 0;
function no(e) { Sh += 1; try { return e() } finally { Sh -= 1 } }
function mE(e) { return e?.demand ?? (Sh > 0 ? "background" : void 0) }
```

`PROVEN`. Three ways a demand reaches the wire:

1. an explicit per-call option — only two literals exist in the bundle, `demand:"person"` (once) and
   `demand:"background"` (once), i.e. the presets `On` and `da`;
2. wrapped in `no(fn)` — a dynamic scope in which every call becomes `demand:"background"`; three
   call sites were located;
3. otherwise `undefined`, which `ZM` treats as *person* for person-class methods.

`PROVEN` call sites of `no(...)`, and they are exactly what the model predicts:

| Call site | What it wraps |
|---|---|
| poll scheduler | `let g = f; p.poll = { intervalMs: h, handle: o(h).start(() => { const S = g; return g = "background", S === "background" ? no(() => l(p)) : l(p) }) }` — **the first poll is a person call; every subsequent poll is a background call** |
| roster/resource refresh | `no(() => p(A))` inside a visibility-gated poll loop (`if (!e.visibility.isVisible()) { …; return }`) |
| conversation prefetch | `const O = no(() => P(x))` stored as `x.backgroundConversationRead` — a *prefetch* is background |

`PROVEN`. The first row is the cleanest statement of the intent in the whole codebase: *the read a
human is waiting for is `person`; the identical read repeated by a timer is `background`.*

**Consumer side.** The dispatcher threads it through unchanged —
`dispatchCommand(i.method, d.value, { signal: s, ...(a === void 0 ? {} : { demand: a }) })`
(`JB:37037`), where `a` came from `u(m.requestId, m.method, m.args, m.demand)` (`JB:39571`).
`PROVEN`.

**The coordinator's own internal calls.** The coordinator calls its own gateway client with
`demand: "background"` for its background work — `PROVEN` at:

| Line | Call |
|---|---|
| `JB:37280` | `dispatchCommand("resolveVirtualCardApproval", t, { signal: o, demand: "background" })` |
| `JB:38046` | `dispatchCommand("deleteAgents", { ids: fe }, { demand: "background" })` |
| `JB:39915` | `dispatchCommand("listAgents", {}, { demand: "background" })` (server roster seed) |
| `JB:40057` | `getAgentAutomations: (_) => we.dispatchCommand("getAgentAutomations", _, { demand: "background" })` |
| `JB:40058` | `getAgentWorkflows: (_) => V.dispatchCommand("getAgentWorkflows", _, { demand: "background" })` |
| `JB:40059` | `getSubagents: (_) => we.dispatchCommand("getSubagents", _, { demand: "background" })` |
| `JB:40167` | `V.dispatchCommand("openAgentTail", M, { demand: "background" })` (the *server-tail* leg beside a person tail) |

Two of these are notable. `resolveVirtualCardApproval` and `deleteAgents` are `person`-class methods,
and the coordinator invokes them with an explicit `demand: "background"` — i.e. **the class is
overridable by the caller**, and the coordinator overrides it for its own internal
reconciliation/cleanup work. `PROVEN`. This confirms the field is a *hint about the caller's
situation*, not a capability.

**Not forwarded to the box.** `demand` does not appear in any header or query construction. The box
hop's headers are built by `L2`/`requestHeaders` (`JB:35955-35959`, `JB:35265-35273`): `authorization`,
`traceparent`, `x-sand-slim-avatars`, optionally `x-sand-mint-dedupe`, plus `content-type`. `PROVEN`
negative. **The class is enforced entirely on the client/host side of the protocol; the box never
sees it.**

### 4.6 What is *not* there — negative results

These are as important as the positives, because they say what a clean-room host must *add* if it
wants real authorization rather than a scheduling hint.

* **No session token on the local RPC.** The frame schema is
  `{kind, requestId, method, args, demand?}` (`JB:34861-34901`). No token, no signature, no nonce, no
  client identity, no capability set. `PROVEN` negative by exhaustion of the frame validator.
* **No grant record.** There is no "grant" object in the coordinator keyed by method or client. The
  word `grant` appears only in `resolveConnectorGrant` (a *connector* grant — a third-party
  integration permission) and in `cookieOriginGrantStore` / `grantListAccess` in main-app (a cookie
  *list* access grant, `main-app.beauty.js:91580-91572`). Neither is a client-authorization grant.
  `PROVEN` negative.
* **No per-call authorization failure.** The coordinator's failure codes are `unknown-method`,
  `invalid-args`, `cancelled`, and the gateway-derived set (`gateway-malformed-reply`,
  `gateway-command-failed`, `gateway-unreachable`, `gateway-transport-failed`) plus box/gateway
  transport kinds. There is **no `not-authorized` / `forbidden` / `denied` failure code in the
  coordinator's RPC layer.** The only access-flavoured token, `access_denied`, is a
  `transportKind` on the *renderer's* error mapping (`aC()` → `transportKind:"access_denied"`),
  i.e. a classification of a backend refusal, not a local decision. `PROVEN` negative.
* **No "box" authorization concept beyond sleep.** The security boundary around `box` is
  *availability*, not access: `SandPresentParkedError` / `SandAwayParkedError` carry
  `failureMetadata.kind = "box-blocked"`, and the renderer maps `box_blocked` into the same
  `transportKind` switch as `refused`/`timeout`. `PROVEN`.

**What access control the local path *does* have, exhaustively:**

| Control | Evidence | Nature |
|---|---|---|
| `contextIsolation: true` on the main window | `FINDINGS.md:48` | process isolation |
| the page can reach only `window.coordinatorPort` → `{ claim }` | `preload.beauty.js:4141`, `4015-4036` | capability narrowing |
| the delivered port is a facade with no `transfer` overload | `preload.beauty.js:4037-4061` | capability narrowing |
| **single claimant** — `claim()` returns `null` when already claimed | `preload.beauty.js:4018-4022` | mutual exclusion |
| `assertTrustedRequester(r)` on `sand:coordinator-port-request` | `main-app.beauty.js:85237` | origin/frame assertion (implementation `UNKNOWN`) |
| the port is only obtainable via `ipcRenderer.on` **inside the preload** | `preload.beauty.js:4145-4149` | page script cannot receive a port |
| the coordinator's method lookup uses `Object.hasOwn` | `JB:32615-32618` | prototype-pollution guard |

`PROVEN` for each row except the noted `UNKNOWN`. `INFERRED` overall: **local RPC access control is
"one trusted renderer at a time, in a process-isolated context", and nothing finer.** Everything the
`person`/`background` map expresses is a *scheduling and box-wake policy*, not an authorization
decision.

### 4.7 Where "presence" actually comes from

Since the class is about box wake authority, the host must decide when a box *may* sleep. `PROVEN`
inputs (all `main-app.beauty.js`):

| Signal | Evidence |
|---|---|
| window focused | `noteWindowFocused: (Q) => { (M(Q, () => e.nowMs()), q()); }` (`74850-74852`) |
| OS suspend/resume | `noteSuspended: (Q) => { ((n = Q), q()); }` (`74853-74855`) |
| screen lock | `noteScreenLocked: (Q) => { ((o = { isLocked: Q, atMs: e.nowMs() }), ee(() => Q)); }` (`74856-74858`) |
| computer open/closed | `noteComputerOpen: (Q) => { ((d = Q), Q && (g += 1), x() && q()); }` (`74868-74870`) |
| box intent (a client asked for the box) | `noteIntent: (Q = e.nowMs(), ne = {}) => { x() && (ne.boxFoundAsleep === !0 && (u = !1), !u && ((f = Q + H6t), (g += 1), q())); }` (`74871-74873`) |
| complete roster seen | `noteRosterCensus` (`74859-74861`) |
| account scope change | `noteAccountScope` (`74862-74867`) |
| backend keeps it asleep | `s.isBoxKeptAsleep`; `j.kind === "running"` + `ne === b` ⇒ `s.isBoxKeptAsleep = !0` (`74807-74809`) |
| feature gates | `UHe = "sand_desktop_away_park"`, `FHe = "sand_desktop_present_park"` (`74644-74645`) |
| screen-lock & screensaver probes (macOS) | `wHe()` (`74550-74558`): `getScreenLocked`, `getScreensaverActive`, `getSystemIdleSeconds`, `probeHostIdle`; screensaver detected by `pgrep -x ScreenSaverEngine` / `pgrep -f legacyScreenSaver.appex` (`74530-74543`) |

`PROVEN`. Park modes are feature-gated: `parkMode: () => d7(e.gates())` (`74848`) and
`a = () => ({ awayPark: t(UHe), presentPark: t(FHe) })` (`74920`) where
`t = f => e.experiments.checkFeatureGate(f, { disableExposureLog: !0 })` (`74913`) — i.e. **parking is
a Statsig feature gate**, so the class's behavioural consequences can be turned off server-side
without a client update. `PROVEN`. `INFERRED`: that is why the map has just one live consumer in the
host — the policy is a rollout-gated refinement, and the class is carried everywhere so the gate can
be flipped later.

The host also exposes the raw signals into telemetry: `getScreenLocked`, `getScreensaverActive`,
`getSystemIdleSeconds`, and the reconnect telemetry logs `window_focused` and `window_visible`
(`main-app.beauty.js:84761-84765`). A client can *hint* at presence via `setWindowFocused {isFocused}`
(a `background`-class method, host domain), but the host does not depend on it. `PROVEN`.

### 4.8 The model, stated compactly

```
class(method) ∈ { person, background, describes }        # table, 172 + 4 entries
demand(call)  ∈ { person, background, undefined }        # caller-supplied, spelling-checked only

personClass(method, demand) =
    method ∉ table                     -> false           # unknown method is not person-class
  | demand == "background"             -> false           # caller opted out of box-wake authority
  | table[method] == "person"          -> true

if personClass:   dispatchPersonCall   # declare box intent; wake box; retry once if found asleep
else:             dispatchNow          # never wake the box; serve or fail fast

host side, present-park:
    class(edge) == "background"        -> refuse (SandPresentParkedError, "box-blocked")
    otherwise                          -> may wake the box
host side, away-park:
    everything                         -> refuse (SandAwayParkedError, "box-blocked")
```

`PROVEN` for every branch. The three properties a self-hosted host should copy, because they are
what makes "phone drives an unattended agent" safe by construction:

1. **`background` can never be the reason a machine wakes.** Unattended work is bounded by the state
   the host is already in.
2. **`background` can never mutate.** Empirically true of the table (§4.2) and consistent with the
   class's purpose. A clean-room host should make it a *checkable* invariant, not a convention.
3. **`person` is about latency and wake authority, not identity.** The class says "a human is waiting";
   it does not say *which* human or *whether they may*. Any real authorization must be layered on top
   — the vendor layers it *below*, in the backend (`gateway_token`, per-box credentials) and in the
   box's own policy engine.

---

## 5. Entities and identifiers

### 5.1 Two independent sources for the data model

The dossier can reconstruct the entity model from two independent places, which corroborate each
other:

1. **the RPC argument schemas** in `node-agent-node-agent-coordinator.beauty.js:34168-34706` — what a *client* sends;
2. **`aiserver.v1` protobuf descriptors embedded in the same bundle** — what the *backend* stores.

The second is the more valuable and less obvious. `dist/node-agent-coordinator/main.cjs` contains
**861 generated protobuf-es message classes**, each carrying its own compact descriptor. Decoded
shape (`node-agent-node-agent-coordinator.beauty.js:6809-6848`):

```js
function v1(r) { let e = r[0], t = e.indexOf("|"); return t === -1 ? e : e.slice(0, t); }
var Lt = class extends pt {
  static get typeName() { let e = this; return Mt(e, "typeName", e.$p() + v1(e.$())); }
  static get fields() { let e = this, t = e.$(), o = e.runtime, s = () => N1(o, t);
                        return Mt(e, "fields", o.util.newFieldList(s)); }
};
```

with the package prefix `et = "aiserver.v1."` (`JB:6858`) — and a **second** declaration of the same
prefix `xP = "aiserver.v1."` at `JB:10244`, i.e. the descriptors were generated in more than one
module. The parser (`N1`, `JB:6839-6859`; `iP`, `JB:6836-6840`) decodes
`"Name|no snake_name type[?|*][ @oneof]|…"` where a leading `?` marks optional, `*` repeated, `#N`
references the Nth type in the descriptor's second array element, and `K,V` denotes a map. Scalar
type codes are standard protobuf: `1` double, `2` float, `3` int64, `4` uint64, `5` int32, `8` bool,
`9` string, `12` bytes, `13` uint32. `PROVEN`.

Enumerating all 861 descriptors yields the real backend schema. Everything in §5 is a quoting of
those descriptors unless marked otherwise. **Caveat, stated once:** these are `PROVEN` *schema* facts,
but whether the coordinator uses every one of the 861 messages is not established; the descriptors are
compiled into the bundle, and the coordinator demonstrably uses a subset.

### 5.2 The agent

```proto
message GrokBotAgent {                      // 29 fields
  string  id = 1;              string  legacy_agent_id = 2;
  string  name = 3;            string  description = 4;    string title = 5;
  string  avatar_shape = 6;    string  avatar_color = 7;   optional string avatar_version = 8;
  optional string avatar_url = 9;
  int64   created_at_ms = 10;  int64   updated_at_ms = 11;
  string  agent_id = 12;       string  harness = 13;       string role = 14;
  optional <enum> visibility = 15;   optional int32 team_id = 16;
  optional bool viewer_is_owner = 17; string viewer_session_id = 18;
  <enum>  kind = 19;           repeated string member_agent_ids = 20;
  optional string owner_display_name = 21;  repeated <People> people = 22;
  optional <Timestamp> published_at = 23;   bool team_default_for_viewer = 24;
  optional string voice_id = 25;  optional float voice_speed = 26;  optional string voice_language = 27;
  optional bool viewer_can_manage = 28;     optional bool drafting_disabled = 29;
}
```

`PROVEN`. Readings:

* there are **two id spaces**: `id` and `agent_id` (plus `legacy_agent_id`), and `GrokBotAgentDefinitionIdentity`
  carries the same trio `{id, agent_id, legacy_agent_id}` alongside `auth_id`, `user_id`, `harness`,
  `kind`, `visibility`, `team_id`, `deleted_at_ms`. `INFERRED`: `id` is a local/monotonic handle and
  `agent_id` is the stable external identifier the RPC layer uses (`q()` validates the latter's shape,
  §2.5); `legacy_agent_id` exists for migration. This matches the RPC layer, where every agent-scoped
  method takes `id: q()`.
* `kind` is a **discriminated union** — `VE`/`FE` in the coordinator test `r.toAgent.kind !== "agent"
  && r.toAgent.kind !== "cloud-agent"` (`JB:4108-4110`), so `agent` and `cloud-agent` are proven
  values, and `X2`'s `restoreTemporalAgentRouting` implies a `temporal` value as well.
* `harness` is a string whose value `"unsupported"` is a proven special case in the message-router
  dispatch: `m.harnessOf(M.id) === "unsupported"` ⇒ `{code:"server-transcript-read-failed",
  message:"Unsupported agent harness"}` (`JB:40189-40191`, `40198-40199`).
* `role`, `visibility`, `team_id`, `viewer_can_manage`, `viewer_is_owner` show the entity is
  **team-aware and viewer-projected**: the same row serialises differently per viewer.
* The RPC-side creation body is `GrokBotAgentDefinitionIdentity`-adjacent: `CreateGrokBotAgentRequest`
  has 17 fields `{legacy_agent_id, name, description, title, avatar_shape, avatar_color,
  avatar_data_url?, agent_id, harness, kickstart_requested?, introduction_suppressed?, purpose?,
  origin?, language?, create_intent, create_caller, created_automatically?}`. `PROVEN`. Comparing to
  the local `createAgent` schema (12 fields: `avatarPngBase64, creationRoute, origin, purpose,
  isIntroductionSuppressed, isKickstartRequested, isAutomatic, language, templateId, clientNonce,
  supportsTemporalHarness, harness` plus `bU`'s `name, description, title, avatarShape, avatarColor`)
  shows the local RPC is **camelCased and extended** (`clientNonce`, `supportsTemporalHarness`,
  `templateId`, `creationRoute`), not a literal protobuf projection. `PROVEN`.
* `{bU}`'s `avatarShape`/`avatarColor` and `GrokBotAgent.avatar_shape`/`avatar_color` plus
  `has_custom_avatar` and `avatar_url` establish the avatar model: shape+colour as a cheap identity,
  bytes/url as the expensive one (cf. `setAgentAvatarBytes {id, pngBase64}`,
  `generateAgentAvatarImage`, `x-sand-slim-avatars`).

### 5.3 Session, generation, sequence — the transcript ordering model

This is the most precisely recoverable part of the data model, and it is the part a clean-room host
most needs. `PROVEN` descriptors:

```proto
message GrokBotTranscriptEntry {           // append-only row
  uint64 seq = 1;            string entry_kind = 2;
  optional bytes body = 3;   optional string blob_hash = 4;
  uint64 updated_seq = 5;    optional string entry_id = 6;
  bool   body_omitted = 7;
}
message GrokBotTranscriptCursor {
  string agent_id = 1;   uint32 generation = 2;
  uint64 after_updated_seq = 3;   string session_id = 4;
}
message GrokBotTranscriptEntryDelete { uint64 seq = 1; uint64 updated_seq = 2; optional string entry_id = 3; }
message GrokBotTranscriptEntryRejection { uint64 seq = 1; uint64 current_updated_seq = 2; }
message ListGrokBotTranscriptEntriesRequest {
  string agent_id = 1;  optional uint32 generation = 2;  optional uint64 before_seq = 3;
  uint32 limit = 4;     string session_id = 5;          optional int64 unread_boundary_ms = 6;
}
message ListGrokBotTranscriptEntriesResponse {
  repeated GrokBotTranscriptEntry entries = 1;  uint32 generation = 2;
  repeated string cloud_agent_peer_ids = 3;     bool cloud_agent_peer_ids_known = 4;
  optional GrokBotTranscriptUnreadAnchor unread_anchor = 5;
}
message CommitGrokBotTranscriptEntriesRequest {
  string agent_id = 1; uint32 generation = 2;
  repeated GrokBotTranscriptEntry entries = 3;  repeated GrokBotTranscriptEntryDelete deletes = 4;
  string session_id = 5;
}
message CommitGrokBotTranscriptEntriesResponse {
  uint32 committed_count = 1; uint32 deleted_count = 2;
  repeated GrokBotTranscriptEntryRejection rejections = 3;
}
message GrokBotTranscriptUnreadAnchor {
  bool has_newer_rows = 1; string entry_id = 2; uint64 seq = 3; uint32 newer_rows = 4;
}
```

`PROVEN`. The reconstructed model:

* **Transcript identity is the tuple `(agent_id, session_id, generation, seq)`.** `session_id` is a
  *string* on the entity (so a session is a named logical thread, not merely a counter);
  `generation` is a `uint32` *reset epoch*.
* **Rows are ordered by `seq`**, and **versioned by `updated_seq`.** `seq` is append order;
  `updated_seq` is the *replication cursor*. `GrokBotTranscriptCursor.after_updated_seq` and
  `ListGrokBotTranscriptEntriesRequest.before_seq` show that pagination walks `seq` backwards while
  sync walks `updated_seq` forwards. `INFERRED`: an update to an existing row bumps its `updated_seq`
  without changing `seq`, which is what lets a client re-sync a window with a single monotonic cursor.
* **Deletes are tombstones, not removals** — `GrokBotTranscriptEntryDelete {seq, updated_seq, entry_id?}`.
  The `entry_id`-less form deletes a `seq`; the `entry_id`-bearing form deletes a named entry.
  `INFERRED`: the two forms cover "truncate from here" and "remove this specific entry".
* **Rejections are returned, not thrown.** `CommitGrokBotTranscriptEntriesResponse` reports
  `committed_count`, `deleted_count`, and a list of `{seq, current_updated_seq}` rejections — i.e.
  commit is **idempotent and partial-success**, with the server telling the client the current version
  so it can re-read and re-apply. `INFERRED` (strong, from the field names).
* **`generation` is invalidated explicitly.** `GrokBotTranscriptWatchCleared {agent_id,
  new_generation, session_id}` and `GrokBotTranscriptWatchCursorTooOld {agent_id, generation,
  session_id}` are the two "your cursor is void" signals. `rollBackConversation` and
  `startFreshConversation` are the local RPCs that *cause* a generation change.
* **`body` is opaque bytes with an out-of-line variant.** `body: bytes?`, `blob_hash: string?`,
  `body_omitted: bool` — three fields that together mean: the body may be inline, may be a content
  hash pointing at a blob store, or may be deliberately omitted from this response. `PROVEN` fields;
  `INFERRED` the blob-store reading, supported by `SandBoxStoreObjectEntry {rel_path, etag,
  size_bytes, last_modified_ms}` and the large `PresignSandBoxStoreWrites/Reads` family of messages in
  the same descriptor set.
* **The local RPC projection is proven-equivalent in shape.** The local reads are
  `getAgentTranscriptPage {id, beforeSeq?, limit, sinceMs?, untilMs?}`,
  `getAgentTranscriptWindow {id, beforeSeq?, limit}`,
  `getAgentTranscriptTail {id, beforeSeq?, limit, sessionId?, unreadBoundaryAt?}` — same ordering
  vocabulary (`beforeSeq`, `sessionId`), camelCased, with `id` for `agent_id`. `PROVEN`. The reply
  container is `k3e["transcript-page"] = {entries: array, nextBeforeSeq?: number, cloudAgentPeerIds?:
  string[]}` (`PROVEN`, renderer chunk), which matches
  `ListGrokBotTranscriptEntriesResponse` minus `generation`/`unread_anchor`.
* **Unread state is a boundary, not a flag.** `unreadBoundaryAt` (local) / `unread_boundary_ms`
  (protobuf) on reads, and `GrokBotTranscriptUnreadAnchor {has_newer_rows, entry_id, seq, newer_rows}`
  on responses. `INFERRED`: "unread" is computed as *"entries newer than a timestamp or anchor"*,
  not stored per-entry. The coordinator's own decoder confirms the anchor shape:
  `tM(r)` returns `{kind:"none"}` when `!r.hasNewerRows`, else `{kind:"at", entryId, seq: Number(r.seq),
  newerRows}` (`JB:31033-31043`). `PROVEN`.

### 5.4 Transcript entry kinds

Two vocabularies are recoverable, and they are **different**, which matters.

**Local/client entry kinds** — `JE` at `node-agent-node-agent-coordinator.beauty.js:4083-4091`:

```js
var JE = ["message", "tool-call", "send-message", "user-attachment", "notice", "event",
          "feedback", "voice-call", "mcp-app"];
```

`PROVEN`. A second, narrower set marks entries whose *body* is out-of-line or heavy:
`zV = ["tool-call", "user-attachment", "mcp-app", ...Nx]` with `xte = new Set(zV)` (`JB:31026-31028`).
`PROVEN`; `Nx` was not resolved. `INFERRED`: these are the kinds held in the blob store rather than
inline.

**Wire entry kinds** — `entry_kind` is a plain `string` on `GrokBotTranscriptEntry`. Which strings the
backend accepts is `UNKNOWN`; the client's `JE` is the best available list.

**Widget/approval entries are `send-message` with a typed payload.** `PROVEN` by the predicates at
`node-agent-node-agent-coordinator.beauty.js:4091-4100`:

```js
function KO(r) { return r.kind === "send-message" && r.message.type === "local-tool-permission"
                        && r.message.ask.status === "expired"; }
function WO(r) { return r.kind === "send-message" && r.message.type === "auto-review-approval"
                        && r.message.approval.surface === "bot_share"
                        && FO(r.message.approval.command) != null; }
```

and by the channel accessor `qE(r)` (`JB:4111-4117`) which reads `r.channel` for `kind === "message"`
and `r.message.channel` for `send-message` of type `text` or `attachment`. `PROVEN`. Therefore:

* entry kinds `message` and `send-message` both carry a `channel`;
* `send-message` payloads are **discriminated by `message.type`** with at least these proven values:
  `"text"`, `"attachment"`, `"local-tool-permission"`, `"auto-review-approval"`;
* `message.type === "local-tool-permission"` carries `message.ask.status` (proven value `"expired"`);
* `message.type === "auto-review-approval"` carries `message.approval.surface` (proven value
  `"bot_share"`) and `message.approval.command`.

`PROVEN` aliases: `Ea.callIdOf(channel) === null` for call channels (`JB:4118-4121`), and channel
prefix `VO = "meeting:"` (`JB:4121`) with `k0()`/`O0()` extracting meeting identity. So **a channel is
a namespaced string**, with `meeting:<id>` being one proven form.

### 5.5 The box

```proto
message GrokBotSessionBox {                 // 20 fields
  string agent_id = 1;  string session_id = 2;  string auth_id = 3;
  string tenant_id = 4; string store_id = 5;
  int64  provisioned_at_ms = 6;  optional int64 last_activity_at_ms = 7;
  optional int64 reap_claimed_at_ms = 8;  bool reap_claim_fresh = 9;
  optional int64 deleted_at_ms = 10;      bool agent_deleted = 11;
  <enum> pod_state = 12;   optional <GrokBotSessionBoxPod> pod = 13;
  int32  pod_count = 14;   repeated string failed_clusters = 15;
  <enum> credential_state = 16;  bool owner_missing = 17;  string lookup_error = 18;
  string box_key = 19;     bool viewer_box = 20;
}
message GrokBotSessionBoxPod {
  string cluster = 1; string pod_id = 2; string phase = 3;
  int64 creation_timestamp_ms = 4; optional int64 deletion_timestamp_ms = 5; string node_id = 6;
}
message GrokBotBoxState {
  <enum> run_state = 1;  bool recreate_in_flight = 2;  optional bool image_update_available = 3;
  optional string host_version = 4;  optional bool host_update_available = 5;
  <enum> disk_pressure = 6;  int64 updated_at_ms = 7;
}
```

`PROVEN`. The reconstruction:

* **A box is keyed by `box_key`** and scoped by `(agent_id, session_id, auth_id, tenant_id, store_id)`.
  `GrokBotTeamAgentSharedBox {box_key, kind, session_ids: string[]}` shows one box can be shared
  across sessions. `INFERRED`: `box_key` is the storage/lease identity; `(agent_id, session_id)` is
  the agent-thread identity that *uses* it.
* **A box has pods.** `pod`, `pod_count`, `pod_state`, `failed_clusters`, `cluster`, `node_id`,
  `phase`, and the admin RPCs `AdminHibernateSandBox`, `AdminReapGrokBotSessionBoxNow`,
  `AdminForceDeleteGrokBotSessionBox`, `RecreateSandBox`, `ForceRecreateSandBox`,
  `StartBulkTeamMemberSandBoxOperation` show Kubernetes-shaped infrastructure: a session box is a
  lease over one or more pods, with reap/hibernate/recreate lifecycle and migration.
* **`store_id` is a separate durable store.** The `SandBoxStore*` message family
  (`PresignSandBoxStoreWrites`, `CompleteSandBoxStoreMultipartWrites`, `CommitSandBoxStoreManifest`,
  `ListSandBoxStoreObjects`, `SandBoxStoreObjectEntry {rel_path, etag, size_bytes,
  last_modified_ms}`, `AdminSnapshotSandBoxStore`, `AdminRestoreSandBoxStoreSnapshot`) describes an
  object store with multipart upload, manifests, ETags and snapshot/restore. `PROVEN` existence;
  `INFERRED`: this is the durable home of `GrokBotTranscriptEntry.body` blobs (§5.3) and of
  `GrokBotAgentFile {name, path, size_bytes, content_type, updated_at_ms, etag}`.
* **`box_key` and the local `box` concept line up with the Forever Box methods.** The local RPCs
  `getForeverBoxStatus {id}`, `ensureForeverBox {id}`, `handBackForeverBox {id}`, `updateForeverBox
  {id}` all take an agent `id`, and the reply container is
  `k3e["box-status"] = null | {agentId: string, state: string}` (`PROVEN`, renderer chunk). The
  `handBack` verb matches `EndGrokBotBoxHandoffRequest` in the descriptor set. `INFERRED`: "hand back
  the Forever Box" releases the durable always-on box lease so it is not held indefinitely.
* **`viewer_box` / `viewer_is_owner` / `team_default_for_viewer`** are per-viewer projections on the
  same rows. `INFERRED`: the backend returns differently-shaped rows to different viewers rather than
  separating storage; a clean-room host can do the same.

### 5.6 The descriptor set as a whole

`PROVEN` counts and shape: **861 message descriptors**, all in package `aiserver.v1.`, decoded by the
same parser. The largest are `GrokBotAgent` (29), `AdminGrokBotEmailMessage` (21),
`OnePasswordConnection` (20), `GrokBotSessionBox` (20), `SendGrokBotUserMessageRequest` (20),
`GrokBotAgentDefinitionIdentity` (20), `GrokBotChangelog` (19), `GrokBotMeetingRequestLogJevCall` (18),
`CreateGrokBotAgentRequest` (17), `GrokBotMarketplaceListing` (16), `GrokBotAgentPlugin` (16),
`EnsureSandBoxResponse` (15).

`EnsureSandBoxResponse` is the box-provisioning contract and therefore central to §1.8:

```proto
message EnsureSandBoxResponse {
  string cluster = 1;                 string tenant_id = 2;
  string pod_id = 3;                  string network_token = 4;
  string exec_daemon_auth_token = 5;  string exec_daemon_url = 6;
  string vnc_url = 7;                 string terminals_folder = 8;
  optional bool image_update_available = 9;
  string gateway_url = 10;            string gateway_token = 11;
  string fork_vnc_base_url = 12;
  <enum> run_state = 13;              optional bool egress_tunnel_ownership = 14;
  <SandBoxImageInfo> image = 15;
}
```

`PROVEN`. Cross-check with the host code in §1.8: `baseUrl = e.gatewayUrl`, `token = e.gatewayToken`,
`headers[x-sand-network-token] = e.networkToken`, `vncProxy = {primaryUrl: e.vncUrl, forkBaseUrl:
e.forkVncBaseUrl}` — **every field consumed, field-for-field**, including `egressTunnelOwnership`
(`main-app.beauty.js:78413-78421`). This is a strong verification that the descriptor decode is
correct.

The complementary message set is enumerable from the names alone and is `PROVEN` as a set: the
descriptor list contains a full admin surface (`Admin*`, 40+ messages), a team surface
(`*TeamMemberSandBox*`, `CloneGrokBotAgentToTeam`, `GetGrokBotTeamContextSummary*`), an email surface
(`GrokBotEmailInbox`, `GrokBotEmailDraft`, `AdminListGrokBotEmailInboxes`), a meetings surface
(`GrokBotMeetingTranscriptLine`, `AdminGetGrokBotMeetingTranscript*`), a SCM surface
(`SendGrokBotPullRequestChatMessageRequest`), and a user-computer surface
(`GrokBotUserComputerMessagesOp/ClientMessage/ControlMessage/Result/Error/Accepted`).

### 5.7 Group, tray, task, subagent, automation, workflow

| Entity | Evidence (`PROVEN`) | Notes |
|---|---|---|
| **Group** | local `createGroup {name, description, memberAgentIds: string[], humanMemberUserIds?: number[], namedBy?, creationRoute, clientNonce?}`; `setGroupMembers {id, memberAgentIds, requesterAgentId?}`; `GrokBotBoxRoomSummary {room_id, members_server_bound`…}`; `GrokBotGroupChatDocumentAssetUrl {name, url, expires_at_ms}`; `GrokBotTeamAgentSharedBox {box_key, kind, session_ids}` | A group is a *room* of agents (and optionally humans) with a shared box. `namedBy` and `clearGeneratedRoomNameStamps {rooms: [{id, generatedName}]}` show room names may be model-generated and are tracked with a stamp so a human rename is not clobbered. |
| **Tray** | `getTrays` (noArgs, `background`), `dismissTray {id}`, `clearTrays` (noArgs, `person`); event family `"tray"` (`JB:36832`) | `INFERRED`: a tray is a *pending-item* surface — a notification/approval queue shown outside the transcript. No protobuf descriptor named `*Tray*` exists in the set, so the tray is coordinator-local state, not a backend entity. `PROVEN` negative for a Tray descriptor. |
| **Task** | local `getAgentTasks {agentId}`, `markAgentTaskDone`, `markAgentTaskRead`, `setAgentTaskPinned` all `{id: q(), …}`-ish; descriptors `GrokBotTaskListMessage {is_user, text}`, `GrokBotTaskListFinishedWork {title, is_failed}`, `DismissGrokBotTaskRequest` | Two-layer: a *task list* the agent maintains (message/finished-work rows) and a *dismiss* RPC. `getAgentTasks` is `person` while `getAgentTodos` is `background` — they are different things: `agentTasks` are the waiting-for-you queue, `agentTodos` the agent's own checklist. `PROVEN` classes. |
| **Subagent** | `GrokBotRunningSubagent {subagent_id, subagent_type, title, started_at_ms}`; local `getSubagents {id}`; event family `subagents` | Ephemeral child runs. Note the id is `subagent_id`, *not* `agent_id` — a subagent is not a first-class agent. |
| **Automation** | `GrokBotAgentAutomation {automation_id, record_json}`; `SetGrokBotAgentAutomationEnabledRequest`; `ListGrokBotAccountAutomationsResponse`/`GrokBotAccountAutomationGroup`; local `IU = w({name, description, body, trigger: at({schedule, isEnabled}), sourceRef: at(p())})` | `record_json` + `record_json`-style storage means the automation body is **opaque JSON owned by the client** — a very reproducible design (the host stores, the client interprets). |
| **Workflow** | local `lw = {id: p(), workflowId: p()}`; `IU` above is the workflow body; `Px = ["plugins","secrets","skills","memories","automations","files","description"]` with `jV(r, e) => Px.indexOf(r.kind) - Px.indexOf(e.kind)` (`JB:31043-31047`) | `Px` is the ordering of **agent-definition sections** for display/diff. `jV` is a comparison function — `INFERRED`: used to sort definition sections in a stable order, which is what a workflow/definition editor needs. |
| **Run** | `GrokBotBoxState.run_state`, `GetSandBoxRunStateRequest/Response`, local `interruptAgentRun {id, sessionId?}` | `INFERRED`: a *run* is one turn-execution episode; `interruptAgentRun` targets the current or named session's run. The field name `run_state` appears both on the box (`GrokBotBoxState`) and on the sandbox, so runs and boxes are correlated. |
| **Account slot** | `Ko = "host"` (`JB:4046`); `I$ = {accountSlot: p(), clientNonce: p(), …}`; `recordSendEcho({accountSlot: Ko, clientNonce})` (`JB:39818`) | `PROVEN`: there is a single well-known account slot value, `"host"`, used by the coordinator when reporting its own sends. `INFERRED`: multi-account is anticipated (`accountSlot` is a string, not a boolean), but the desktop coordinator runs only the `host` slot. |

### 5.8 Identifier summary

`PROVEN` from the schemas above:

| Identifier | Type | Scope | Validated how |
|---|---|---|---|
| `agentId` / `id` (agent) | string | global, stable | `q()` → `iF()`: non-empty, trimmed, no `/` `\` NUL, not `.`/`..` (`JB:406-421`, `33696-33701`) |
| `legacy_agent_id` | string | migration alias | none observed |
| `sessionId` | string | per agent | `A(p())` — plain optional string at the RPC boundary (`PROVEN`: **not** shape-validated) |
| `generation` | uint32 | per `(agent, session)` | int32-range check elsewhere; on the wire it is a number |
| `seq` | uint64 | per `(agent, session, generation)` | number |
| `updated_seq` | uint64 | replication cursor | number |
| `entryId` | string | per entry | `A(p())` — plain optional string |
| `rootId` | string | per entry | `p()` |
| `groupId` | string | per group | via `setGroupMembers {id: q(), …}` — validated as an agent id shape |
| `clientNonce` | string | per client send | plain optional string; echoed back via `recordSendEcho` |
| `requestId` | string | per in-flight call | non-empty string (`pr`) |
| `box_key` | string | per box | backend-assigned |
| `bcId` | string | per cloud agent | plain string |
| `subagent_id` | string | per subagent | not validated at the local boundary |
| `agentTask` / `automationId` / `workflowId` | string | per owner | `p()` |

The asymmetry is deliberate and worth flagging: **`agentId` is the only identifier whose *shape* is
enforced at the local RPC boundary**, because it is the only one that becomes a filesystem path
segment. Everything else is an opaque string. `INFERRED`.
## 6. Approval / interrupt flows

### 6.1 The card model

Approvals are **transcript entries**, not out-of-band RPCs. `PROVEN` from the entry predicates in
§5.4: an approval appears as an entry of kind `send-message` whose `message.type` discriminates the
card, and the client resolves it by `entryId`. `PROVEN` by the argument schemas:

| local method | args | matching backend message |
|---|---|---|
| `respondToWidget` | `{entryId, value, agentId, sessionId?}` | `RespondGrokBotWidgetRequest {agent_id, entry_id, value, session_id}` |
| `dismissWidget` | `{entryId}` | `DismissGrokBotWidgetRequest` |
| `submitUserForm` | `{entryId}` | — |
| `dismissUserForm` | `{entryId}` | — |
| `submitSecret` | `{entryId}` | — |
| `sendDraft` | `{entryId}` | — |
| `discardDraft` | `{entryId}` | — |
| `reactToMessage` | `{entryId}` | `ReactToGrokBotMessageRequest` (4 fields) |
| `resolveAutoReviewApproval` | `{entryId, requestId, resolution, agentId, approvalPlatform?, approvedCommand?, sessionId?}` | — |
| `resolveLocalToolPermission` | `{entryId, requestId, resolution, agentId, sessionId?}` | — |
| `resolveConnectorGrant` | `{entryId, requestId, resolution, agentId, sessionId?}` | — |
| `resolveVirtualCardApproval` | `{entryId}` | — |
| `resolveMessagesGrants` | `{requestId}` | — |

`PROVEN`. The shape is consistent: **every resolution is `entryId`-addressed**, except the three that
are `requestId`-addressed (`resolveMessagesGrants`, and the two `kU`-built ones carry both). The
`RespondGrokBotWidgetRequest` ↔ `respondToWidget` pair is a **field-for-field match modulo
camelCasing**, which is the clearest instance of the general pattern: the local RPC is a JSON,
camelCased projection of the corresponding `aiserver.v1` request message. `PROVEN` for this pair;
`INFERRED` as a general rule, because `sendPrompt` (21 fields) vs `SendGrokBotUserMessageRequest`
(20 fields) differs by more than case (`prompt`, `directAddressedAcceptance`, `clientNonce`,
`supportsTemporalHarness` are local-only; `message_id`, `sent_at_ms` are backend-only).

`respondToWidget`'s reply container is `record-or-null` (`W2`, `JB:36858`) and the backend response is
`RespondGrokBotWidgetResponse {accepted: bool, refusal?: <enum>}` — i.e. **resolution can be refused**,
which is why the client container allows `null`. `PROVEN`.

### 6.2 Resolution vocabularies

Four resolution vocabularies are recoverable as literals, and they are distinct per card type:

```js
LE = ["approved", "denied"],                                   // JB:4048
ba = ["approved", "denied", "always"],                         // JB:4049  (auto-review approval)
UE = ["allowed", "skipped", "always_this_bot", "always_all_team_bots"],  // JB:4050 (connector grant)
ka = ["up", "down", "submit", "revert"],                       // JB:4054  (feedback action)
```

`PROVEN`. Bindings, `PROVEN` by the schema expressions that reference them:

* `resolution: _e("approval resolution", ba)` — `resolveAutoReviewApproval` (`JB:34176`).
* `resolution: _e("connector grant resolution", UE)` — `resolveConnectorGrant`, via
  `gw = kU(_e("connector grant resolution", UE))` (`JB:34009`, `kU` at `JB:34005`).
* `resolution: r` — `resolveLocalToolPermission`, via `fw = kU(j$)` where
  `j$ = dt("local tool permission resolution", aa)` (`JB:33926` region, `JB:34008`). `aa` was **not**
  located as a literal array in the bundle. `UNKNOWN`: the local-tool-permission resolution values.
* `action: _e("feedback action", ka)` — `voteFeedback` (`JB:34240`).

`INFERRED` from the vocabularies: an auto-review approval can be made **sticky** (`"always"`), and a
connector grant can be made sticky **per bot** (`"always_this_bot"`) or **per team** (`"always_all_team_bots"`).
That is the whole "stop asking me" design, and `"always_all_team_bots"` shows the grant scope is a
team, not a user. `INFERRED` (strong: the string literals are self-describing).

A fifth, distinct taxonomy is the **draft payload** union `$n` (`JB:4062-4080`), `PROVEN`:

```js
$n(r) = r.type === "email-draft"          ? {from: string, to: string[], cc?: string[],
                                             subject: string, body: string}
      : r.type === "slack-draft"          ? {workspace?: string, target: string,
                                             thread?: string, body: string}
      : r.type === "meeting-chat-draft"   ? {meetingId: string, meetingTitle?: string,
                                             body: string, markInternal?: true}
      : false
```

with the caller shape `R$ = dt("draft payload", $n)`. So `sendDraft`/`discardDraft` act on a
**draft the agent composed for an external surface** (email, Slack, meeting chat) — a card in the
transcript whose resolution *is* the send.

### 6.3 The `request` / `await` / `cancel` trio pattern

Three methods appear in a strict trio, all `background`, and the pattern is `PROVEN` in the authz map
and in the argument schemas:

```
requestX {requestId}    background    begin a ceremony; returns immediately
awaitX   {requestId}    background    long-poll/observe until settled
cancelX  {requestId}    background    abandon it
```

plus a `person`-class terminal call. The proven instances:

| ceremony | request | await | cancel | terminal | terminal authz |
|---|---|---|---|---|---|
| macOS Messages grants | `requestMessagesGrants` | `awaitMessagesGrants` | `cancelMessagesGrants` | `resolveMessagesGrants` | `person` |
| cookie-origin approval | `requestCookieOriginApproval` | `awaitCookieOriginApproval` | `cancelCookieOriginApproval` | *(resolved on the `cookie-provider` edge)* | `background` edge class |
| WebAuthn ceremony | `requestWebAuthnCeremony {kind}` | — | — | *(resolved on the `passkey-provider` edge)* | `background` edge class |

`PROVEN` for names, classes and arg fields. Corroborating literals:

* `dO = ["get", "create"]` (`JB:2724`) is the WebAuthn **ceremony kind** enum, and
  `requestWebAuthnCeremony`'s arg is `kind` — so `requestWebAuthnCeremony {kind:"get"|"create"}`
  requests a passkey assertion or attestation. `PROVEN`.
* `v$ = w({kind: N$, origin: p(), optionsJson: p()})` where `N$ = _e("ceremony kind", dO)`
  (`JB:33921-33923`) is the full ceremony request shape passed to the main process, which then runs
  the native `sand-webauthn-signer` (`FINDINGS.md:25`). `PROVEN`.
* `jq = rO("kind", [ Bt({kind: st("ceremony"), requestId: ut(), ceremony: Bt({kind: Jn([st("get"),
  st("create")]), origin: ut(), optionsJson: ut()})}), … ])` (`JB:2725+`) is a **second, zod-style
  schema** for the same ceremony, used at the main-process boundary. `PROVEN` existence; the two
  schemas (dune and zod) describe the same payload — `INFERRED`: an artifact of the payload crossing a
  package boundary between a dune-typed module and a zod-typed one.
* the coordinator's own WebAuthn endpoints are `aO = "/webauthn/requests"` and
  `iO = "/webauthn/responses"` (`JB:2719-2720`), with a poll cadence `RE = 1e4` (10 s),
  `zq = 3e4` (30 s), `lO = Math.ceil(zq / RE)` (`JB:2721-2724`). `PROVEN`.

**Lifecycle, reconstructed (`INFERRED`, with the proven anchors named):**

```
agent / automation needs a capability it cannot get unattended
        │
        ├─▶ requestX {requestId}                     [background — legal with nobody present]
        │      • coordinator creates a pending ceremony keyed by requestId
        │      • the card is appended to the transcript as a `send-message` entry
        │        (kind "local-tool-permission" | "auto-review-approval" | …)
        │      • a `tray` event fires so clients surface it outside the transcript
        │
        ├─▶ awaitX {requestId}                       [background — safe to block on]
        │      • multiple clients may await the same requestId simultaneously;
        │        await is background precisely so a phone can wait without a person
        │
        ├─▶ [person] resolveY {entryId, requestId, resolution}
        │      • resolution ∈ approved|denied|always | allowed|skipped|always_this_bot|always_all_team_bots
        │      • the card is updated in place; the awaiting call settles
        │      • `expired` is a proven terminal status for a local-tool-permission ask
        │        (predicate KO, JB:4091-4092)
        │
        └─▶ cancelX {requestId}                      [background]
               • abandon; only legal while nobody has resolved it
```

The proof that this is a *watched* rather than *polled* flow is the event-family set: `tray`,
`messages-grants`, and `agent-activity` are all client-facing families (`JB:36832`, `36842`, `36846`),
and the coordinator starts each ceremony's poll only after a `request`: `const l = e.claim ?? sj` …
(`main-app.beauty.js:54301`, `54316`) — the resumable "claim" pattern appears twice, and the MCP OAuth
loopback uses a *foreign-claim* backoff `ld({name: "sand-mcp-oauth-loopback-foreign-claim",
intervalMs: 250})` (`main-app.beauty.js:55186`), showing concurrent-claim handling is a first-class
concern. `PROVEN` for the literals; `INFERRED` for the sequencing.

### 6.4 Interrupt

`interruptAgentRun { id: q(), sessionId?: p() }`, class `person`, on the client surface (`reply:
"record"`). `PROVEN`. It is the only interrupt RPC on the edge; there is no `cancelRun`,
`abortTask` or `stopAutomationRun`. `PROVEN` negative.

`INFERRED`: interrupting is `person`-class because it must be able to *wake* a box that has gone to
sleep mid-run — the same authority `sendPrompt` needs. The optional `sessionId` matches
`startFreshConversation {id, sessionId?}` and `rollBackConversation {id, sessionId?}`, i.e. these three
are **session-scoped conversation controls**. Note that `rollBackConversation` and
`startFreshConversation` are precisely the operations that would bump `generation` (§5.3) and
therefore invalidate transcript cursors.

### 6.5 Trays

`getTrays` (noArgs, `background`), `dismissTray {id}`, `clearTrays` (noArgs, `person`); event family
`"tray"`. `PROVEN`. No protobuf descriptor named `*Tray*` exists in the 861-message set. `PROVEN`
negative. `INFERRED`: a tray is a **coordinator-local** pending-item surface — the "came back because
your approval is needed" affordance (`FINDINGS.md:126`) — deliberately separate from the transcript so
that a client can enumerate what needs a human without reading the transcript. Its read is
`background` (a phone can poll it unattended) while `clearTrays` is `person` (a bulk dismissal is a
deliberate human act). `dismissTray` being `person` and `getTrays` being `background` is exactly the
read/write asymmetry seen throughout the map.

---

## 7. Backend contract

### 7.1 Three distinct planes

The single most important distinction in this dossier. `PROVEN` throughout.

| Plane | Transport | Who authenticates | Examples |
|---|---|---|---|
| **A. Local coordinator RPC** | Electron `MessagePort` (structured clone, 5 frame kinds) | nobody — process isolation + single claimant only | all 172 gateway methods as *seen by the client* |
| **B. Box gateway hop** | HTTP(S) + JSON + SSE over loopback or pod proxy | `Authorization: Bearer {gateway_token}` (+ `x-sand-network-token`) | `POST {gateway_url}/api/{method}`, `GET {gateway_url}/events` |
| **C. Remote backend** | HTTP(S) + JSON, connectrpc/protobuf for a few services; deep links for app routing | Cursor session tokens (`/oauth/token`, `/auth/poll`) | `https://api2.cursor.sh`, `aiserver.v1.*Service/*` |

Plane B is the one most easily mistaken for "the backend". It is reached with a **per-box bearer token
minted by the backend and stamped on the box**, and its base URL is classified `loopback` or
`pod_proxy` (`JB:35457`). Plane C is reached with the *user's* session and is entirely separate.

### 7.2 Plane C — backend host and env overrides

| Literal | Location | Note |
|---|---|---|
| `"https://api2.cursor.sh"` | `main-app.beauty.js:544`, `28456`; `main-core.beauty.js:25886`; `preload.beauty.js:4109` (`Iu = "api2.cursor.sh"`) | default backend |
| `"api2.cursor.sh"` | `node-agent-node-agent-coordinator.beauty.js:36703` (`G2`) | used only as a DNS-lookup target for the "independent lookup" diagnostic (`JB:36800`) |
| `"https://api2.cursor.sh/updates"` | `main-core.beauty.js:27520` (`JU`) | update feed |
| `CURSOR_API_BASE_URL` | `main-app.beauty.js:28455` | `U4(e) = cxe(e ?? process.env.CURSOR_API_BASE_URL ?? "https://api2.cursor.sh")` |
| `CURSOR_WEBSITE_URL` | `main-app.beauty.js:28453` | `dxe(e) = cxe(e ?? process.env.CURSOR_WEBSITE_URL ?? "https://cursor.com")` |
| `SAND_BACKEND_URL` | `preload.beauty.js:4112` | checked **before** `CURSOR_API_BASE_URL` |
| `SAND_HOST_GATEWAY_URL` / `_TOKEN` / `_NETWORK_TOKEN` | `main-core.beauty.js:26245-26250` | plane-B overrides |
| `SAND_DISABLE_SEND_ACCEPT_RETURN` | `node-agent-node-agent-coordinator.beauty.js:4046` (`qO`) | send-accept behaviour toggle |
| `SAND_DISABLE_SLIM_AVATARS` | `39947` (read site), consumed at `JB:39947` | disables `x-sand-slim-avatars` |
| `SAND_DEV_BOX_CONTAINER`, `SAND_DEV_*` | `main-core.beauty.js:26235-26240` | dev-box plumbing |
| `NODE_USE_SYSTEM_CA_ENV=1` | `main-app.beauty.js:91563` | forced into the coordinator's env |

`PROVEN`. The **production-backend check** is exposed to the renderer, `preload.beauty.js:4110-4113`:

```js
function Nu() {
  let e = process.env.SAND_BACKEND_URL ?? process.env.CURSOR_API_BASE_URL;
  return e == null || e.length === 0 ? !0 : URL.canParse(e) && new URL(e).host === Iu;
}
```

exposed as `desktop.environment.usesProductionBackend` (`preload.beauty.js:4114-4124`). `PROVEN`: the
client can tell whether it is pointed at the real backend, which matters for the dev-login guard
below.

### 7.3 Plane C — connectrpc service paths

Only four connectrpc method paths exist as literals across the bundles:

| Path | Location | Surface |
|---|---|---|
| `/aiserver.v1.GrokBotService/VoiceCallHarnessSession` | `main-app.beauty.js:35777` (`pU`) | voice-call harness stream |
| `/aiserver.v1.GrokBotService/VoiceCallHarnessTool` | `main-app.beauty.js:35778` (`fU`) | voice-call tool channel |
| `/aiserver.v1.SCMService/BatchGetPullRequestStatus` | `main-app.beauty.js:29921` (`kMe`) | PR status |
| `/scmapi.v0.ScmService/BatchGetPullRequestStatus` | `main-app.beauty.js:29922` (`X$t`) | the same call on the older service |
| `/aiserver.v1.AnalyticsService/BootstrapStatsig` | `main-app.beauty.js:52215` | feature-flag bootstrap |

`PROVEN` for all five literals. Context that makes the PR pair legible (`main-app.beauty.js:29923-29925`):

```js
(eqt = new Set(["unavailable", "unimplemented"])),
(tqt = new Set([404, 429, 502, 503, 504]));
```

`PROVEN`: the client tries the newer `aiserver.v1.SCMService` path and **falls back** to
`scmapi.v0.ScmService` when the backend answers `unavailable`/`unimplemented` (or the retryable HTTP
set). `INFERRED`: a service migration in progress. A self-hosted host can treat the connectrpc surface
as *optional* — it is a handful of auxiliary calls, not the agent-driving path.

The ConnectRPC runtime is bundled in the main process (prolific `ConnectError` construction in
`main-app.beauty.js:12020-13022` with `Code.InvalidArgument`/`ResourceExhausted`/`DeadlineExceeded`
/`Internal`/`Unimplemented` mappings, envelope framing and compression checks). `PROVEN` that
`@connectrpc/connect` (as `FINDINGS.md:21` records) is present and used for plane C. `UNKNOWN`: the
full list of generated service clients, because the descriptor table for services is not in the
extracted literal set.

### 7.4 The `/v1/*` paths are **deep-link routes**, not backend endpoints

This is a correction to the received framing. All seventeen `/v1/*` literals live inside one
**URL-route declaration** in `main-core.beauty.js:18274-18325`. The `path`-building helper `_a` is
`PROVEN` at `main-core.beauty.js:18197-18205`:

```js
var Ll = /^[A-Za-z0-9_-]{21}$/;
var _a = {
    schemes: ["grokbot", "sand"],
    authority: "app",
    httpsOrigin: "https://cursor.com",
    httpsPathPrefixes: ["/grok-bot/link", "/sand/link"],
    path: "/v1/bot-template",
    maxLength: 2048,
};
```

and the route table is `hm = nT({ authority: DQ, schemes: [PQ, kQ], maxUrlLength: wQ, routes: {...} })`
with entries such as (`PROVEN`):

```js
agent: dt("/v1/agent", { id: pe(Em) }),          // Em = /[A-Za-z0-9_-]{1,128}/
"bot-template": dt(_a.path, { id: pe(Ll) }),
marketplace: dt("/v1/marketplace", { tab: Le(pe({oneOf: LQ})), id: Le(pe({pattern: MQ, maxDecodedLength: 128})) }),
"plugin-add": dt("/v1/plugin/add", { id: pe(/[0-9]{1,19}/) }),
"plugin-native": dt("/v1/plugin/native", { id: pe({oneOf: pk}) }),
"github-connect-callback": dt("/v1/github-connect-callback", {
  state: pe(/cursor_grok_bot_github_v1\.[0-9a-f]{32}\.[0-9a-f]{32}/),
  code: Le(pe(/[A-Za-z0-9_-]{1,200}/)),
  installationId: Le(pe(/[1-9][0-9]{0,18}/)),
  setupAction: Le(pe({oneOf: ["install","update","request"]})),
  error: Le(pe(/[a-z_]{1,64}/)) }),
open: dt("/v1/open", {}),
"create-team-bot": dt("/v1/create-team-bot", {}),
settings: dt("/v1/settings", { id: pe({oneOf: mk}) }),
thread: dt("/v1/thread", { agent: Le(pe(Em)), id: pe(_k) }),        // _k = /[0-9a-f]{10}/
task: dt("/v1/task", { agent: Le(pe(Em)), id: pe(_k) }),
sidebar: dt("/v1/sidebar", { target: Le(pe({oneOf: Sk})), automation: Le(pe(dk)),
                             agent: Le(pe(Em)), tab: Le(pe({oneOf: gk})) }),
```

`PROVEN`. So `/v1/agent`, `/v1/thread`, `/v1/task`, `/v1/sidebar`, `/v1/settings`, `/v1/marketplace`,
`/v1/open`, `/v1/bot-template`, `/v1/create-team-bot`, `/v1/plugin/add`, `/v1/plugin/native` and the
five OAuth-callback routes are **application deep links** — opened as `grokbot://app/v1/...` or
`sand://app/v1/...`, with an `https://cursor.com/grok-bot/link` (or `/sand/link`) fallback
(`_a.httpsPathPrefixes`). They are *not* HTTP API paths on `api2.cursor.sh`. `PROVEN`.

Design consequence, `INFERRED`: this is how a phone or an email link hands work to the desktop — the
link is routed into the app, and the return leg is a coordinator RPC. Only
`/v1/github-connect-callback` (and its gitlab/bitbucket/azure-devops/onepassword siblings) has an RPC
counterpart (`completeGithubConnect`), which is the mechanism by which an OAuth callback that arrives
out-of-band is married to the ceremony that started it.

### 7.5 Plane C — auth flows

| Path | Location | Shape (`PROVEN` literals) |
|---|---|---|
| `/auth/poll` | `main-app.beauty.js:28764` | `GET`-style poll with `?uuid=&verifier=`; `403` carries `{error}`; `404` resets the retry counter; `3` consecutive failures raise `iL` |
| `/oauth/token` | `main-app.beauty.js:31866` | `POST` JSON `{client_id, grant_type:"refresh_token", refresh_token}` under a deadline |
| `/auth/logout` | `main-app.beauty.js:31624` | `POST` with `authorization: Bearer <token>` |
| `/oauth/return` | `main-app.beauty.js:471`, `local-exec-daemon.beauty.js:3015` | OAuth return leg |
| `/auth/cursor_dev_session_token` | `main-core.beauty.js:25850` | dev-login; `?plan=&trial=&email=`; **refuses non-dev backends**: `if (!oU(r)) throw new Lc(\`refusing dev-login against non-dev backend ${r.protocol}//${r.host}\`)` |
| `/webauthn/requests`, `/webauthn/responses` | `node-agent-node-agent-coordinator.beauty.js:2718-2720` | WebAuthn proxy relay |
| `/sand/feedback` | `main-app.beauty.js:87294` | feedback submission |
| `/sand/link` | `main-core.beauty.js:18201` | listed as an `httpsPathPrefix` for deep links |

`PROVEN`. Additional `PROVEN` auth-flow details:

* login begins by **opening a browser** at `${websiteUrl}/loginDeepControl?challenge=…&uuid=…&mode=login&redirectTarget=sand&supportsSelectedTeamLogin=true` (`main-app.beauty.js:28754-28764`), i.e. an out-of-band browser login with a challenge/verifier pair, polled on plane C with `/auth/poll`.
* session refresh distinguishes `shouldLogout` (terminal sign-out), an MDM policy refusal, and a rotation-race rescue — seeded source path `cursor-auth.ts runRefreshAccessToken` (`main-core.beauty.js:26709-26743`).
* secure storage failure is non-fatal and *reported*: `sessionSecretsUnavailable` — "OS secure storage is unavailable, so the signed-in session's Cursor tokens are held in memory only and will not survive a restart" (`main-core.beauty.js:26745-26752`). `PROVEN`.
* token storage is `OS secure storage` via Electron `safeStorage`, with `SAND_SIMULATE_SECURE_STORAGE_UNAVAILABLE=1` as a test hook (`main-core.beauty.js:26253`). `PROVEN`.

### 7.6 Plane B — what the box gateway contract is, in full

Collected from §1.8 and §5.6, `PROVEN`:

```
POST {gateway_url}/api/{method}      body: JSON args            auth: Bearer {gateway_token}
GET  {gateway_url}/events            accept: text/event-stream  auth: Bearer {gateway_token}
POST {gateway_url}/events/echo?nonce={nonce}                    auth: Bearer {gateway_token}
GET  {gateway_url}/health                                       auth: Bearer {gateway_token}
```

with `{gateway_url, gateway_token}` delivered by `EnsureSandBoxResponse` and `network_token` carried as
`x-sand-network-token` when present. `INFERRED`: `/events/echo` is a liveness/round-trip probe — the
client posts a nonce and expects an SSE comment line `":echo <nonce>"`, which is why
`Iw = ":echo "` and `h.slice(Iw.length)` exist. That reading is consistent with the `nonce` query
parameter and the SSE comment convention (`:`-prefixed lines are comments and are otherwise ignored by
SSE parsers).

---

## 8. Design implications for a clean-room open-source host

Every recommendation below is tied to a proven mechanism. Where the recommendation goes *beyond* the
evidence (e.g. adding a check the vendor does not have), it says so.

### 8.1 Worth reproducing, essentially as-is

1. **The `person` / `background` class on every method, carried as data.** `PROVEN` mechanism
   (§3.24, §4). It is a small table with an outsized payoff: it makes "may this wake the machine?"
   answerable per method, statically, and it makes unattended-safety *reviewable* — you can diff the
   `background` set in a PR. Reproduce the table, the two predicates, and — critically — the
   **inversion** from §4.4: `background` calls must be *refused rather than wake the box*.
2. **Per-call `demand`, validated for spelling only, and never forwarded.** `PROVEN` (§4.5). The
   caller declares whether a human is waiting. Keep it a hint. If you want it to be a *control*, you
   must add signing — the vendor does not (§4.6).
3. **The single-claimant port claim (`claim` → `{request, release}`).** `PROVEN` (§1.5). One
   authenticated client owns the agent channel; everyone else either waits or goes through the
   backend. This is what makes "the desktop and the phone both drive the agent" tractable without a
   distributed lock: only one of them holds the port at a time.
4. **A framed, multiplexed, cancellable RPC session with an explicit hello and version.**
   `PROVEN` (§1.7). Five frame kinds, a monotonic `requestId` per port, `AbortController`-backed
   cancellation that *replies*, and a negotiated `protocolVersion`. Reproduce the discipline:
   duplicate `requestId` is a breach; wrong-direction frames are a breach; wrong version is a
   breach.
5. **`{args: "none"|"object", reply: <container>}` as a separate, generated shape table.** `PROVEN`
   (§2.8). Two independent layers — field schemas for the arguments, container checks for the
   replies — kept byte-identical between client and host by code generation. This is what lets a
   client validate replies cheaply and fail with a precise error instead of trusting them.
6. **Strip-unknown-keys argument validation.** `PROVEN` (§2.2, `TH`). Forward compatibility without a
   version per method: old hosts ignore new fields.
7. **Append-only, versioned transcripts with tombstones and explicit generation resets.** `PROVEN`
   (§5.3). `(agent, session, generation, seq)` for order, `updated_seq` for the sync cursor,
   `{seq, updated_seq, entry_id?}` for deletes, `{agent_id, generation, session_id}` for "your cursor
   is void", and a commit that returns **rejections with the server's current version** rather than
   failing the batch. This is the single most valuable backend design in the codebase and it is fully
   recoverable.
8. **Approvals as transcript entries addressed by `entryId`.** `PROVEN` (§6.1). One addressing scheme
   for every card type, one resolution RPC per card, and the card's own payload discriminated by a
   string `type`. The agent can be woken to *ask*; only a person can *resolve*.
9. **The `request` / `await` / `cancel` trio with `background` class and a `person` terminal call.**
   `PROVEN` (§6.3). This is the shape that lets a phone *start* a ceremony unattended and settle it
   interactively later.
10. **A "tray" that is separate from the transcript.** `PROVEN` (§6.5) as local state. A cheap
    pending-item index is what lets a phone answer "does anything need me?" without reading a
    transcript.
11. **Box wake authority as a first-class, feature-gated policy.** `PROVEN` (§4.7): the park mode is
    behind `sand_desktop_away_park` / `sand_desktop_present_park`, and presence is derived from the OS
    (`idle`, screen lock, screensaver, suspend, window focus), not from the client. Reproduce the
    *derivation*, not the gate mechanism.
12. **Explicit "why" in refusals.** `PROVEN`: `box_blocked`, `SandAwayParkedError` ("nobody is at this
    computer"), `SandPresentParkedError` ("left asleep until something needs it"), and the secret
    refusal taxonomy `["not_owned","not_sensitive","host_error","value_not_saved"]` (§3.15). A client
    can render an honest message and choose a retry strategy.

### 8.2 Vendor-specific — do not copy

1. **The pod/gateway broker.** `PROVEN` (§5.5, §7.6): `EnsureSandBox` returns `cluster`, `pod_id`,
   `tenant_id`, `gateway_url`, `network_token`, `vnc_url`, `fork_vnc_base_url`,
   `exec_daemon_auth_token`, plus a Kubernetes-shaped admin/lease/migration surface. This is
   Anysphere's fleet. A self-hosted host has one box: itself. Keep the *interface shape* (one
   resolver returning `{baseUrl, token, headers}` for a named path) and stub the provisioning.
2. **Cursor/xAI identity.** `PROVEN` (§7.5): `/auth/poll` + `/oauth/token` + Cursor session tokens +
   MDM sign-in policy + `team_id`. Replace with your own identity; keep the *shape* — an out-of-band
   browser login with a challenge/verifier, opaque refreshable session tokens in OS secure storage,
   and an explicit "secure storage unavailable ⇒ memory-only, do not persist" state.
3. **Statsig / `sand_*` feature gates.** `PROVEN` (§4.7 and `isFeatureGateOn`/`checkFeatureGate`
   throughout). Vendor rollout machinery; substitute your own if you need it.
4. **The pod-proxy VNC stack** (`vnc_url`, `fork_vnc_base_url`, `preload-vnc.cjs`, `sand-webauthn-signer`,
   `sand-op-launcher`). `PROVEN` presence (`FINDINGS.md:25,55-56`); `INFERRED` as out of scope for a
   minimal host.
5. **The four auxiliary gateway paths** (`passkey-provider`, `cookie-provider`, `local-exec-refresh`).
   `PROVEN` (§1.8, §4.1). They exist to serve *browser-automation* and *native-auth* concerns from a
   host process that owns a real browser profile and a real WebAuthn signer. A host that does not
   automate a logged-in browser can drop all three; keep `gateway`.
6. **Deep-link routing.** `PROVEN` (§7.4). `/v1/thread`, `/v1/task`, `/v1/sidebar` are this product's
   URL scheme. Substituting your own is expected; the *pattern* (out-of-band link → app route →
   coordinator RPC) is worth keeping.
7. **`aiserver.v1.*` connectrpc paths.** `PROVEN` (§7.3). Four auxiliary calls; treat as optional.

### 8.3 Minimal viable subset for "desktop + phone both drive agents on a self-hosted host"

The claim to be tested: *the 36 `background` methods plus a small `person` core are enough to run an
unattended agent and answer a phone.* Derived by intersecting the tables in §3 with the mechanisms in
§4–§6. `INFERRED` (this is a design recommendation, not an observation).

**Tier 0 — transport (must have).**
`claim` on a `MessagePort`; a framed session (`lifecycle hello/ready`, `request`, `reply`, `cancel`,
`event`); a version constant; a single-claimant gate. Nothing else. ~5 frame kinds, ~1 table.

**Tier 1 — the unattended core (must have, all `background` or trivially so).**
`listAgents`, `openAgent`, `getAgentTranscript*` (page + window + tail), `getAgentThread`,
`readMainAgentContext`, `getAgentTodos`, `getTrays`, `getAgentAvatar`,
`requestMessagesGrants`/`awaitMessagesGrants`/`cancelMessagesGrants` (or your equivalent event
source), `requestCookieOriginApproval`/`await`/`cancel`, `getHostStatus`, `setWindowFocused`,
`getBoxSecretsStatus`+`setBoxSecrets`/`storeSecret`, `requestWebAuthnCeremony`, `refreshMcp`,
`listBoxMcpServers`, `getMcpState`/`getMcpCatalog`/`listMcpServerTools`, `isEgressTunnelAvailable`,
`getBotTemplateExportPolicy`/`listBotTemplates`, `getAgentNotificationAvatar`,
`readVoiceCallSentMessages`/`nudgeVoiceCall` (only if you ship voice).
That is 30 of the 36; the remaining 6 (`getEffectiveMcpPlugins`, `getMcpPluginLogo`,
`clearGeneratedRoomNameStamps`, `readMainAgentContext` variants, `isGlobalSearchEnabled`) are
host-UI conveniences.

**Tier 2 — the human core (must have, `person`).**
`sendPrompt`, `promptAcceptanceStatus`, `interruptAgentRun`, the resolutions
(`respondToWidget`, `dismissWidget`, `submitUserForm`, `dismissUserForm`, `submitSecret`,
`resolveAutoReviewApproval`, `resolveLocalToolPermission`, `resolveConnectorGrant`,
`resolveVirtualCardApproval`, `resolveMessagesGrants`), `sendDraft`/`discardDraft`,
`reactToMessage`, `voteFeedback`, `dismissTray`/`clearTrays`, `createAgent`, `updateAgent`,
`createGroup`/`setGroupMembers`, `kickstartAgent`, `startFreshConversation`/`rollBackConversation`,
`deleteAgents`, `createAgentWorkflow`/`runAgentWorkflowNow`, `createAgentAutomation`/
`updateAgentAutomation`/`setAgentAutomationEnabled`/`runAgentAutomationNow`,
`getForeverBoxStatus`/`ensureForeverBox`/`handBackForeverBox`, `setAgentUnread`,
`setAgentHiddenFromSidebar`, `setAgentNotifyOnUpdates`, `setAgentDraftingDisabled`,
`getHostSettings`/`setHostSettings`/`updateHostNow`, `startTeachRecording`/`stopTeachRecording`.

**Tier 3 — defer.** Cloud-agent publishing (13 methods), skills publishing (9), template publishing
(7), voice recording (6), attachments upload/read (5), MCP install/auth (10), channels/listener (8),
avatar generation (1). None of these are needed for "drive an agent"; all are needed for the full
product.

**The phone story, concretely.** A phone client that claims the port behaves exactly like the
renderer, with one discipline: **wrapped in `no(...)`** (i.e. `demand:"background"`), so it can poll
the tray and the transcript while the laptop lid is shut without waking anything, and it **omits**
`demand` (or sends `"person"`) only on the calls where a human is actually holding the phone —
`sendPrompt`, the resolutions, `interruptAgentRun`. That is the entire trick, and it is `PROVEN` to be
the vendor's own distinction (§4.5).

### 8.4 Invariants a clean-room host should *enforce* that the vendor only implies

The vendor's model is a policy; a self-hosted host has no trusted vendor process, so the same model
should become checkable. `INFERRED` recommendations:

1. **`background` must be read-only.** The 36-method table (§4.2) has this property empirically. A
   host should assert it — e.g. fail a build if a `background` method's handler performs a mutating
   operation on the agent store.
2. **`background` must never request box wake.** Enforce at the box-intent API, not at each call site.
3. **`person` implies an authenticated principal.** The vendor's `person` only means "a human is
   waiting". Because the port is single-claimant and process-isolated, the vendor gets away with that.
   Any host that exposes the port beyond one local process must bind `demand:"person"` to a principal
   and an expiry, and must not let the caller choose `demand` freely (the vendor does — §4.5).
4. **Resolution requires a fresh grant.** `resolveMessagesGrants {requestId}` and the
   `kU`-shaped resolutions carry a `requestId`; message-grants resolution carries **only** a
   `requestId` (`PROVEN`, §6.1). A host should verify that the `requestId` is a live pending request
   created by *this* host, that it has not been resolved, and that the resolver is entitled to resolve
   it. The vendor's `"expired"` ask status (`JB:4091`) shows expiry is a modelled state to copy.
5. **Cursor invalidation must be authoritative.** `GrokBotTranscriptWatchCursorTooOld` exists; a host
   should return it whenever a cursor cannot be satisfied, rather than silently returning a partial
   window — silently dropping rows is the failure mode that makes transcripts untrustworthy.

### 8.5 What a minimal implementation looks like

```
transport : MessagePort (or WebSocket for non-Electron clients), 5 frame kinds, protocolVersion
table     : { method -> { args: "none"|"object", reply: <container>, class: person|background } }
args      : a Standard-Schema-compatible object validator that STRIPS unknown keys
replies   : per-container structural checks, with a malformed-reply sentinel
state     : agents(id, agent_id, session_id, generation, seq, updated_seq, entry_kind, body|blob_hash)
events    : named families, one allowlist, aliases resolved host-side
approvals : transcript entries of kind send-message, discriminated by message.type,
            resolved by entryId (+ requestId for sticky grants), statuses incl. "expired"
box       : one resolver per path name -> { baseUrl, token, headers? }, plain http allowed
            ONLY for loopback hostnames
policy    : background = no wake, no mutation; person = may wake, may mutate;
            away-park = refuse everything; present-park = refuse background
```

`PROVEN` for every line's *mechanism*; `INFERRED` only in the assembly.

---

## 9. Limitations

### 9.1 What could not be resolved, and why

1. **`assertTrustedRequester` implementation.** `PROVEN` to exist and to be the first statement of the
   `sand:coordinator-port-request` handler (`main-app.beauty.js:85237`); its body was not located in
   the beautified main-app during this pass. `UNKNOWN`: whether it checks
   `senderFrame.url`, `webContents.id` membership, or both. This is the **only** access-control step in
   the discovery path, so it is the most important unresolved item in §1. *Why*: the handler is
   constructed inside a large factory (`main-app.beauty.js` is 2.6 MB and REA's own analysis crashed on
   it — `FINDINGS.md:10`), and the function is passed in as a dependency (`e.assertTrustedRequester`)
   rather than defined nearby.
2. **Whether any backend authorization gates the box token.** `PROVEN` that the box hop carries
   `Authorization: Bearer {gateway_token}` and that the token comes from `EnsureSandBoxResponse`. Not
   established: who may call `EnsureSandBox`, whether the token is scoped to an agent or a session, and
   what the box does with it. `UNKNOWN`. The `rejections`/`refused` vocabulary appears in the
   *application* layer (`GrokBotAgentPublish*`, secret refusals), not in an auth layer we can read.
3. **The full failure-code table.** The coordinator's own codes are enumerated
   (`unknown-method`, `invalid-args`, `cancelled`, `gateway-malformed-reply`, `gateway-command-failed`,
   `gateway-unreachable`, `gateway-transport-failed`). The renderer's `transportKind` vocabulary is
   enumerated (§1.7). What is missing is the mapping from *backend* failure codes to these — the
   renderer's `E3e` switch compares against identifiers (`Ca`, `mh`, `dE`, `mm`, `rT`, `ui`, `Ta`,
   `_g`, `zc`, `hS`, `gS`, `nC`, `Ku`, `A_`, `ph`, `XS`, `$c`, `Wh`) whose string values were not
   resolved. `UNKNOWN`.
4. **The `local-tool-permission` resolution vocabulary (`aa`) and `approvedCommand`'s schema.** Both
   are referenced by schema expressions (`j$ = dt("local tool permission resolution", aa)`,
   `resolution: _e("approval resolution", ba)`, `approvedCommand: A(...)` where the ellipsis is a
   validation-command shape) but the literal arrays were not located. `UNKNOWN`.
5. **The wire value of `entry_kind`.** The client vocabulary `JE` (§5.4) is `PROVEN`; the protobuf
   field is a bare `string` with no enum. Whether the backend accepts exactly `JE` or a superset is
   `UNKNOWN`.
6. **Message-level schemas for the transcript `body`.** `GrokBotTranscriptEntry.body` is `bytes`
   (optionally out-of-line via `blob_hash`). The body's serialization — JSON or protobuf — is
   `UNKNOWN`. The client's rich local predicates (`message.type`, `ask.status`, `approval.surface`,
   `toAgent`, `fromAgent`, `suppressed`, `streaming`, `content`) prove the *deserialized* shape but
   not the encoding. `INFERRED`: JSON, because the local RPC passes the same structures as JSON
   objects and the renderer validates them with plain `typeof` checks — but this is not proven.
7. **The tray entity's fields.** No `*Tray*` protobuf descriptor exists in the 861-message set, and
   the local methods take only `{id}` / noArgs. `UNKNOWN`: what a tray item contains beyond an `id`.
8. **The 861 descriptors are a *compiled* set, not a used set.** `PROVEN` that the coordinator bundle
   contains 861 `aiserver.v1` message classes with decodable descriptors. Not established: which are
   actually constructed at runtime, and whether the full descriptor list corresponds to the current
   backend version. `INFERRED`: at least the transcript, agent, box, plugin and marketplace families
   are live (their field names are consumed by coordinator code, e.g. `F({payload: _.agents})` for
   roster payloads at `JB:39915`).
9. **`Nx`, `$2`, `wk`, `hte`-adjacent constants, and several schema variables.** A handful of
   identifiers are referenced but their declarations were not located within the search budget:
   `Nx` (spread into the out-of-line entry-kind set, `JB:31026`), parts of `$2` (event-family
   aliases, partially recovered), and `aa`. Each is flagged where it appears rather than guessed.
10. **Whether the mobile client actually speaks this protocol.** `PROVEN` that the desktop renderer
    does, and `PROVEN` that 40 of the 172 methods are never referenced by any desktop renderer asset
    (§2.8) — which is *consistent with* another client using them. But no iOS binary was analysed
    (only App Store metadata, `FINDINGS.md:121-128`). So "a phone client drives this surface" is
    `INFERRED` from (a) the class semantics in §4, (b) the unattended-safe design of the ceremony
    trios, and (c) the existence of a separate mobile product — not observed. `UNKNOWN`.

### 9.2 Method limitations

* **No dynamic analysis.** Nothing in this section was obtained by running the app or observing a live
  `MessagePort`. Every claim is static: literals, control flow, schemas, and descriptors read out of
  the shipped bundles. Statements about *timing*, *retry counts observed in the field*, or *actual
  backend behaviour* are therefore out of scope.
* **Minified names.** As stated in the preamble: identifiers are build artifacts. Claims were
  constructed to rest on literals (method names, field names, channel names, env vars, file paths,
  proto type names, numeric constants with unambiguous roles) and on control flow visible in the
  beautified output. Where a conclusion depends on a minified symbol, it is named explicitly so a
  reader can re-verify it against the same build.
* **Line numbers are build-specific.** All `file:line` citations are against the beautified files in
  `recon/beautified/` produced from `recon/grokbot-0.71.2` (v0.71.2, built 2026-10-14). A different
  build will shift them; the *strings* are the durable anchors.
* **Two independent counts reconciled, one not.** The 172-name edge table was independently extracted
  and matched `recon/rea/coordinator-methods.json` exactly, and the 141-name client-surface table was
  extracted twice (once from the coordinator, once from the renderer) and matched exactly, with the
  40-method gap and the 9-method local addition reconciling arithmetically (132 + 40 = 172;
  132 + 9 = 141). By contrast, the **861** protobuf descriptor count comes from a single extractor,
  validated only by (a) every one of the 861 `static $()` sites parsing cleanly and (b) the
  `EnsureSandBoxResponse` cross-check against host code field-for-field. It should be treated as
  high-confidence but singly-sourced.
* **`recon/rea/js-application.json` was not mined for this section.** The 150 MB REA evidence file was
  not needed: every claim here has a direct `file:line` anchor in the beautified bundles, which are
  the same bytes. Where REA's own limitation list matters it is cited from `FINDINGS.md` (limitations
  [7] primitive-string truncation and [12] `main-app.cjs` stack overflow), and limitation [12] is
  plausibly implicated in the one unresolved item above (§9.1.1) — `assertTrustedRequester` lives in
  the file REA could not fully analyse.
