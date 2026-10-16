# Grok Bot — Web Automation & Device Integrations

Reverse-engineering dossier, section 04 of N.
Target: **Grok Bot** desktop, Electron bundle `com.anysphere.sand` v0.71.2 (internal codename **sand**),
built 2026-10-14 by Anysphere / xAI. Backend host literal `api2.cursor.sh`; realtime voice origin `wss://api.x.ai/`.

---

## Scope & method

### What this section covers

This section reconstructs how Grok Bot (the "host") reaches *outside its own process* to do work on the
user's behalf: how it drives a browser, how it carries a signed-in session into that browser, how its
network egress is shaped, how it renders agent-produced artifacts, how it hosts third-party MCP servers
and MCP Apps, how it runs live voice calls, how it binds to external messaging platforms, how it presents
a remote desktop over VNC, and how it moves attachments and media.

### Evidence base

| Artifact | Size | Role in this section |
|---|---|---|
| `recon/FINDINGS.md` | 128 lines | Prior verified facts (CSP, protocols, IPC names, method inventory) |
| `recon/rea/coordinator-methods.json` / `.txt` | 172 methods | RPC inventory with authorization class (`background` / `person`) |
| `recon/beautified/main-core.beauty.js` | 1.19 MB, 41,314 lines | Protocol registration, protocol handlers, webview hardening, proxying |
| `recon/beautified/main-app.beauty.js` | 3.67 MB, ~110k lines | Desktop wiring, box/VNC, MCP manager, connector registry, canvas, computer-use |
| `recon/beautified/coordinator.beauty.js` | 1.23 MB | Coordinator RPC schemas, protobuf descriptors, voice/MCP/channel/secret handlers |
| `recon/beautified/preload.beauty.js` | 140 KB | `contextBridge` surface, coordinator port claim, env exposure |
| `recon/beautified/preload-webview.beauty.js` | 8.7 KB, 338 lines | The browser-webview preload (read in full) |
| `recon/beautified/preload-vnc.beauty.js` | 56 KB, ~1,850 lines | The noVNC preload / remote-desktop bridge |
| `recon/beautified/exec-daemon.beauty.js` | 5.0 MB | `computer_use_*` tool surface, local-exec settings, protobuf messages |
| `recon/grokbot-0.71.2/dist/renderer/assets/` | 588 files | Renderer feature chunks (filename inventory = feature inventory) |
| `recon/grokbot-0.71.2/dist/renderer/index.html` | — | Renderer CSP and module graph |
| `/Applications/Grok Bot.app/Contents/Info.plist` | — | App Transport Security, usage descriptions |
| `recon/rea/projection-boundaries.json` | 289 KB | Electron boundary observations (contextBridge, BrowserWindow, worker) |

### Method

1. Read `FINDINGS.md` first and treat its claims as *hypotheses to re-verify*, not as ground truth.
2. Locate each subsystem by searching the beautified bundles for the exact string literals named in the
   task brief, then read a contiguous window around each hit (`sed -n 'A,Bp'`) rather than sampling.
3. For every non-obvious claim, cite `file:line`. Line numbers refer to the **beautified** files under
   `recon/beautified/` (prettier-expanded), not to the shipped minified bundles. The shipped files are
   `recon/grokbot-0.71.2/dist/**` and their line numbers differ completely — never mix the two.
4. Prefer exact minified literals as evidence. Where a symbol name is single- or double-letter, it is a
   **minifier artifact** and carries no semantic meaning; only string literals, numeric constants and
   protobuf field descriptors survive minification and are therefore trustworthy.
5. Tag each claim:
   - **PROVEN** — the cited bytes say it.
   - **INFERRED** — reasoned from cited bytes, with the reasoning stated.
   - **UNKNOWN** — not established by available evidence.

### Standing caveats (apply to every claim below)

| # | Caveat |
|---|---|
| C1 | All bundles are **minified**; prettier restored formatting only. Identifier names (`zl`, `gc`, `Rw`, `No`, `JAt`) are meaningless. Only quoted strings, regexes, numeric constants and protobuf field strings are evidence. |
| C2 | This is **static** analysis. A string's presence in a bundle proves the string exists at that offset; it does **not** prove the code path executes at runtime, nor that the feature is enabled for any given user. Feature gates (`sand_mcp_apps`, `sand_box_egress_tunnel`, …) sit in front of several subsystems and default to *off* in at least one case. |
| C3 | `recon/rea/js-application.json` analysis **crashed** on `dist/electron-main/main-app.cjs` ("Maximum call stack size exceeded", `recon/rea/projection-summary.json` line 76). REA's coverage is declared **partial**; absence in REA is not absence in the product. |
| C4 | No source maps ship with the app (`FINDINGS.md:43`), so no original TypeScript names, file paths or type annotations can be recovered. |
| C5 | `main-app.beauty.js` is the *bundled* form of a `workspace:*` monorepo module graph. Module boundaries visible in source (e.g. `@sand/desktop-edge`) have been flattened; the only surviving hints are Sentry `debugId` strings and chunk filenames. |

---

## Executive summary — the five architectural facts

1. **There is no Playwright/Puppeteer/CDP browser-automation stack.** The one DevTools-Protocol-shaped
   code path in the app drives **Node's own inspector** (`import("node:inspector")`,
   `main-core.beauty.js:36406`), i.e. it debugs *Grok Bot's own worker processes*, not a browser.
   The actual browser surface is an in-app Electron **`<webview>`** (`webviewTag: !0`,
   `main-core.beauty.js:28649`) plus a **remote VM desktop rendered as images over noVNC** plus a
   **macOS-native computer-use tool surface** (`computer_use_screenshot`, `computer_use_click`, …,
   `exec-daemon.beauty.js:104059-104095`). See §1.
2. **"Log in once" is implemented as a credential *vault* plus *target-rule* matching plus
   *just-in-time, per-origin, human-approved injection* — not as a single stored password.** The pieces
   are `GrokBotVaultCredential` (with `GrokBotVaultCard`, `GrokBotVaultContact` variants), a
   `CredentialTargetRule{kind: EXACT_HOST_PORT | REGISTRABLE_DOMAIN}`, a 1Password broker reached over a
   signed native launcher, an iCloud-Keychain-style passkey ceremony backed by the
   `sand-webauthn-signer` binary, and `resolveVirtualCardApproval` for agent-initiated spend. See §2.
3. **Egress is deliberately re-shaped, not merely allowed.** A "system proxy" resolver mirrors the OS
   proxy into children via `SAND_NODE_PROXY_ENV`; a per-box **egress tunnel** exists on ports 8790/8791
   and can be claimed/toggled; the box's own traffic is routed through a host gateway on 1340; and
   macOS ATS is set to `NSAllowsArbitraryLoads = true` with explicit loopback exceptions. See §3.
4. **The agent's "artifacts" are a first-class, scheme-addressed, individually-CSP'd document type.**
   `sand-canvas://frame/<id>` with a strict URL grammar, `/user/<id>` and `/store/<storeId>/<id>`
   locators, a 32 MiB LRU content cache, and an iframe sandbox of exactly
   `allow-scripts allow-popups allow-popups-to-escape-sandbox`. MCP Apps get a *different* scheme with a
   generated per-document CSP and two injected `postMessage` bridge scripts. See §4 and §5.
5. **A "voice call" is not a text thread with audio bolted on.** It is a realtime WebSocket session
   against `wss://api.x.ai/` with an ephemeral `client_secret`, a server-supplied tool list, a
   server-supplied greeting, and a *harness* that is either compiled-in (`package`) or backend-mediated
   (`backend`) — and it is **recorded** into a structured turn/nudge/event/tool-call transcript that is
   committed back to the agent's thread. See §6.

---

# 1. Browser automation architecture

## 1.1 The headline: which technology is it *not*

The brief asked whether the agent drives an in-app `<webview>`/`BrowserView`, a separate Chromium over
CDP, a cloud browser, or Playwright/Puppeteer/CDP. The evidence answers this cleanly and it is **none of
the CDP/BrowserView options**.

| Candidate | Evidence | Verdict |
|---|---|---|
| Separate Chromium over CDP | No `webSocketDebuggerUrl`, no `Target.getTargets`, no `Page.navigate`, no `remote-debugging-port` anywhere in `main-app`, `main-core` or `coordinator` (grep over all three: 0 hits each) | **Ruled out** — PROVEN by absence in the searched bundles |
| Playwright / Puppeteer | `puppeteer`: 0 hits. `playwright`: 8 hits in `main-app.beauty.js`, all in unrelated contexts; the only substantive one is the feature-flag declaration `playwright_mcp_provider: { client: !0, default: !0 }` at `main-app.beauty.js:48807` | **Ruled out as the automation driver.** The flag name suggests an MCP server *for* Playwright may be offered as a provider, but no Playwright client code is present in these bundles (INFERRED) |
| `BrowserView` | The string `browser_view` appears at `main-core.beauty.js:14847` inside `Qh = ["background_page","browser_view","remote","webview","offscreen","unknown"]` — a Chromium **process/surface type enum** used for crash classification (the neighbouring arrays are `["crashed","oom",…]` and `["gpu","zygote","sandbox_helper",…]`), not an API call site | **Not used as an API** — PROVEN for the enum context |
| In-app `<webview>` | `webviewTag: !0` at `main-core.beauty.js:28649`; `will-attach-webview` hardening at `main-app.beauty.js:108052`; `preload-webview.cjs` referenced at `main-app.beauty.js:107943`; renderer emits `<webview>` JSX in `chunk-teach-recording-controls-CQ4-Ikje.js` | **PROVEN** |
| Cloud browser | No such client in the bundles. What *is* present is a cloud **VM desktop** ("the box") viewed over noVNC (§8) and a cloud-agent concept (`getCloudAgentInfo`, `getCloudAgentPublishProposals`) that is about deploying agent *apps*, not about driving a browser | **Ruled out as a browser-in-the-cloud product** (INFERRED) |
| CDP-shaped debugging | `Debugger.enable`, `Debugger.resume`, `Debugger.setPauseOnExceptions`, `Runtime.getProperties`, `Debugger.paused`, `Debugger.scriptParsed` all present — but the session object is constructed from **`await import("node:inspector")`** and `new n.Session()` at `main-core.beauty.js:36406-36408` | **This is Node.js Inspector, not CDP-against-Chrome.** PROVEN |

> **Correction to `recon/FINDINGS.md:111`.** That line lists `Debugger.enable` / `Debugger.setPauseOnExceptions`
> under "Binary distribution (dotslash)" as if they were browser-automation CDP. They are not. The class
> that owns them is a `node:inspector` wrapper:

```js
// recon/beautified/main-core.beauty.js:36399-36421  (identifiers are minified)
var NI = class e {
    constructor(t) { this._session = t; }
    static async create(t) {
      if (t) return t;
      let n = await import("node:inspector");
      return new e(new n.Session());
    }
    configureAndConnect(t, n) {
      (this._session.connect(),
        this._session.on("Debugger.paused", (r) => {
          t(r, () => { this._session.post("Debugger.resume"); });
        }),
        this._session.post("Debugger.enable"),
        this._session.post("Debugger.setPauseOnExceptions", { state: n ? "all" : "uncaught" }));
    }
```

The adjacent helper names make the purpose explicit: `getLocalVariables`, `_getProperties` →
`Runtime.getProperties`, `_unrollArray`, `_unrollObject`, and the log line
`"Pausing debugger to capture stack trace"` (`main-core.beauty.js:38433`). This is a **stack-trace capture
mechanism for Grok Bot's own JS workers** (`getLocalVariables` feeds an error report), which lines up with
the `processEvent(a, i)` / "Failed to start worker" / "Failed to start inspector" strings immediately
above it at `main-core.beauty.js:36360-36370`. **INFERRED**, with the `node:inspector` import as the
decisive PROVEN fact.

## 1.2 The browser is an Electron `<webview>` with a hardened attach path

The main window is created with the `webviewTag` switch on and a locked-down preference set:

```js
// recon/beautified/main-core.beauty.js:28630-28651, abridged
u = new ar.BrowserWindow({
      ...l.windowOptions,
      title: ar.app.getName(),
      webPreferences: {
        additionalArguments: [...d.additionalArguments],
        contextIsolation: !0,
        nodeIntegration: !1,
        preload: Ng.default.join(JA, Ig({ isPackaged: ar.app.isPackaged, devCapability: n })),
        sandbox: !0,
        v8CacheOptions: m1(o),
        webviewTag: !0,
      },
    });
```

| Fact | Evidence | Tag |
|---|---|---|
| `webviewTag` enabled on the main window | `main-core.beauty.js:28649` | PROVEN |
| `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on the **host** window | `main-core.beauty.js:28644-28648` | PROVEN |
| Preload directory is `dist/electron-preload`, preload file is `preload.cjs` | `main-core.beauty.js:28604` (`JA = path.join(__dirname, "..", "electron-preload")`), `dist/electron-preload/` listing | PROVEN |
| Main-window document is `renderer/index.html` | `main-core.beauty.js:28605` (`E1 = path.join(__dirname, "../renderer/index.html")`) | PROVEN |

Every `<webview>` the renderer attaches is then forced into a known-good configuration by
`hardenWebviewAttach`, which is a single `will-attach-webview` handler:

```js
// recon/beautified/main-app.beauty.js:108052-108066, abridged
function D(P) {
    P.on("will-attach-webview", (U, G, z) => {
      ((G.nodeIntegration = !1), (G.contextIsolation = !0), (G.sandbox = !0));
      let ee = z.partition === iz;                       // iz = "persist:sand-forever-box"
      if (((G.preload = ee ? r : n), ee && typeof z.src == "string")) {
        let q = URL.parse(z.src)?.origin;
        (q != null && o.add(q), c(z.src), E(z.src));
      }
      if (typeof z.src == "string") {
        let q = URL.parse(z.src);
        (q == null || (q.protocol !== "http:" && q.protocol !== "https:" && q.protocol !== "about:")) && delete z.src;
      }
    });
  }
```

with `n` and `r` bound at the top of the same factory:

```js
// recon/beautified/main-app.beauty.js:107941-107944
function JAt(e) {
  let t = e.electron ?? { app: rf.app, clipboard: rf.clipboard, ipcMain: rf.ipcMain, session: rf.session },
    n = mue.default.join(e.preloadDistDir, "preload-webview.cjs"),
    r = mue.default.join(e.preloadDistDir, "preload-vnc.cjs"),
```

| Fact | Evidence | Tag |
|---|---|---|
| Two preloads exist for webviews: `preload-webview.cjs` (normal browsing) and `preload-vnc.cjs` (the box desktop) | `main-app.beauty.js:107943-107944` | PROVEN |
| The choice is made **by session partition**, not by URL or by a renderer-supplied flag | `main-app.beauty.js:108055` (`z.partition === iz`) | PROVEN |
| The privileged partition name is `persist:sand-forever-box` | `main-app.beauty.js:107925` | PROVEN |
| Attach-time hardening overrides whatever the renderer requested for `nodeIntegration` / `contextIsolation` / `sandbox` | `main-app.beauty.js:108053` | PROVEN |
| Non-`http:`/`https:`/`about:` sources are **deleted** (the webview gets no src at all) | `main-app.beauty.js:108062-108064` | PROVEN |
| The trusted partition session gets zoom pinned to 1 and host-input routing | `main-app.beauty.js:108022-108029` | PROVEN |

There is also a *trust* predicate that gates a privileged IPC edge on the webview:

```js
// recon/beautified/main-app.beauty.js:107905-107911
function $At(e) {
  return {
    boxDesktopWebview: {
      kind: "require",
      test: (t) => t.isBoxVncPartition && t.frameUrl != null && t.frameUrl.length > 0 && e(t.frameUrl),
      denial: "The box-VNC edge is only accessible from the trusted box-desktop webview.",
    },
  };
}
```

| Fact | Evidence | Tag |
|---|---|---|
| A `box-vnc` RPC namespace exposes exactly two methods: `readClipboard` (no args) and `writeClipboard({text})` | `main-app.beauty.js:107899-107901` | PROVEN |
| Access requires the sender's session to *be* the `persist:sand-forever-box` partition **and** the sender frame URL to pass a second predicate | `main-app.beauty.js:107906-107908` | PROVEN |
| Denial is reported as `reportDesktopEdgeFailureClass("box-vnc", "trust-denial", …)` keyed `${trust}:${method}` | `main-app.beauty.js:107919-107932`, `108079-108081` | PROVEN |
| The backend side of that RPC just calls Electron's `clipboard.readText()` / `clipboard.writeText()` | `main-app.beauty.js:108074-108078` | PROVEN |

**INFERRED:** the design intent is that the renderer is *not* trusted to name its own privileges — the main
process re-derives identity from `sender.session` and `senderFrame.url`, which is the correct pattern. The
second predicate (`e(t.frameUrl)`, closure argument `T`) additionally requires the frame URL to be a VNC
page and either a loopback hostname or an origin previously seen on the privileged partition:

```js
// recon/beautified/main-app.beauty.js:108033-108036
function T(P) {
    let U = URL.parse(P);
    return U == null || !sx(U) ? !1 : (0, WAt.isLoopbackHostname)(U.hostname) || o.has(U.origin);
  }
```

## 1.3 The renderer-side browser preload, in full

`preload-webview.cjs` is small enough to characterise completely (338 beautified lines, 8.7 KB). It
installs exactly five behaviours and exposes **no** `contextBridge` API at all — it is a pure agent, not a
capability surface. That is itself a design signal: **the browsed page gets nothing; the host gets
signals.**

| # | Behaviour | Literals | Line |
|---|---|---|---|
| 1 | Middle-click / back-forward navigation interception | channel `"sand:mouse-history-navigation"`, maps button `3 → -1`, `4 → +1`, requires `isTrusted !== false` | `preload-webview.beauty.js:107-136` |
| 2 | `navigator.permissions.query` polyfill returning `state: "granted"` for `local-network-access` / `local-network` — installed **only** on an IdP hostname allowlist | see table below | `preload-webview.beauty.js:187-216` |
| 3 | WebAuthn stall detection wrapping `navigator.credentials.create` / `.get` | policy name `"sand-webview-passkey-stall"`, `timeoutMs: 6e4`, channel `"sand:browser-passkey-stalled"`, error `DOMException("Passkey request stalled","NotAllowedError")` | `preload-webview.beauty.js:225-265` |
| 4 | Dialog stubbing: `window.alert = ()=>{}`, `window.confirm = ()=>true`, `window.prompt = ()=>null` | guarded by `window.__sandDialogOverridesApplied` | `preload-webview.beauty.js:266-277` |
| 5 | Lifecycle reporting to the host | channels `"sand:browser-popup-closed"` (`{url}`) and `"sand:browser-origin-return"` (`{origin, currentUrl}`) | `preload-webview.beauty.js:278-301` |

The IdP allowlist for behaviour 2 is a hard-coded array of corporate-identity providers:

```js
// recon/beautified/preload-webview.beauty.js:151-161
var P = [
  ".okta.com",
  ".okta-emea.com",
  ".oktapreview.com",
  ".duosecurity.com",
  ".login.microsoftonline.com",
  ".onelogin.com",
  ".auth0.com",
  ".pingidentity.com",
  ".rippling.com",
];
```

and it is consumed by a **suffix** match (`e.endsWith(P[r])`, line 184), not an origin or hostname match.

| Claim | Tag | Reasoning |
|---|---|---|
| On Okta/Duo/Entra/OneLogin/Auth0/PingIdentity/Rippling pages, the browsed site is told the `local-network-access` permission is `granted` even though no such grant was requested from the user | PROVEN | The polyfill at lines 190-212 returns a synthetic `EventTarget` with `state: { value: "granted" }` for those two descriptors, and it is only invoked when `$(location.hostname)` passes |
| This is a workaround for SSO flows that probe for local-network access (e.g. device-trust / conditional-access agents), not a general bypass | INFERRED | The allowlist is exclusively SSO/IdP vendors plus Rippling (an HR/IT platform with SSO); no other host is affected |
| Scope of the bypass is narrow and bounded | PROVEN | It only overrides `permissions.query` for two descriptor names, preserves the original for everything else (`return originalQuery(descriptor)`), and marks itself with `permissions.__sandLocalNetworkPolyfill` to avoid double-application |
| **Security implication:** a page on any of those nine domains can falsely believe it holds a local-network grant | INFERRED | Permissions API consumers cannot distinguish the synthetic status object from a real one; `status` is a plain `EventTarget` with fixed descriptors and no `onchange` firing |

**Behaviour 3** is worth restating precisely, because it is the browser-side half of the passkey story
in §2. The wrapper does not *implement* WebAuthn — it *times out* WebAuthn and reports the stall:

```js
// recon/beautified/preload-webview.beauty.js:236-250, abridged
return x({
      policy: Y,                                   // v({name:"sand-webview-passkey-stall", timeoutMs: 6e4})
      method: r,                                   // "create" | "get"
      since: c,
      call: n,
      reportStall: (a) => {
        try { e.sendToHost("sand:browser-passkey-stalled", a); }
        catch (y) { l("passkey stall send failed", s(y)); }
      },
      buildStallError: B,                          // DOMException("Passkey request stalled","NotAllowedError")
    });
```

`x()` (`preload-webview.beauty.js:138-144`) rethrows a `DeadlineExceededError` (`code: "deadline_exceeded"`,
`name: "DeadlineExceededError"`, `policyName`) after firing `reportStall`. **INFERRED:** the host is
expected to react to `sand:browser-passkey-stalled` by triggering the remote-signer path (§2.4), and the
page receives a standard `NotAllowedError` so it falls back gracefully.

**Behaviour 1** is notable for *what it refuses*: `isTrusted === !1` events are ignored
(`preload-webview.beauty.js:118`), so a page cannot synthesise a back-navigation by dispatching a fake
`mousedown`. The host still re-validates the channel target — `main-app.beauty.js:68429` and
`main-app.beauty.js:68385` re-check `getType() === "webview"` before acting.

## 1.4 What the renderer renders

The renderer's own chunk inventory is strong evidence for where a `<webview>` appears. Only two of the
588 files in `recon/grokbot-0.71.2/dist/renderer/assets/` contain the token `webview` at all:

| File | What it contains | Tag |
|---|---|---|
| `index.eager-app-DSuGVQNC.js` | `upe = "webview, iframe"` — a **CSS selector list** used by a copy/selection helper, alongside `lpe = ".sand-message-prose, .sand-message-content"` and `cpe = 'input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'` | PROVEN |
| `chunk-teach-recording-controls-CQ4-Ikje.js` | Real `jsx("webview", { ... })` element construction with props `ref`, `src`, `tabIndex`, `webpreferences`, plus a memo helper `ss(n){const e=Ue(n.src,n.isInteractive,!1); return e===n.url?n:{…}}` | PROVEN |

**INFERRED:** the sole user-visible `<webview>` in the renderer is the **teach-recording / replay surface**
(the "ask an agent to follow along as you complete a workflow once" feature, `FINDINGS.md:125`), plus the
box-desktop modal (`chunk-box-desktop-modal--0USskmH.js`, §8) which renders the noVNC page. The agent's
own browsing is not rendered as a `<webview>` in the main window at all.

## 1.5 Where the *agent's* browsing actually happens

Three distinct mechanisms exist, and they are not interchangeable:

| Mechanism | Where it runs | Tool surface | Evidence |
|---|---|---|---|
| **A. Box desktop (remote VM)** | A cloud/VM "box" (`/home/box`, `/home/box/agent-data`, `sand-data` — `FINDINGS.md:110`), displayed locally as noVNC **images** inside a `<webview>` on partition `persist:sand-forever-box` | VNC input injection + clipboard edge | §1.2, §8 |
| **B. Host computer use (macOS)** | The **user's own Mac** | `computer_use_screenshot`, `computer_use_click`, `computer_use_scroll`, `computer_use_mouse_move`, `computer_use_mouse_button`, `computer_use_drag`, `computer_use_typing`, `computer_use_press_key`, `computer_use_check_permissions` | `exec-daemon.beauty.js:104059-104095` |
| **C. In-app webview browsing** | The user's Mac, inside Grok Bot | host-side signals only (`preload-webview.cjs`) | §1.3 |

### Mechanism B in detail — this is the closest thing to "browser automation"

The exec daemon carries a protobuf message pair `computer_use_args` / `computer_use_result`, registered as
a named handler with the service token `"computer-use-executor"`:

```js
// recon/beautified/exec-daemon.beauty.js:84450-84452
  computerUseExecutor: "computer-use-executor",
// recon/beautified/exec-daemon.beauty.js:84596-84601
  st.computerUseExecutor,
  (t) => new lt(t, dt("computerUseArgs"), ft("computerUseResult")),
  …
    e.register(new ut(t, mt("computerUseArgs"), pt("computerUseResult")));
```

The wire messages are declared in the shared `ExecServerMessage` / `ExecClientMessage` descriptor strings:

```text
// recon/beautified/exec-daemon.beauty.js:83179  (ExecServerMessage, abridged)
…|21 record_screen_args #14 message|22 computer_use_args #15 message|23 write_shell_stdin_args #16 message|…
…|40 canvas_diagnostics_args #23 message|41 shell_allowlist_precheck_args #24 message|…
…|43 web_fetch_allowlist_precheck_args #26 message|…
// recon/beautified/exec-daemon.beauty.js:83244  (ExecClientMessage, abridged)
…|21 record_screen_result #16 message|22 computer_use_result #17 message|…
…|40 canvas_diagnostics_result #25 message|…|43 web_fetch_allowlist_precheck_result #28 message|…
```

The client-side wrapper is a literal tool vocabulary:

```js
// recon/beautified/exec-daemon.beauty.js:104059-104095, abridged
    return this.callTool(e, "computer_use_screenshot", {});
    return this.callTool(e, "computer_use_click", { … });
    return this.callTool(e, "computer_use_scroll", { … });
    return this.callTool(e, "computer_use_mouse_move", { x: r.x, y: r.y });
    return this.callTool(e, "computer_use_mouse_button", { button: r.button, action: r.action });
    return this.callTool(e, "computer_use_drag", { button: r.button, path: r.path, modifier_keys: r.modifierKeys });
    return this.callTool(e, "computer_use_typing", { value: r });
    return this.callTool(e, "computer_use_press_key", { key: r.key, hold_duration_ms: r.holdDurationMs });
    return this.callTool(e, "computer_use_check_permissions", {});
```

| Fact | Evidence | Tag |
|---|---|---|
| The tool names are `computer_use_<verb>` with snake_case arguments (`modifier_keys`, `hold_duration_ms`) | `exec-daemon.beauty.js:104059-104095` | PROVEN |
| `record_screen` is a **separate** tool from `computer_use` | The single descriptor line `exec-daemon.beauty.js:83179` declares `…\|20 fetch_args #13 message\|21 record_screen_args #14 message\|22 computer_use_args #15 message\|…\|40 canvas_diagnostics_args #23 message…` — distinct field numbers, distinct messages | PROVEN |
| There is a "Computer" **tool** exposed to the model **and** a `computerUse` **subagent** | `exec-daemon.beauty.js:84136` — *"Computer use is not enabled for this environment, so the Computer tool and the computerUse subagent cannot run here. Do not retry computer actions; verify with non-GUI methods (automated tests, shell commands) instead. (No computer-use handler is registered on this exec daemon.)"* | PROVEN |
| Computer use is gated per environment | same string; plus `computer_use_supported 8?` in the `RequestContextEnv` descriptor at `exec-daemon.beauty.js:76827` | PROVEN |
| Screen recording / input is **lease**-based | metric `computer_use.desktop_lease.check` at `exec-daemon.beauty.js:103721` | PROVEN |
| Sessions are metered | metrics `computer_use.session.duration_ms`, `computer_use.session.action_count`, `computer_use.session.result`, `computer_use.session.action_kind` at `exec-daemon.beauty.js:103708-103721` | PROVEN |
| The model used for computer use is a **separate configurable setting** | `computerUseModel` at `exec-daemon.beauty.js:69540`, `69644` (`computerUseModel: ETe.optional().catch(void 0)`), `70056-70065` (getter/setter) and `coordinator.beauty.js:33990` (`computerUseModel: A(at(V$))`) | PROVEN |

### macOS permission model for computer use

```js
// recon/beautified/main-app.beauty.js:93357
  Omn = ["accessibility", "screenRecording"],
// recon/beautified/main-app.beauty.js:93363-93367
    accessibility:   "accessibilityTrusted"    in e && e.accessibilityTrusted    === !0,
    screenRecording: "screenRecordingGranted"  in e && e.screenRecordingGranted  === !0,
// recon/beautified/main-app.beauty.js:93388
  return e.accessibility && e.screenRecording;
```

and the renderer's computer-use provider chunk exposes both the grant state and a **per-application
allowlist**:

```js
// recon/grokbot-0.71.2/dist/renderer/assets/chunk-provider-computer-use-BvPQzCAR.js (whole file, 1,303 bytes)
const t = o("computer-use-permissions",  { id: "mmzR7e" }),
      i = o("computer-use-allowed-apps", { id: "cLfYxG" });
… e().computerUsePermissions.grants / .helperName / .watch / .refresh / .openSettings
… e().localToolPermission.allowedApps / .retryAllowedApps / .revokeAllowedApp
```

| Fact | Evidence | Tag |
|---|---|---|
| Computer use requires **both** Accessibility and Screen Recording TCC grants | `main-app.beauty.js:93357`, `93388` | PROVEN |
| There is a native helper process for computer use (`helperName`) and a `macAccount` identity attached to it | `chunk-provider-computer-use-BvPQzCAR.js`; `main-app.beauty.js:93431` (`macAccount: (await o) ?? "unknown"`) | PROVEN |
| The user can allowlist / revoke **individual applications** for computer use | `chunk-provider-computer-use-BvPQzCAR.js` (`computer-use-allowed-apps`, `revokeAllowedApp`) and `main-app.beauty.js:40623` (`allowedApps: rpcOptional(rpcArray(rpcString()))`) | PROVEN |
| Settings can be opened programmatically from the UI (`openSettings`) | `chunk-provider-computer-use-BvPQzCAR.js` | PROVEN |
| **Security implication:** an agent with these two grants plus a non-empty allowlist has full synthetic-input and screen-read capability over those applications, and the only in-band approval is the local-tool-permission card (`GrokBotLocalToolPermissionCardResolution` = `ALLOW_ONCE | DENY | ALWAYS | NEVER`) | PROVEN for the enum (`coordinator.beauty.js` enum table); INFERRED for the mapping to computer use |

### Screenshot/streaming plumbing for computer use

The renderer ships a dedicated preview chunk and a wallpaper asset:

| File | Note |
|---|---|
| `chunk-computer-screen-preview-LY_WYUeq.js` (26,139 bytes) | The live screen preview UI |
| `demo-computer-wallpaper-BO7Ye4dV.jpg` | A demo wallpaper shown when the live stream is unavailable (INFERRED) |
| `computer-screen-websocket` | A **named network-diagnostic probe** (`main-app.beauty.js:99048`) that resolves to `p.vncProxy?.primaryUrl` and opens a `"websocket"` connection, reporting `screen-websocket-unavailable` / `screen-websocket-connected` (`main-app.beauty.js:99342-99347`) |

The diagnostic branch is worth quoting because it names the transport:

```js
// recon/beautified/main-app.beauty.js:99342-99348
            case "computer-screen-websocket":
              return D("websocket", async (P, U) => {
                let G = P.vncProxy?.primaryUrl;
                return G == null
                  ? { detail: "screen-websocket-unavailable", warning: !0 }
                  : (await o(FMn(G), U), { detail: "screen-websocket-connected" });
              });
```

**INFERRED:** `vncProxy.primaryUrl` is the box-side websockify endpoint that fronts both the noVNC viewer
and the computer-screen preview, so the on-screen image the user sees for a *box* session and the frames a
computer-use model consumes may share one transport. This is consistent with the port table in §8
(`primaryNovncWebsockify: 6080`, `forkNovncWebsockify: 6081`).

## 1.6 Target discovery and page/session model

Because there is no CDP, "target discovery" is not a protocol concept here. What replaces it:

| Concept | Implementation | Evidence |
|---|---|---|
| **Target** | A `<webview>` element, identified by its Electron session partition and its frame URL — the host asks `P.sender.session === t.session.fromPartition(iz)` and `P.senderFrame?.url` | `main-app.beauty.js:107906-107908`, `108071-108073` |
| **Session** | An Electron `Session` obtained by `session.fromPartition("persist:sand-forever-box")` | `main-app.beauty.js:107925`, `108026`, `108038` |
| **Session hardening** | `setVisualZoomLevelLimits(1, 1)`, `setZoomFactor(1)` on `dom-ready` and `did-finish-load` | `main-app.beauty.js:108020-108029` |
| **Navigation observation** | `webRequest.onBeforeSendHeaders` + `webRequest.onCompleted` on the box partition | `main-app.beauty.js:108039-108047` |
| **Input routing** | `before-input-event` → `e.routeHostInput(z)` → `G.preventDefault()` (host chords are consumed before the page sees them) | `main-app.beauty.js:108026-108028` |
| **Page lifecycle** | Renderer-side `noVNC_connected` / `noVNC_reconnecting` / `noVNC_connecting` / `noVNC_disconnecting` class mutation observation, reported as `{phase, clean}` (§8.3) | `preload-vnc.beauty.js:1697-1730` |

**PROVEN** for all five rows. The notable architectural consequence is that **there is no page-object model,
no DOM query channel, and no JS-evaluation channel for the agent's browsed page** in these bundles. The
agent interacts through synthetic input (computer use) and screen images, not through
`Runtime.evaluate`. Any claim that Grok Bot "uses CDP to script pages" is unsupported by this evidence.

### What *does* evaluate JavaScript in a page

Two call sites of `executeJavaScript` exist on webview-like frames, and both are narrow:

| Call site | Purpose | Evidence |
|---|---|---|
| `preload-webview.beauty.js:190` | Install the `local-network-access` permissions polyfill (§1.3) | PROVEN |
| `preload-vnc.beauty.js:1741-1745` | `gr()` — "vnc frame hold", injects a script that freezes/defers rendering while the viewer is hidden or the box is dormant | PROVEN |

Additionally `main-core.beauty.js` exposes a helper `function kg(e, t = ue)` that produces an `admit(r)`
gate for `openExternal`-style navigations, requiring (a) a focused frame whose URL passes `QT` (i.e. is
`sand-canvas:`), (b) a recent trusted mouse-up or key-down within `Hie = 1e3` ms, and (c) the candidate URL
to use a scheme in `jie = new Set(["http:","https:","mailto:","tel:"])`:

```js
// recon/beautified/main-core.beauty.js:28653-28678, abridged
var Hie = 1e3,
  jie = new Set(["http:", "https:", "mailto:", "tel:"]);
function kg(e, t = ue) {
  let n;
  return (
    e.on("before-mouse-event", (r, o) => { o.type === "mouseUp" && (n = t.monotonicNow()); }),
    e.on("before-input-event", (r, o) => {
      o.type !== "keyDown" || o.isAutoRepeat || o.key === "Escape" || (n = t.monotonicNow());
    }),
    { admit(r) {
        let o = e.focusedFrame;
        if (o === null || !QT(o.url)) return !1;
        let a = n;
        if (((n = void 0), a === void 0 || yn(a, t.monotonicNow()) > Hie)) return !1;
        let i = URL.parse(r)?.protocol;
        return i !== void 0 && jie.has(i);
      } }
  );
}
```

| Claim | Tag | Reasoning |
|---|---|---|
| Canvas frames may open external links only after a **genuine, recent user gesture** (≤1 s) and only to `http`/`https`/`mailto`/`tel` | PROVEN | The literal constants and the `admit` logic above; this is the `attachSandCanvasLinkGate` exported at `main-core.beauty.js:39432` and installed at `main-app.beauty.js:108501` |
| This is a **clickjacking / drive-by-navigation defence for agent-generated HTML** | INFERRED | The gate applies specifically to `sand-canvas:` focused frames (`QT`), which is where agent-authored content lives |
