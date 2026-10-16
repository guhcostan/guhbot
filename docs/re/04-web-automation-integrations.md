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

---

# 2. Session & identity injection — how "log in once" actually works

## 2.1 The model in one paragraph

Grok Bot does **not** hold one password per site. It holds a **vault** of credential items, each carrying
a set of **target rules** that describe which network destinations the item may be used for, and it injects
material into a browsing context only after a **per-origin, human-visible approval** for the specific
`(origin, profileId)` pair. Three credential *classes* exist (login / card / contact), three *sources* exist
(device Chrome cookies, the 1Password app, and Grok Bot's own passkey enrollment), and every injection is
recorded as a distinct authorization step. Agent-initiated **spend** is a fourth, separate ceremony.

## 2.2 The vault data model

Recovered protobuf descriptors (all in `recon/beautified/coordinator.beauty.js`; format is
`MessageName|fieldNumber fieldName typeCode`):

```text
GrokBotVaultCredential|1 id 9|2 title 9|3 username 9|4 notes 9|5 sites 9*|6 created_at_ms 3|7 updated_at_ms 3|8 card #0?|9 kind #1|10 contact #2?
GrokBotVaultCard|1 brand 9|2 last4 9|3 exp_month 5|4 exp_year 5|5 holder_name 9|6 billing_address #0?
GrokBotVaultCardBillingAddress|1 line1 9|2 line2 9|3 city 9|4 region 9|5 postal_code 9|6 country 9|7 name 9|8 phone 9
GrokBotVaultContact|1 address #0|2 default_shipping 8|3 email 9
GrokBotVaultItemKind  :: UNSPECIFIED, LOGIN, CARD, CONTACT
```

| Fact | Evidence | Tag |
|---|---|---|
| The vault stores three item kinds: `LOGIN`, `CARD`, `CONTACT` | enum `GrokBotVaultItemKind` (`coordinator.beauty.js` enum table; see Appendix A) | PROVEN |
| A LOGIN item carries `username`, `notes`, free-form `sites[]`, and timestamps — but the **password is not in `GrokBotVaultCredential`** (no password field in the descriptor) | `GrokBotVaultCredential` above vs `PutGrokBotVaultCredentialRequest|1 id 9|2 title 9|3 username 9|4 notes 9|5 sites 9*|6 password 9` | PROVEN for the descriptor asymmetry; INFERRED that the password lives in the separate encrypted secret store (§2.6) |
| A CARD item stores `brand`, `last4`, `exp_month`, `exp_year`, `holder_name` and a full billing address — **never the PAN** | `GrokBotVaultCard` descriptor | PROVEN |
| Vault read/write RPCs: `ListGrokBotVaultCredentials(include_kinds)`, `PutGrokBotVaultCredential`, `DeleteGrokBotVaultCredential`, `CreateGrokBotVaultCard(values 9,9 → map)`, `UpdateGrokBotVaultCard`, `PutGrokBotVaultItem(item, secret_fields 9,9)` | descriptors in `coordinator.beauty.js` | PROVEN |
| `PutGrokBotVaultItemRequest` carries a separate `secret_fields` **map**, which is where secret values (passwords, CVV) travel | `PutGrokBotVaultItemRequest|1 item #0|2 secret_fields 9,9` | PROVEN |

### Target rules

```text
CredentialTargetRule|1 kind #0|2 scheme 9|3 host 9|4 port 5|5 registrable_domain 9
CredentialTargetRuleKind :: UNSPECIFIED, EXACT_HOST_PORT, REGISTRABLE_DOMAIN
```

| Fact | Evidence | Tag |
|---|---|---|
| A target rule is either an exact `scheme://host:port` or a whole registrable domain | `CredentialTargetRule` + `CredentialTargetRuleKind` | PROVEN |
| Credentials can expire, with a policy shape | `CredentialExpirationMode :: DISABLED, WARN, ENFORCE`; `CredentialLifecycleState :: ACTIVE, EXPIRING, GRACE, EXPIRED, PROVIDER_REJECTED` | PROVEN |
| A credential can be *revoked at the provider*, distinctly from local expiry | `CredentialLifecycleState.PROVIDER_REJECTED` | PROVEN |
| Credential decisions are made by a named **harness**, either the box or the Temporal workflow engine | `SandCredentialDecisionHarness :: UNSPECIFIED, BOX, TEMPORAL` | PROVEN |
| Credential requests are approved/denied as a pair | `GrokBotCredentialRequestResolution :: UNSPECIFIED, APPROVED, DENIED`; `ResolveGrokBotCredentialRequestRequest|1 agent_id 9|2 entry_id 9|3 resolution #0|4 session_id 9` → `ResolveGrokBotCredentialRequestResponse|1 accepted 8|2 refusal #0?` | PROVEN |

**INFERRED:** `SandCredentialDecisionHarness.BOX` vs `TEMPORAL` means credential decisions can be taken
either by the always-on box (when the user is offline and the box is the actor) or by the durable workflow
engine — i.e. the same "may this bot use this login?" question is answered in two different execution
contexts. This matches the two-harness enum `GrokBotAgentHarnessKind :: UNSPECIFIED, BOX, TEMPORAL`.

## 2.3 Chrome cookie import: the actual "log in once" path

Four coordinator methods form this flow, and their authorization classes are revealing:

| Method | Auth class | Args (from schema) | Evidence |
|---|---|---|---|
| `requestCookieOriginApproval` | `background` | `{requestId, origins: Array<{origin, profileId}>, agentId?}` | `coordinator.beauty.js:32780`, `34206`; `_K` at `34116` |
| `awaitCookieOriginApproval` | `background` | `{requestId, waitMs}` | `coordinator.beauty.js:32781`, `34207` |
| `cancelCookieOriginApproval` | `background` | `{requestId}` (also exposed with `noArgs` on the cancel path at `34727`) | `coordinator.beauty.js:32782`, `34208` |
| `injectChromeCookies` | **`person`** | `{cookies: Array<ChromeCookie>}` | `coordinator.beauty.js:32926`, `34424` |

The cookie record itself is a full Chromium cookie, including the modern partitioning fields:

```js
// recon/beautified/coordinator.beauty.js:34117-34130
  TK = w({
    name: p(),
    value: EK,
    domain: p(),
    path: p(),
    expires: ne(),
    httpOnly: Z(),
    secure: Z(),
    sameSite: A(_e("same-site policy", ["Strict", "Lax", "None"])),
    session: A(Z()),
    priority: A(_e("cookie priority", ["Low", "Medium", "High"])),
    partitionKey: A(Ve(p(), xt($x()))),
  }),
```

| Fact | Evidence | Tag |
|---|---|---|
| The injected cookie shape includes `httpOnly`, `secure`, `sameSite`, `priority` and a **`partitionKey`** (CHIPS / partitioned cookies) | `coordinator.beauty.js:34117-34130` | PROVEN |
| `value` uses `EK`, a distinct validator from plain `p()` — a value-concealing/branded type | `coordinator.beauty.js:34119` | INFERRED — the separate validator implies the value is treated as a secret distinct from the other fields |
| The approval unit is `(origin, profileId)` — explicitly **per Chrome profile**, so a user with several Chrome profiles is asked per profile | `_K = Ve(p(), w({ origin: p(), profileId: p() }))` at `coordinator.beauty.js:34116` | PROVEN |
| Approval requests are `background` (they can be *raised* unattended) while the **injection** is `person` (it cannot complete without the user) | auth-class table `coordinator.beauty.js:32780-32926` | PROVEN |
| This whole feature is behind a gate | `sand_import_chrome_cookies: { client: !0, default: !1 }` at `main-app.beauty.js:48417`; error text *"Chrome cookie import is behind the sand_import_chrome_cookies gate."* at `main-app.beauty.js:93555` | PROVEN |
| The *origin-grant* sub-feature has its own gate | *"Cookie origin grants are behind the agent_prompted_cookie_sync gate."* at `main-app.beauty.js:93561` | PROVEN |
| Cable/device-bound cookies are recognised | `importIncludesDbscBoundHost(i)` at `main-app.beauty.js:93604` — `DBSC` = Device Bound Session Credentials | PROVEN for the symbol; INFERRED for the expansion |

### How Chrome's file is actually read

This is the most security-sensitive mechanism in the section, and the evidence is unusually explicit.

```js
// recon/beautified/main-app.beauty.js:67656-67664
  aSt = 'tell application "Finder" to get name',
    …
    name = "MacFinderAutomationPendingError";
    …
      super("macOS Finder Automation is still off");
  …
  await Jue("/usr/bin/osascript", ["-e", aSt], { timeout: 15e3 });
```

```js
// recon/beautified/main-app.beauty.js:67719-67723
  name = "ChromeCookieImportPermissionError";
  constructor(t = "macOS Finder could not copy Chrome's cookie file") {
```

```js
// recon/beautified/main-app.beauty.js:67825-67828
var dpe = "Chrome Safe Storage";
    constructor(t = "macOS denied Chrome Safe Storage") {
```

| Claim | Tag | Reasoning |
|---|---|---|
| Grok Bot reads Chrome's cookie database by asking **Finder** (via `/usr/bin/osascript`) to copy the file | PROVEN | The AppleScript probe `tell application "Finder" to get name`, the 15 s timeout, and the default error message *"macOS Finder could not copy Chrome's cookie file"* |
| It then decrypts cookies with the macOS Keychain item **`Chrome Safe Storage`** | PROVEN | The literal `dpe = "Chrome Safe Storage"` and the error *"macOS denied Chrome Safe Storage"* |
| The Keychain password can also be supplied out-of-band, bypassing the prompt | PROVEN | `chromeImportSafeStoragePassword` is read from the environment and threaded through as `safeStoragePassword` (`main-app.beauty.js:108186`, `68025`, `68031`, `68070`) |
| It enumerates per-profile, collects, filters by the allowed `(origin, profileId)` set, then injects | PROVEN | `uniqueChromeCookieAllowProfileIds(t)` → `collectProfileCookies(R)` → `selectCookiesForAllowIds(R, w.cookies, t)` → `injectChromeCookies({cookies: i})` at `main-app.beauty.js:93588-93601` |
| Cookies that fail to decrypt are counted, not silently dropped | PROVEN | `c += w.undecryptable` at `93595`, and `undecryptable` is a field of `classifyChromeCookieImportSkip` at `93608-93617` |
| The user-facing remedy string names the three required grants exactly | PROVEN | *"macOS is blocking Chrome cookies. Turn on Grok Bot in Privacy & Security → Full Disk Access and Automation (Finder), click Always Allow on Chrome Safe Storage, then retry."* (`main-core.beauty.js:20043`, key `xibDFX`) |
| The app can deep-link the user straight to those panes | PROVEN | `OX = "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"`, `NX = "…?Privacy_Automation"` at `main-core.beauty.js:14404-14405`, exported as `MACOS_FULL_DISK_ACCESS_SETTINGS_URL` / `MACOS_AUTOMATION_SETTINGS_URL` (`main-core.beauty.js:39691-39694`) |

> **Security assessment (INFERRED).** The Finder-copy trick is a deliberate **TCC-avoidance** pattern:
> Finder already holds Full Disk Access on a stock Mac, so an AppleScript-mediated copy can read
> `~/Library/Application Support/Google/Chrome/**/Cookies` **without Grok Bot itself being granted Full
> Disk Access**. Grok Bot therefore asks for two *narrower* grants (Automation→Finder, and the Chrome Safe
> Storage keychain item) instead of the much broader Full Disk Access. The trade-off is that it converts
> Grok Bot into a scripted controller of Finder, and the resulting cookie set — including `httpOnly` and
> session cookies for every approved origin — ends up inside Grok Bot's process memory and is then pushed
> to the box. The consent boundary is the per-`(origin, profileId)` approval, gated behind a feature flag
> that defaults **off**.

### The approval UX literals

All from the single i18n catalog line `main-core.beauty.js:20043` (Lingui `.po` compiled inline; keys are
content hashes):

| Key | String | Meaning |
|---|---|---|
| `1Q+cpb` | `"The Bot wants to use your existing logins"` | the cookie-origin approval card title |
| `MRaD32` | `"The user did not allow listing which local browser cookies are available."` | denial of the *enumeration* step |
| `pLJubv` | `"No Chrome cookies match those origins."` | empty-result outcome |
| `KRzYIC` | `"Grok Bot is not open on this computer, so Chrome cookie approval cannot be shown."` | approval must be surfaced in the GUI |
| `umduSc` | `"Chrome cookie approval could not be completed on this computer."` | failure outcome |
| `9AT0Dv` | `"That account's saved sign-in is missing. Add the account again to use it."` | vault miss |
| `FS36gZ` | `"The secure input could not write the credential to its store"` | `submitSecret` failure |
| `pKu300` | `"Could not store the secret"` | `storeSecret` failure |
| `fXID+t` | `"Bot failed to resume after secret submission"` | the bot was blocked awaiting the secret |
| `ETLlnF` | `"Chrome"` | product label |

## 2.4 WebAuthn / passkeys: the `sand-webauthn-signer` path

Grok Bot supports security keys and platform passkeys **for sites it visits on the user's behalf, from the
box**. The user-facing string makes the topology unambiguous:

> `"A browser in your Grok Bot box is asking to sign in to ",["rpId"]," with the security key plugged into
> this computer. Approve only if you started this."` — `main-core.beauty.js:20043`, key `ugATw1`

| Fact | Evidence | Tag |
|---|---|---|
| The ceremony origin is the **box's browser**, while the **authenticator is the user's local security key** | `ugATw1` above | PROVEN |
| The ceremony request RPC is `requestWebAuthnCeremony` with args `v$ = w({ kind: N$, origin: p(), optionsJson: p() })` — i.e. **the raw `PublicKeyCredentialCreationOptions`/`RequestOptions` JSON is forwarded** | `coordinator.beauty.js:33922`, `34209` | PROVEN |
| The request is `background`-class, so it can be raised without the user present; the *resolution* is a separate `person`-class edge | `coordinator.beauty.js:32783` | PROVEN |
| A ceremony has a kind and a status | `PasskeyCeremonyKind :: UNSPECIFIED, REGISTER, APPROVE, APPROVE_WITH_REGISTRATION`; `PasskeyCeremonyStatus :: UNSPECIFIED, PENDING, COMPLETED, FAILED, EXPIRED` | PROVEN |
| The signing key material is handled by a **separate native binary**, not by Node | `IE = process.platform === "win32" ? "sand-webauthn-signer.exe" : "sand-webauthn-signer"` at `coordinator.beauty.js:3300` | PROVEN |
| Binary search path when packaged | `path.join(process.resourcesPath ?? "", "app.asar.unpacked", "dist", "native", IE)` | PROVEN — `coordinator.beauty.js:3311-3315` |
| Binary search path when unpackaged | `<repoRoot>/target/release/<IE>` then `<repoRoot>/target/debug/<IE>` — **the signer is a Rust binary built with Cargo** | PROVEN — `coordinator.beauty.js:3315` (INFERRED for "Rust": the `target/release` layout is Cargo's) |
| The signer is spawned per request with `stdio: ["pipe","pipe","pipe"]` and talks newline-delimited JSON on stdin; events are parsed from stderr lines prefixed `"[signer-event] "` | `coordinator.beauty.js:3341-3343` (`spawn(r.binaryPath, [], {stdio:["pipe","pipe","pipe"]})`), `TO = "[signer-event] "` at `3296`, stderr handler at `3389-3397` | PROVEN |
| The signer event vocabulary is a fixed set | `o0 = ["pin-blocked","pin-not-set","presence-required","select-device","uv-blocked","uv-invalid"]` at `3290`; plus `pin-required` and `pin-invalid` at `3330-3337` | PROVEN |
| PIN prompts are answered over the same stdin pipe as `{kind:"pin", pin}` or `{kind:"cancel"}` | `coordinator.beauty.js:3360-3376` | PROVEN |
| Cancellation kills the signer with `SIGTERM` and surfaces a `NotAllowedError` with `code: "cancelled_or_timeout"` and message `"the security key request was cancelled"` | `coordinator.beauty.js:3346-3357` | PROVEN |

The ceremony-status strings in the UI, again from `main-core.beauty.js:20043`:

| Key | String |
|---|---|
| `fjHsol` | `"Security key request"` |
| `Bi0+rD` | `"Use your security key?"` |
| `GAbz2q` | `"Touch your security key now"` |
| `FD44bW` | `"Waking your security key…"` |
| `RjHsw+` | `"Touch the security key you want to use"` |
| `DEuljI` | `"Enter your security key PIN"` |
| `tZ/wv4` | `"Your security key is protected by a PIN. Enter it to sign in to ",["rpId"],"."` |
| `qvXahP` | `"Waiting for your security key"` |
| `v4fWFb` | `"Checking your PIN…"` |
| `apx/UR` | `"That didn't match — try again on the key"` |
| `4urG+E` | `"That PIN was not accepted. Try again."` |
| `Sno38j` | `"That PIN was not accepted. # attempt(s) left before the key locks itself."` |
| `1mX2HI` | `"Your security key is locked"` |
| `vrYX/k` | `"Your security key's fingerprint check is locked"` |
| `IZuLG+` | `"This security key has no PIN set, but the site asked for one"` |

**INFERRED, important:** the `Sno38j` plural string ("*# attempts left before the key locks itself*")
proves Grok Bot **counts CTAP2 PIN retries** and surfaces the authenticator's lockout state — this is a
genuine CTAP2 client implementation (via the Rust signer), not a WebAuthn shim. Combined with
`APPROVE_WITH_REGISTRATION` in `PasskeyCeremonyKind` (use an existing passkey *and* enrol a new one in one
ceremony) and with `GetPasskeyCeremonyResponse|1 kind #0|2 options_json 9|3 spend #1?`, the passkey
subsystem is also wired into **spend approval** (§2.7): `PasskeyCeremonyKind.APPROVE` exists precisely to
authorize a virtual-card payment, and `SpendApprovalAttestation|1 challenge_id 9` is the attestation the
desktop returns to the backend.

### Passkey enrolment and lifecycle

| RPC | Descriptor / purpose | Evidence |
|---|---|---|
| `VerifyPasskeyEnrollmentCodeRequest|1 code 9` → `…Response|1 enrollment_ticket 9` | step-up code → ticket | PROVEN |
| `BeginPasskeyRegistrationRequest|1 enrollment_ticket 9` → `…Response|1 ceremony_id 9|2 creation_options_json 9|3 ceremony_path 9|4 ceremony_token 9` | begins a WebAuthn *registration* | PROVEN |
| `FinishPasskeyRegistrationRequest|1 ceremony_token 9|2 attestation_json 9|3 name 9` → `…Response|1 credential_id 9` | completes it | PROVEN |
| `GetPasskeyCeremonyRequest|1 ceremony_token 9` → `…Response|1 kind #0|2 options_json 9|3 spend #1?` | the app polls/reads a ceremony, optionally with a spend payload | PROVEN |
| `GetPasskeyCeremonyStatusRequest|1 ceremony_id 9` → `…Response|1 status #0` | status polling by id | PROVEN |
| `ListPasskeysResponse|1 passkeys #0*`; `RevokePasskeyRequest|1 credential_id 9` | inventory & revocation | PROVEN |
| `Passkey|1 credential_id 9|2 name 9|3 created_at_ms 3|4 last_used_at_ms 3?|5 device_type 9|6 backed_up 8` | the stored record, including `backed_up` (synced vs device-bound) | PROVEN |

> **Security assessment (INFERRED).** `ceremony_path` and `ceremony_token` in
> `BeginPasskeyRegistrationResponse` imply the registration ceremony is completed **in a browser context
> served by the backend**, with the desktop app polling `GetPasskeyCeremony`/`GetPasskeyCeremonyStatus`
> rather than driving WebAuthn itself. The private key therefore never lives in the Electron renderer: the
> `attestation_json` is produced by `sand-webauthn-signer` and forwarded. The residual risk is that the
> **approval prompt is the only thing distinguishing a user-initiated box sign-in from an agent-initiated
> one** — hence the deliberate wording "*Approve only if you started this*".

## 2.5 1Password: the broker path

The launcher binary and its call site:

```js
// recon/beautified/main-app.beauty.js:108642-108648
        launcherPath: Ne.app.isPackaged
          ? Wd.default.join(process.resourcesPath, "app.asar.unpacked", "dist", "native", "sand-op-launcher")
          : Wd.default.join(__dirname, "..", "native", "sand-op-launcher"),
        launcherVerification: Ne.app.isPackaged ? "anysphere" : "development",
        isSignedIn: () => lf,
        reportAutoRefreshFailure: (H) => (0, Pn.reportDesktopEdgeFailure)("onepassword", "refresh", H),
        onAutoRefreshSynced: () => syt?.(),
        telemetry: () => gt,
```

with the surrounding factory call:

```js
// recon/beautified/main-app.beauty.js:108637-108641
      T = bft({
        backend: Mt,
        openBrowser: (H) => Ne.shell.openExternal(H),
        ...(Ne.app.isPackaged && !vue ? {} : { openOAuthWindowWithoutSandProtocol: () => vft(() => Mn) }),
        isBrokerEnabled: () => of("sand_new_1pass"),
```

| Fact | Evidence | Tag |
|---|---|---|
| The 1Password integration is a **separate native binary** `sand-op-launcher`, unpacked from the asar | `main-app.beauty.js:108642-108645` | PROVEN |
| In packaged builds it is verified with `launcherVerification: "anysphere"` — a **code-signing identity check** on the helper before execution; in dev the check is `"development"` | `main-app.beauty.js:108646` | PROVEN — the string literally names the expected signing identity |
| A feature gate `sand_new_1pass` selects the broker implementation | `main-app.beauty.js:108641` | PROVEN |
| A second gate `sand_1pass_manual_service_acct` defaults to **true** | `main-app.beauty.js:48321` | PROVEN |
| The integration has an **auto-refresh** path with its own failure telemetry class `("onepassword", "refresh", …)` | `main-app.beauty.js:108647` | PROVEN |
| An OAuth window can be opened *without* the `sand` protocol handler — a dev-only escape hatch | `main-app.beauty.js:108640` (`openOAuthWindowWithoutSandProtocol`, guarded by `Ne.app.isPackaged && !vue`) | PROVEN |

The 1Password connection model:

```text
OnePasswordConnectionKind         :: UNSPECIFIED, SERVICE_ACCOUNT, OAUTH_BROKER
OnePasswordBrokerConnectionState  :: UNSPECIFIED, PAIRING, CONNECTED, RECONNECT_REQUIRED
OnePasswordSyncTrigger            :: UNSPECIFIED, MANUAL, APP_FOCUS
OnePasswordCredentialItem|1 credential_id 9|2 title 9|3 category 9|4 sites 9*|5 target_rules #0*|6 vault_name 9|7 connection_id 9|8 catalog_revision 9|9 has_one_time_code 8
```

| Fact | Evidence | Tag |
|---|---|---|
| Two connection kinds: a 1Password **service account** (headless, no app) or an **OAuth broker** through the 1Password desktop app | `OnePasswordConnectionKind` | PROVEN |
| The OAuth-broker path pairs and can require reconnection | `OnePasswordBrokerConnectionState` = `PAIRING`, `CONNECTED`, `RECONNECT_REQUIRED` | PROVEN |
| The catalog records **which vault** an item came from and a `catalog_revision`, so the local view can be reconciled incrementally | `OnePasswordCredentialItem` fields 6 and 8 | PROVEN |
| Items carry `target_rules` — the same `CredentialTargetRule` shape as the native vault, so 1Password items are matched by the same engine | `OnePasswordCredentialItem` field 5 `#0*` = `CredentialTargetRule` | PROVEN |
| TOTP is represented as a **boolean capability** (`has_one_time_code`), not as a stored seed at this layer | `OnePasswordCredentialItem` field 9 | PROVEN for the field; INFERRED that the seed stays in 1Password |
| Sync happens on app focus as well as manually | `OnePasswordSyncTrigger` = `MANUAL`, `APP_FOCUS` | PROVEN |

The approval RPCs for 1Password items are their own pair:

```text
ApproveOnePasswordCredentialRequestRequest|1 entry_id 9|2 agent_id 9|3 credential_id 9|4 connection_id 9|5 catalog_revision 9|6 target_site 9|7 harness #0
DenyOnePasswordCredentialRequestRequest|1 entry_id 9|2 agent_id 9|3 harness #0
OnePasswordCredentialDecisionResponse|1 ok 8|2 detail 9
```

| Fact | Evidence | Tag |
|---|---|---|
| The approval is bound to a **`catalog_revision`** — if the 1Password catalog changed since the agent asked, the approval cannot be silently replayed against a different item | `ApproveOnePasswordCredentialRequestRequest` field 5 | PROVEN |
| The approval names a **`target_site`** — the user sees (and approves) the specific destination, not just "a login" | field 6 | PROVEN |
| The approver must state which **harness** is asking (box vs Temporal) | field 7 → `SandCredentialDecisionHarness` | PROVEN |
| Denial needs only `entry_id`, `agent_id`, `harness` — the minimum needed to unblock the requesting workflow | `DenyOnePasswordCredentialRequestRequest` | PROVEN |
| `OnePasswordCredentialDecisionResponse{ok, detail}` carries a free-text `detail`, so a partial failure can be surfaced without a distinct error code | PROVEN for the shape; INFERRED for the intent |
| Whether 1Password's own user-presence prompt is always enforced in addition to Grok Bot's is not determinable from these bundles | **UNKNOWN** | — |

## 2.6 Secrets: `storeSecret` / `submitSecret` / box secrets

Two distinct concepts share the word "secret":

**(a) Agent-facing named secrets** (`GrokBotSecret`) — configuration values the agent can reference:

```text
GrokBotSecret|1 name 9|2 description 9|3 created_at_ms 3|4 updated_at_ms 3
PutGrokBotSecretRequest|1 id 9|2 name 9|3 description 9|4 value 9  → PutGrokBotSecretResponse|1 secret #0
ListGrokBotSecretsRequest|1 id 9 → ListGrokBotSecretsResponse|1 secrets #0*
DeleteGrokBotSecretRequest|1 id 9|2 name 9
SandSetupSecret|1 name 9|2 value 9 ; SandSetupTeamSecrets|1 team_id 9|2 secrets #0*
```

**(b) Just-in-time secrets the agent asks for and the user types in** — the `person`-class widget flow:

```text
SubmitGrokBotSecretRequest|1 agent_id 9|2 entry_id 9|3 value 9|4 session_id 9 → …Response|1 accepted 8|2 refusal #0?
```

and the coordinator's own schemas, which are the authoritative statement of *where* a stored secret is going:

```js
// recon/beautified/coordinator.beauty.js:34213-34220
      submitSecret: I().args({ entryId: p(), value: p(), agentId: q(), sessionId: A(p()) }),
      storeSecret: I().args({
        target: Ve(
          w({ kind: U("box-env"), name: p() }),
          w({ kind: U("channel-credential"), platform: p(), field: p() }),
        ),
        value: p(),
        agentId: q(),
      }),
```

| Fact | Evidence | Tag |
|---|---|---|
| `storeSecret` has exactly two destinations: a **box environment variable** (`{kind:"box-env", name}`) or a **channel credential field** (`{kind:"channel-credential", platform, field}`) | `coordinator.beauty.js:34214-34219` | PROVEN |
| `submitSecret` targets an `entryId` bound to a `sessionId` — the secret is scoped to one agent session, not stored globally | `coordinator.beauty.js:34213` | PROVEN |
| Auth classes differ meaningfully: `storeSecret` is **`background`**, `submitSecret` is **`person`** | `coordinator.beauty.js:32786-32787` | PROVEN |
| Box secrets are **pushed** to the box, not pulled by it | `setBoxSecrets` (`background`, `{secrets}`), `getBoxSecretsStatus` (`person`), `carryBoxSecretsToBot` (`person`, `{serverId, names[]}`) — `coordinator.beauty.js:34430-34432`; auth table `coordinator.beauty.js:32927-32930` | PROVEN |
| `carryBoxSecretsToBot` moves named secrets from the box to a **specific bot server** — the mechanism by which a team bot inherits credentials | coordinator schema at `coordinator.beauty.js:34432`; main-app at `41277` | PROVEN |
| `getBoxSecretsStatus()` returns `{cardKeys: [...]}` | `main-app.beauty.js:89184` (`.cardKeys ?? []`) | PROVEN |
| A bot's secret names are the union of the local keystore's keys and the box's `cardKeys`, deduplicated and sorted | `main-app.beauty.js:89190-89194` (`[...new Set([...r, ...o])]`) | PROVEN |
| Unfetchable secrets degrade to `{name, outcome: "missing"}` rather than failing the whole call | `main-app.beauty.js:89187-89189` | PROVEN |

### At-rest encryption

```js
// recon/beautified/main-app.beauty.js:103609-103615
      "[sand] OS secure storage (keychain/keyring) is unavailable; box secrets are kept in memory for this session only and will NOT persist across restart.",
    …
      ((this.isEncryptedStorageAvailable = r.isEncryptedStorageAvailable ?? Ve.isEncryptedStorageAvailable),
      (this.safeStorage = r.safeStorage ?? Pq.safeStorage),
```

```js
// recon/beautified/main-app.beauty.js:103685-103695, abridged
    if (this.isEncryptedStorageAvailable()) {
      for (let [s, c] of Object.entries(t))
        ((r[s] = this.safeStorage.encryptString(c).toString("base64")), o.delete(s));
      this.persist(n);
      return;
    }
    bBn();
    for (let [s, c] of Object.entries(t)) o.set(s, c);
```

| Fact | Evidence | Tag |
|---|---|---|
| Secrets at rest are encrypted with Electron's **`safeStorage`** (macOS Keychain / Linux keyring / Windows DPAPI), base64-encoded, and written to one file | `main-app.beauty.js:103685-103691`, `103611` | PROVEN |
| The file is `USER_SECRETS_FILENAME` under `app.getPath("userData")` | `main-app.beauty.js:103606` | PROVEN |
| If OS secure storage is unavailable, secrets are held **in memory only**, and the degradation is announced to Sentry as a warning | `main-app.beauty.js:103611-103615` (`captureSandSentryWarning`) | PROVEN |
| Decryption failures are reported as `reportDesktopEdgeFailure("user-secrets", "decrypt", …)` and treated as "no value" | `main-app.beauty.js:103650-103655` | PROVEN |
| Files are written with `mode: 384` (octal `0600`) | `main-app.beauty.js:103747-103749` (`writeTextFile` → `mode: 384`) | PROVEN |
| Secrets are namespaced per **account scope** and are blocked from export while the account is departing | `main-app.beauty.js:103658-103666` (`exportSnapshot`), `103795` (`isAccountDeparting`) | PROVEN |
| A push to the box returns `{isApplied}` and, on failure, is classified as `keychain_locked` vs `other` | `main-app.beauty.js:103799-103812` | PROVEN |
| Pushes stop at quit and throw `SandBoxSecretsPushStoppedError` with message `"Box secrets pushes are stopped for quit"` | `main-app.beauty.js:103779-103783` | PROVEN |

## 2.7 Virtual cards and agent-initiated spend

The backend exposes a dedicated protobuf surface for **raising** and **resolving** a virtual card. The
request carries the merchant and the amount the agent wants to spend:

```text
RaiseGrokBotVirtualCardRequest|1 agent_id 9|2 amount_cents 3|3 currency 9|4 merchant_name 9|5 merchant_url 9|6 context 9
RaiseGrokBotVirtualCardResponse|1 outcome #0|2 request_id 9|3 merchant_name 9?|4 superseded_request_id 9?
GrokBotVirtualCardRaiseOutcome :: UNSPECIFIED, RAISED, ALREADY_PENDING
```

```text
ResolveGrokBotVirtualCardApprovalRequest|1 agent_id 9|2 entry_id 9|3 request_id 9|4 resolution #0|5 payment_method_id 9?|6 attestation #1?
ResolveGrokBotVirtualCardApprovalResponse|1 outcome #0|2 spend_request_id 9?|3 approval_url 9?|4 message 9?|5 refusal #1?|6 enrolled_credential_ids 9*
GrokBotVirtualCardResolution  :: UNSPECIFIED, APPROVED, DENIED
GrokBotVirtualCardOutcome     :: UNSPECIFIED, APPROVED, DENIED, NEEDS_AUTH, FAILED, NEEDS_PASSKEY
SpendApprovalAttestation|1 challenge_id 9
SpendApprovalCeremonyMode :: UNSPECIFIED, ASSERT, REGISTER
```

| Fact | Evidence | Tag |
|---|---|---|
| The agent can request a virtual card for a specific **amount (in cents), currency, merchant name, merchant URL and free-text context** | `RaiseGrokBotVirtualCardRequest` | PROVEN |
| The response can supersede a previous pending request | field 4 `superseded_request_id` | PROVEN |
| Resolution is a `person`-class coordinator method `resolveVirtualCardApproval` with resolution ∈ `approved | denied | failed | expired` and an optional `attestation` | `coordinator.beauty.js:32775`, `34192-34201` | PROVEN |
| The backend's resolution enum is narrower (`APPROVED`, `DENIED`) than the coordinator's (`approved`, `denied`, `failed`, `expired`) — local timeouts are a desktop concept | compare `GrokBotVirtualCardResolution` with `coordinator.beauty.js:34196` | PROVEN |
| A successful resolution can return an **`approval_url`** — i.e. approval may complete in a browser, not in the app | `ResolveGrokBotVirtualCardApprovalResponse` field 3 | PROVEN |
| The response reports `enrolled_credential_ids` — a passkey can be **enrolled as part of approving a spend** | field 6, plus `PasskeyCeremonyKind.APPROVE_WITH_REGISTRATION` and `SpendApprovalCeremonyMode.REGISTER` | PROVEN |
| A spend approval can specifically fail needing a passkey | `GrokBotVirtualCardOutcome.NEEDS_PASSKEY` | PROVEN |
| Payment methods come from **Stripe Link** | `GrokBotStripeLinkPaymentMethodKind :: UNSPECIFIED, CARD, BANK_ACCOUNT`; `GrokBotStripeLinkPaymentMethodsOutcome :: UNSPECIFIED, OK, NEEDS_AUTH, UNAVAILABLE`; coordinator method `listVirtualCardPaymentMethods` (`coordinator.beauty.js:34553`, `34641`, `37051`) | PROVEN |
| The backend RPCs are registered as unary calls `raiseGrokBotVirtualCard` → `RaiseGrokBotVirtualCard` and `resolveGrokBotVirtualCardApproval` → `ResolveGrokBotVirtualCardApproval` | `coordinator.beauty.js:28260-28261` | PROVEN |
| The user-facing approval copy names the merchant | `yys/x+` = `"Approve a card for ",["merchantName"]]`; failure `gtUhhC` = `"The purchase could not be authorized"`; stale-version `QqzfGy` = `"The server sent an answer this version of Grok Bot can't read. Update Grok Bot, then request a new card."` (`main-core.beauty.js:20043`) | PROVEN |

> **Security assessment (INFERRED).** This is a **spend-authorization** system bolted onto a
> **credential-injection** system, and they share the passkey ceremony as the strongest factor. The design
> is defensible: the agent never sees a PAN (`GrokBotVaultCard` has only `last4`), the browser never
> receives a PAN (a virtual card number is raised server-side and returned as an `approval_url` flow), and
> the human approval is a `person`-class edge. The main residual risks are (i) an approval prompt that
> arrives while the user is not watching — mitigated by `GrokBotVirtualCardResolution` including
> `expired`; and (ii) the `attestation` being only a `challenge_id`, so the strength of the binding between
> the approval and the spend depends on the passkey ceremony, which is `NEEDS_PASSKEY`-gated rather than
> mandatory for every spend.

## 2.8 Connector grants — the fourth approval axis

Beyond cookies, credentials and cards, there is a distinct **connector grant**: "may this bot use this
connected service for this turn?"

```text
ResolveGrokBotConnectorGrantRequest|1 agent_id 9|2 request_id 9|3 resolution #0|4 session_id 9?|5 entry_id 9?
ResolveGrokBotConnectorGrantResponse|1 dispatched 8|2 workflow_id 9?|3 refusal #0?
GrokBotConnectorGrantResolution :: UNSPECIFIED, ALLOWED, SKIPPED, ALWAYS_THIS_BOT, ALWAYS_ALL_TEAM_BOTS, ALLOW_IN_CHANNEL
ClearGrokBotConnectorAlwaysAllowResponse|1 cleared_count 13
GrokBotConnectorType :: UNSPECIFIED, USER, TEAM
```

| Fact | Evidence | Tag |
|---|---|---|
| Grants are persistent — `ALWAYS_THIS_BOT` and `ALWAYS_ALL_TEAM_BOTS` are remembered, and there is a `ClearGrokBotConnectorAlwaysAllow` operation to forget them (`cleared_count` returns how many were removed) | descriptors above | PROVEN |
| A grant can be scoped to a **channel** (`ALLOW_IN_CHANNEL`) — i.e. approved for a Slack channel or Teams chat rather than globally | `GrokBotConnectorGrantResolution.ALLOW_IN_CHANNEL` | PROVEN |
| Connectors are owned by a `USER` or a `TEAM` | `GrokBotConnectorType` | PROVEN |
| Resolution dispatches work (`dispatched`, `workflow_id`) rather than completing synchronously — the human's answer resumes a durable workflow | `ResolveGrokBotConnectorGrantResponse` fields 1-2 | PROVEN |
| `resolveConnectorGrant` is `person`-class | `coordinator.beauty.js:32774` | PROVEN |
| The UI copy distinguishes "the bot's account" from "your account" — a connector bound to *your* account cannot be fixed by signing in the bot | `rT3y+O` = `"[serverName] is connected to your account, not the Bot's, so signing in won't help; the Bot needs your approval for this turn instead"`; and `sDjEmJ` = `"[serverName] runs on Grok Bot's computer and doesn't use browser sign-in. Configure its credentials in the environment settings."` (`main-core.beauty.js:20043`) | PROVEN |

## 2.9 Consolidated approval inventory

| Layer | Method / RPC | Auth class | Scope | Persisted? |
|---|---|---|---|---|
| Chrome cookies | `requestCookieOriginApproval` / `await…` / `cancel…` | `background` | `(origin, profileId)` | no — per import |
| Chrome cookies | `injectChromeCookies` | `person` | per call | no |
| WebAuthn | `requestWebAuthnCeremony` | `background` | per ceremony | passkey record if registering |
| 1Password | `ApproveOnePasswordCredentialRequest` / `Deny…` | (backend) | `credential_id` + `catalog_revision` + `target_site` | yes in 1Password |
| Native vault | `ResolveGrokBotCredentialRequest` | `person` (via widget) | `entry_id` + `session_id` | vault item persists |
| Virtual card | `RaiseGrokBotVirtualCard` → `resolveVirtualCardApproval` | `person` | per `request_id` | server-side |
| Connector | `ResolveGrokBotConnectorGrant` | `person` | per `request_id`, optionally channel-scoped | `ALWAYS_*` persists |
| Secrets | `submitSecret` | `person` | `entry_id` + `session_id` | only if `storeSecret` follows |
| Secrets | `storeSecret` | `background` | `box-env:<name>` or `channel-credential:<platform>:<field>` | yes, in the encrypted user-secrets file |
| Local tools | `resolveLocalToolPermission` | `person` | tool / read / write scopes | `recordLocalToolApproval` to `getLocalToolApprovalsPath()` (`main-app.beauty.js:108733-108734`) |
| macOS Messages | `requestMessagesGrants` / `await…` / `cancel…` / `resolveMessagesGrants` | `background` ×3, `person` ×1 | per `requestId`, grant list | no |
| Auto-review | `resolveAutoReviewApproval` | `person` | per review | `GrokBotAutoReviewApprovalResolution` = `APPROVED`, `DENIED`, **`ALWAYS`** |

The tool-permission vocabulary is shared across all of these:

```js
// recon/beautified/coordinator.beauty.js:33972-33975
  RU = dt("local tool permission", iC),
  cw = Ve(U("always_allow"), U("needs_approval"), U("blocked")),
  $$ = w({ scopes: xt(w({ tools: A(xt(cw)), reads: A(xt(cw)), writes: A(xt(cw)) })) }),
```

| Fact | Evidence | Tag |
|---|---|---|
| A policy attaches to tools, reads and writes **separately**, each with `always_allow` / `needs_approval` / `blocked` | `coordinator.beauty.js:33972-33975` | PROVEN |
| The backend enum `GrokBotToolPermission` (`ALWAYS_ALLOW`, `NEEDS_APPROVAL`, `BLOCKED`) mirrors it | `coordinator.beauty.js` enum table | PROVEN |
| The local card offers four answers, not three: `ALLOW_ONCE`, `DENY`, `ALWAYS`, `NEVER` | `GrokBotLocalToolPermissionCardResolution` | PROVEN |
| A tool call that lands on `permission_required` is treated as a *distinguishable* outcome (`t.tool === "computer_use_screenshot" || t.code === "permission_required"`) — so a permission denial mid-computer-use session is recoverable rather than fatal | `exec-daemon.beauty.js:104030` | PROVEN |

---

# 3. Egress & network model

## 3.1 macOS App Transport Security

Read directly from the shipped bundle (`plutil -p "/Applications/Grok Bot.app/Contents/Info.plist"`):

```text
"NSAppTransportSecurity" => {
  "NSAllowsArbitraryLoads" => true
  "NSAllowsLocalNetworking" => true
  "NSExceptionDomains" => {
    "127.0.0.1" => { "NSIncludesSubdomains" => false,
                     "NSTemporaryExceptionAllowsInsecureHTTPLoads"  => true,
                     "NSTemporaryExceptionAllowsInsecureHTTPSLoads" => false,
                     "NSTemporaryExceptionMinimumTLSVersion" => "1.0",
                     "NSTemporaryExceptionRequiresForwardSecrecy" => false }
    "localhost"  => { …identical… }
  }
}
```

| Fact | Evidence | Tag |
|---|---|---|
| The app declares `NSAllowsArbitraryLoads = true` — **ATS is effectively disabled process-wide** | `Info.plist` → `NSAppTransportSecurity.NSAllowsArbitraryLoads` | PROVEN |
| `NSAllowsLocalNetworking = true` additionally permits local-network hosts | same | PROVEN |
| Explicit loopback exceptions allow **insecure HTTP** but explicitly *not* insecure HTTPS, with a TLS floor of 1.0 and no forward-secrecy requirement | `NSExceptionDomains.127.0.0.1` / `localhost` | PROVEN |
| `NSAllowsArbitraryLoads` makes those loopback exceptions redundant | INFERRED — with arbitrary loads allowed, per-domain exceptions have no additional effect; they are likely a leftover from a pre-arbitrary-loads build, or a deliberate belt-and-braces for `localhost` when the global switch is later turned off | 

> **Security note (INFERRED).** `NSAllowsArbitraryLoads: true` means Grok Bot's own network stack will
> happily fetch plaintext `http://` URLs anywhere. This is *consistent with its purpose* — the agent drives
> the user's websites, many of which are legacy intranet apps — but it also means the app's ATS posture
> cannot be used as a security control for the agent's browsing. The renderer-level CSP (§3.5) and the box's
> own policy layer are the compensating controls.

Other relevant plist keys: `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`,
`NSCameraUsageDescription`, `NSBluetoothAlwaysUsageDescription` (all present, all with the minimal generic
strings "This app needs access to …"), `LSMinimumSystemVersion = 12.0`,
`ElectronAsarIntegrity` (SHA-256 of `Resources/app.asar` = `88c570ca443a0b43486399ea0e285aabd4c51be991e8940a4e4c389d412ffd4c`),
`CFBundleURLSchemes = ["grokbot", "sand"]`, `NSHumanReadableCopyright = "Copyright © 2026 SpaceXAI"`.

## 3.2 The system-proxy resolver

Grok Bot mirrors the OS proxy configuration into its own HTTP/WebSocket stack **and** into child processes.
The log tag is `[sand] system-proxy` and the whole subsystem is a small state machine:

```js
// recon/beautified/main-core.beauty.js:20542-20558, abridged
  return {
    config: e,
    settle: R,
    settleForChildren: async () => { … await a.run(() => x); … },
    reresolve: () => { … (m === void 0 ? 1/0 : yn(m, x)) < one || ((m = x), R()); },
    childEnv: () => (i === null ? {} : { [Am]: JSON.stringify(i) }),
    loginFetch: () => globalThis.fetch,
    webSocketAgent: (x) => (i === null ? void 0 : sne(x)),
    logTo: (x) => {
      (x(["[sand] system-proxy mode=on", `source=${e.source}`, `decision=${d}`].join(" ")), Ow(e, x));
    },
  };
```

| Fact | Evidence | Tag |
|---|---|---|
| The resolved proxy is passed to child processes through a single environment variable | `childEnv: () => ({ [Am]: JSON.stringify(i) })` with `var Am = "SAND_NODE_PROXY_ENV"` at `main-core.beauty.js:18489` | PROVEN |
| Two different global agents are used for secure vs insecure WebSockets | `sne(e)`: `e.startsWith("wss:")` → `Pw.default.globalAgent` (the `node:https` agent); `e.startsWith("ws:")` → `UT.default.globalAgent` (the `node:http` agent) — `main-core.beauty.js:20504-20507` | PROVEN |
| Chromium's own proxy resolution is used as the source of truth, then applied globally via `setGlobalProxyFromEnv` | `t.resolveWithChromium(t.backendUrl)` at `main-core.beauty.js:20524`; default `apply` is `(x) => UT.default.setGlobalProxyFromEnv({ ...x })` at `20512` | PROVEN |
| `SAND_SYSTEM_PROXY` and `SAND_HTTPS_PROXY` are honoured and validated; invalid values are *ignored and logged* rather than fatal | `Dw(e)` at `main-core.beauty.js:20414-20429` (rejects URLs with a `#`, non-`http(s)`, non-root paths, or un-decodable credentials), and the `ignored` accumulator at `20430-20438`; reported as `"[sand] system-proxy ignored-unusable=…"` at `20456-20460` | PROVEN |
| SOCKS is detected and explicitly **unsupported** | `N.sawSocks && t.reportFailure("socks_unsupported")` at `main-core.beauty.js:20517`; decision becomes `"unsupported"` | PROVEN |
| Resolution has three deadlines: 3,000 ms (`rne`), 10,000 ms (`one`), 7,000 ms (`ane`) | `main-core.beauty.js:20408-20410` | PROVEN |
| Failure modes are enumerated as `apply_failed`, `resolve_failed`, `timeout`, `socks_unsupported` | `main-core.beauty.js:20513`, `20528`, `20535`, `20517` | PROVEN |
| The proxy env carries a `NO_PROXY` list built from `[Ck, t]` | `ww(e, t = "")`: `{HTTPS_PROXY: e, HTTP_PROXY: e, NO_PROXY: n}` at `main-core.beauty.js:20431-20434` | PROVEN |
| A proxy config file `system-proxy.json` exists | `kw = "system-proxy.json"` at `main-core.beauty.js:20406` | PROVEN |
| The `loginFetch` hook is deliberately *not* proxied — login/OAuth fetches use `globalThis.fetch` | `loginFetch: () => globalThis.fetch` at `20555` | PROVEN |

> **Note on `loginFetch` (INFERRED).** Deliberately exempting auth fetches from the proxy is a common
> pattern to avoid a broken proxy silently bricking sign-in, but it also means **the user's identity
> provider traffic does not necessarily traverse the same egress path as agent traffic**. If a customer
> expects all Grok Bot traffic to be inspected by a corporate proxy, this is a gap worth noting.

## 3.3 The box egress tunnel

| Fact | Evidence | Tag |
|---|---|---|
| A feature gate `sand_box_egress_tunnel` exists and **defaults to true** | `main-app.beauty.js:49046` | PROVEN |
| Telemetry operation name `"sand.desktop.egress_tunnel"` | `main-app.beauty.js:70185` (`up = "sand.desktop.egress_tunnel"`), used at `92753` (`desktopEgressTunnel: vt(up)`) | PROVEN |
| Coordinator method `isEgressTunnelAvailable` (`background`, no args → boolean) | `coordinator.beauty.js:32903`, `34398`; `main-app.beauty.js:41248`; reply type `{ args: "none", reply: "boolean" }` at `coordinator.beauty.js:36987` | PROVEN |
| The tunnel is a **WebSocket** service on a fixed port | `egressTunnelWebSocket: 8790` and `egressConnectProxy: 8791` in the port table `main-app.beauty.js:79019-79028` | PROVEN |
| The tunnel host is derived by rewriting the backend hostname to embed the port | `e7t(e, t)`: if `t`, split the hostname, require the first label to end `-\d+`, replace that suffix with `-8790`, and set protocol to `wss:`; otherwise set `n.port = "8790"` | PROVEN — `main-app.beauty.js:79044-79058` |
| The tunnel can be **claimed** by this client to avoid two clients racing for one box | `claimEgressTunnel: () => { e.readEgressTunnelController()?.claim(); }` at `main-app.beauty.js:94387-94389`, called again at `94667` | PROVEN |
| Ownership of the tunnel is tracked per box | `$d.noteBoxEgressOwnership(H?.egressTunnelOwnership)` at `main-app.beauty.js:108953` and `109095` | PROVEN |
| The tunnel's enabling is *also* gated on a team policy provider and on an `isAllowed` predicate | `policyProvider: Oze(Mt)`, `isAllowed: dx.isAllowed`, `dx.subscribe(() => ne.setAllowed(dx.isAllowed()))` at `main-app.beauty.js:108945-108954` | PROVEN |
| Status changes are broadcast to the renderer as `"egress-tunnel-status-changed"` and enable/disable as `"egress-tunnel-changed"` | `main-app.beauty.js:108946`, `108955`, `108687` | PROVEN |
| The tunnel uses the system proxy's WebSocket agent | `connectAgent: ye.systemProxy.webSocketAgent` at `main-app.beauty.js:108952` | PROVEN |
| A preference is persisted separately from the effective state | `getEgressTunnelPreference()` / `setEgressTunnelEnabled(g)` / `getEgressTunnelEnabled()` — settings schemas at `exec-daemon.beauty.js:69667-69668` and `70006-70016` (`egressTunnelEnabled` default `!1`, `egressTunnelPreference` optional; `setEgressTunnelEnabled` writes **both** to the same value) | PROVEN |

**INFERRED:** the egress tunnel is how a *box* (a cloud VM with no stable inbound path) reaches the
Cursor/xAI backend and, more importantly, how the **desktop** and the **box** agree on a single outbound
identity for tools and scripts that run on the box. `isEgressTunnelAvailable` being a `background`-class
boolean means the agent can silently discover whether the tunnel is up; `getEgressTunnelStatus` /
`claimEgressTunnel` (`main-app.beauty.js:77271-77272`) are the renderer's control surface.

## 3.4 The box service port map

```js
// recon/beautified/main-app.beauty.js:79019-79041, verbatim
var sd = {
  primaryExecDaemon: 1337,
  primaryPty: 1338,
  primaryNovncWebsockify: 6080,
  windowRouter: 1339,
  forkNovncWebsockify: 6081,
  hostGateway: 1340,
  egressTunnelWebSocket: 8790,
  egressConnectProxy: 8791,
};
var fxr = [
  sd.primaryExecDaemon,
  sd.primaryPty,
  sd.primaryNovncWebsockify,
  sd.windowRouter,
  sd.forkNovncWebsockify,
  sd.hostGateway,
  sd.egressTunnelWebSocket,
];
var X8t = "/run/sand-webauthn-proxy",
  mxr = `${X8t}/credential`;
var Nze = sd.egressTunnelWebSocket;
```

| Port / path | Purpose | Tag |
|---|---|---|
| 1337 | primary exec daemon (the sandboxed shell/file tool server) | PROVEN |
| 1338 | primary PTY | PROVEN |
| 6080 / 6081 | noVNC **websockify** (primary and forked sessions) | PROVEN |
| 1339 | "window router" | PROVEN for the literal |
| 1340 | host gateway — the box's path back to the desktop | PROVEN for the literal |
| 8790 | egress tunnel WebSocket | PROVEN |
| 8791 | egress connect proxy | PROVEN |
| `/run/sand-webauthn-proxy/credential` | a **Unix-domain socket inside the box** that fronts the local computer's security key | PROVEN |

> **The `/run/sand-webauthn-proxy` path is the single most important line in §3.** It proves that the
> WebAuthn ceremony in §2.4 is not an in-process abstraction: the *box's* browser talks to a socket inside
> the box's filesystem, and the desktop bridges that to the physical security key. The user-facing warning
> (`ugATw1`) exists precisely because a compromised box could otherwise silently request signatures.

## 3.5 Renderer Content-Security-Policy

From `recon/grokbot-0.71.2/dist/renderer/index.html` (as recorded in `FINDINGS.md:49-52`):

```text
connect-src 'self' ws: sand-media: https://grok.com
frame-src   sand-html-preview: sand-canvas: sand-mcp-app:
img-src     'self' blob: data: file: https: sand-avatar: sand-favicon: sand-media://image
```

| Fact | Evidence | Tag |
|---|---|---|
| The renderer may open WebSockets to **any** host (`ws:` with no host restriction) | `connect-src … ws:` | PROVEN |
| `https:` connections are restricted to `'self'` and `https://grok.com` — **not** to `api2.cursor.sh` | `connect-src` | PROVEN |
| Only three schemes may be framed: the agent-artifact schemes | `frame-src` | PROVEN |
| `sand-media://image` is named as a **host-qualified** source in `img-src`, i.e. the host component is semantically `image` | `img-src … sand-media://image` | PROVEN |
| The renderer may load `file:` images | `img-src … file:` | PROVEN |

**INFERRED:** since `connect-src` allows `'self'` and the renderer is loaded from `file://…/index.html`,
`'self'` under a `file:` origin is an unusual CSP case; the practical effect is that the renderer's real
data channel is the **loopback coordinator port** (§3.6), which is a WebSocket — hence the unqualified
`ws:`. That also explains why `api2.cursor.sh` need not appear: the renderer never talks to the backend
directly; the main process and the coordinator do.

## 3.6 The loopback coordinator channel

| Fact | Evidence | Tag |
|---|---|---|
| The renderer *requests* the coordinator port over IPC | `preload.beauty.js:4100` (`fi.invoke("sand:coordinator-port-request", void 0)`) | PROVEN |
| The main process answers on `sand:coordinator-port` | `main-app.beauty.js:85108-85109` (`EJe = "sand:coordinator-port-request"`, `bJe = "sand:coordinator-port"`); listener at `preload.beauty.js:4146` | PROVEN |
| The bridge is exposed as `contextBridge.exposeInMainWorld("coordinatorPort", …)` | `preload.beauty.js:4142` | PROVEN |
| Only loopback hosts are accepted | `FINDINGS.md:70` — `new Set(["localhost","127.0.0.1","::1","[::1]"])` | PROVEN (per prior recon) |
| Main→coordinator traffic is a **streaming/reconnecting** transport, not request/response | `gb = new DG(sh, cx.transportStream.openReconnectId)` at `main-app.beauty.js:109297`; `new DW(sh, cx.transportStream.openReconnectId)` | PROVEN |
| A coordinator "handoff" is a first-class desktop lifecycle event, reported to telemetry | `yue = kYe(pz.reportDesktopCoordinatorHandoff)` at `main-app.beauty.js:108184`; operation `sand.desktop.coordinator_handoff` at `70184` | PROVEN |

> **Security assessment (INFERRED).** Loopback-only binding plus a port discovered through the
> preload/main IPC handshake is a reasonable design: it keeps the agent runtime off the network and out of
> the renderer's origin. The residual risk is that **any process on the machine that can guess or observe
> the loopback port** can speak the coordinator protocol, since the allowlist is by hostname and there is no
> token in the evidence (no `Authorization`/`token` argument appears in `claim`). `FINDINGS.md:70` notes the
> hostname allowlist but not any authentication; **whether the coordinator requires a bearer token is
> UNKNOWN** from the available bundles.

## 3.7 Other network surfaces

| Surface | Literal | Evidence | Tag |
|---|---|---|---|
| Diagnostic probe list (17 probes) | `api-dns`, `api-tls`, `api-unary`, `auth-page`, `auth-ui`, `auth-service`, `computer-dns`, `computer-tls`, `computer-health`, `computer-events`, `computer-screen-websocket`, `updates-feed`, `updates-download`, `feature-flags`, `origin-api`, `telemetry`, `voice-realtime` | `main-app.beauty.js:99040-99058` | PROVEN |
| Probe concurrency | `T = await os([...upt], x, { max: DMn })` with `DMn = 4` | `main-app.beauty.js:99061`, `99374` | PROVEN |
| Auth endpoints probed | `fpt = "https://authenticator.cursor.sh"`, `mpt = "https://prod.authentication.cursor.sh"` | `main-app.beauty.js:99073-99074` | PROVEN |
| Update CDN | `gpt = "https://downloads.cursor.com"` | `main-app.beauty.js:99075` | PROVEN |
| Feature-flag endpoint | `` `${F_}/rgstr` `` | `main-app.beauty.js:99352-99355` | PROVEN |
| Telemetry origin | `new URL(Cpt.SAND_SENTRY_DSN).origin` | `main-app.beauty.js:99360-99363` | PROVEN |
| "Origin" backend | `e.backend.originBackendUrl` | `main-app.beauty.js:99356-99359` | PROVEN |
| TLS probe issues a **HEAD with `rejectUnauthorized: false`** and inspects the peer certificate's issuer `O`/`CN` | `LMn(e, t)` at `main-app.beauty.js:99098-99114`; `NMn(e)` certificate reader at `99088-99095` | PROVEN |
| System errno is captured alongside the error log tag for diagnostics | `findSystemErrno(e)` and `` `${errorLogTag(e)} (${t})` `` at `main-app.beauty.js:99080-99082` | PROVEN |
| A hard cap of 240 characters is applied to diagnostic detail strings | `BMn = 240`, `tq(e)` at `main-app.beauty.js:99071`, `99077` | PROVEN |
| Shared token prefix for probe auth | `t.set("authorization", `${rNe} ${e.token}`)` at `main-app.beauty.js:99084-99086` | PROVEN |
| Network state is broadcast to the renderer | `sand:network-online` channel (`FINDINGS.md:61`) | PROVEN (per prior recon) |

---

# 4. Canvas, artifacts and HTML preview

## 4.1 Six privileged schemes, one registration block

```js
// recon/beautified/main-core.beauty.js:21331-21343, verbatim
var zl = "sand-canvas";
function EL() {
  _L.protocol.registerSchemesAsPrivileged([
    { scheme: No, privileges: { standard: !0, secure: !0, supportFetchAPI: !0, stream: !0 } },
    { scheme: zl, privileges: { standard: !0, secure: !0 } },
    { scheme: fc, privileges: { standard: !0, secure: !0 } },
    { scheme: Dl, privileges: { standard: !0, secure: !0 } },
    { scheme: Ml, privileges: { standard: !0, secure: !0 } },
    { scheme: gc, privileges: { standard: !0, secure: !0 } },
    { scheme: "file", privileges: { standard: !0, codeCache: !0 } },
  ]);
}
```

Resolving the minified bindings to their literals:

| Binding | Literal | Declared at |
|---|---|---|
| `No` | `"sand-media"` | `main-core.beauty.js:20573` |
| `zl` | `"sand-canvas"` | `main-core.beauty.js:21331` |
| `fc` | `"sand-html-preview"` | `main-core.beauty.js:20336` |
| `Dl` | `"sand-avatar"` | `main-core.beauty.js:17731` |
| `Ml` | `"sand-favicon"` | `main-core.beauty.js:18477` |
| `gc` | `"sand-mcp-app"` | `main-core.beauty.js:20338` |

| Fact | Evidence | Tag |
|---|---|---|
| **No** sand scheme sets `bypassCSP`, `corsEnabled`, `allowServiceWorkers` or `codeCache` | the block above; every sand scheme has exactly `{standard: !0, secure: !0}` except `sand-media` | PROVEN |
| `sand-media` is the **only** sand scheme with `supportFetchAPI` and `stream`, i.e. the only one fetchable via `fetch()` and the only one that can stream a response | `main-core.beauty.js:21334` | PROVEN |
| `sand-media` is registered with the **wrong-looking** scheme name for `stream`: the object uses `stream: !0`, which is the Electron privilege key | the literal `stream: !0` | PROVEN (as written) |
| `file:` is re-registered as `standard` with `codeCache` — the renderer heap is loaded with V8 code cache | `main-core.beauty.js:21340` | PROVEN |
| A seventh scheme, `sentry-ipc`, is registered by the Sentry SDK with `bypassCSP: !0, corsEnabled: !0, supportFetchAPI: !0, secure: !0`, and the SDK **monkey-patches `registerSchemesAsPrivileged`** so that any later registration also appends its own | `main-core.beauty.js:38782-38786` | PROVEN |
| Because of that patch, calling `registerSchemesAsPrivileged` a second time re-registers `sentry-ipc` — harmless but noteworthy | INFERRED from the `apply` trap at `38783-38786` | 

> **`sentry-ipc` is the only scheme in the app with `bypassCSP: true`.** That is the SDK's own design, but it
> means a scheme capable of bypassing CSP exists in the same protocol registry as the sandboxed artifact
> schemes. It is servable only from Sentry's own `app.whenReady` handler over all app sessions
> (`main-core.beauty.js:38789-38804`), which limits exposure, but the contrast with the sand schemes is worth
> recording.

## 4.2 Protocol handler installation

All handlers are installed from one block during main-window startup:

```js
// recon/beautified/main-core.beauty.js:40661-40668, verbatim
      ee.protocol.handle(Dl, c.serve),
      DL(async (h) => (await _o.serveAttachmentImage?.(h)) ?? new Response(null, { status: 503 })),
      ee.protocol.handle(Ml, async (h) => (await _o.serveLinkFavicon?.(h)) ?? new Response(null, { status: 503 })));
    let S = { isEnabled: Cw(() => _o.readExperimentService?.()), stageDocument: xw };
    (Iw(S),
```

| Scheme | Handler | Backing implementation | Tag |
|---|---|---|---|
| `sand-avatar` | `c.serve` | an avatar-serving object | PROVEN |
| `sand-media` | inline lambda | `serveAttachmentImage(url)`, falling back to **HTTP 503** if the hook is absent | PROVEN |
| `sand-favicon` | inline lambda | `serveLinkFavicon(url)`, falling back to **HTTP 503** | PROVEN |
| `sand-mcp-app` | `Iw(S)` → `Rw.protocol.handle(gc, t => nne(t, S.isEnabled))` | in-memory `Map` of staged documents | PROVEN |
| `sand-html-preview` | `qne`, registered alongside `sand-media` | preview renderer | PROVEN |
| `sand-canvas` | `wKe.protocol.handle(RKe.SAND_CANVAS_SCHEME, qnn(…))` | `main-app.beauty.js:82193` | PROVEN |
| `sand-canvas` scheme constant | `SAND_CANVAS_SCHEME` is re-exported from main-core at `main-core.beauty.js:39680-39682` and equals `zl` | PROVEN |

**INFERRED, notable:** the avatar/favicon/media handlers all take the "return 503 if the dependency is
missing" shape, which means image loads **fail open as broken images rather than as errors** — no exception
reaches the renderer. That is the right choice for a UI surface but it also means a missing media backend is
invisible except through the `desktopEdgeFailure` telemetry path.

## 4.3 `sand-media://image/<id>` — the media pipeline's address space

```js
// recon/beautified/main-core.beauty.js:20573-20591, verbatim
var No = "sand-media",
  FT = "image",
  cne = /^[0-9a-f]{32}$/;
function dne(e) { return cne.test(e); }
function Bw(e, t = 0) {
  let n = t > 0 ? `?r=${t}` : "";
  return `${No}://${FT}/${e}${n}`;
}
function Gw(e) {
  if (!URL.canParse(e)) return null;
  let t = new URL(e);
  if (t.protocol !== `${No}:` || t.host !== FT) return null;
  let n = t.pathname.slice(1);
  return dne(n) ? { id: n } : null;
}
function Ym(e) {
  if (!URL.canParse(e)) return !1;
  let t = new URL(e);
  return t.protocol === `${No}:` && t.host === FT;
}
```

| Fact | Evidence | Tag |
|---|---|---|
| The URL shape is exactly `sand-media://image/<32 lowercase hex>` with an optional `?r=<n>` cache-buster | `Bw` / `Gw` / `cne` above | PROVEN |
| `?r=` is a **revision/cache-buster** appended only when `t > 0` | `Bw(e, t = 0)` | PROVEN |
| The id is a 128-bit hex token, not a path or filename — media is addressable only by opaque id | `cne = /^[0-9a-f]{32}$/` | PROVEN |
| Path traversal is structurally impossible: any path segment that is not 32 hex chars fails the parse | `Gw` returns `null`; `n` is `pathname.slice(1)` and must match `cne` | PROVEN |
| There is a **second, unrelated** hashing function for media | `SL(e, t)` = `createHash("sha256").update(\`sand-media\0${e}\0${t}\`).digest("base64url").slice(0, 22)` at `main-core.beauty.js:21325-21327` — a 22-char base64url digest of two inputs with a domain-separation prefix | PROVEN |
| The CSP `img-src` names the host form `sand-media://image`, matching `FT = "image"` | renderer CSP vs `FT` | PROVEN |
| `resolve-media` (noted in `FINDINGS.md:54`) is a symbol in the same subsystem | `FINDINGS.md:54` | INFERRED — the exact call site was not isolated in this pass; **UNKNOWN** whether it is an IPC channel or an internal function |

> **Security assessment (INFERRED).** `sand-media` is a **capability-URL** design: possessing the 32-hex id
> is sufficient to fetch the bytes, and there is no evidence of a per-request authorisation check inside
> `Xne`/`DL` (`main-core.beauty.js:21593-21597`). The `SL` hash (22 base64url chars ≈ 132 bits of SHA-256)
> is presumably how ids are minted, which makes them unguessable, but ids are visible to anything that can
> read the DOM of a message. There is **no evidence of expiry or single-use semantics** on a media URL.

## 4.4 `sand-canvas:` — the artifact scheme

The URL grammar is validated by an explicit parser with unusually tight rules:

```js
// recon/beautified/main-app.beauty.js:81533-81579, abridged
var _nn = "frame",
  X2e = /^[\w.:-]{1,128}$/;
function Enn(e) { return e != null && X2e.test(e) ? `&rev=${e}` : ""; }
function eKe(e) {
  let t = URL.canParse(e) ? new URL(e) : null;
  if (
    t == null ||
    t.protocol !== `${J2e.SAND_CANVAS_SCHEME}:` ||
    t.hostname !== _nn || t.port !== "" || t.username !== "" || t.password !== "" || t.hash !== ""
  ) return null;
  let n = t.searchParams.get("theme");
  if (n !== "light" && n !== "dark") return null;
  let r = t.searchParams.get("room"),
    o = r === null ? null : od(r);
  if (o !== null && !o.ok) return null;
  let i = t.searchParams.get("rev");
  if (i !== null && !X2e.test(i)) return null;
  let a = `?theme=${n}${o === null ? "" : `&room=${o.value}`}${Enn(i)}`;
  if (t.search !== a) return null;
  …
  if (c.length === 3 && c[0] === "" && c[1] === "user")
    return o !== null ? null : { locator: { kind: "active-user-store", canvasId: d.value }, theme: n, ...s };
```

| Fact | Evidence | Tag |
|---|---|---|
| Canonical URL is `sand-canvas://frame/<canvasId>?theme=light|dark[&room=<id>][&rev=<id>]` | `eKe` above | PROVEN |
| Host must be exactly `frame`; port, username, password and fragment must all be **empty** | `81537-81542` | PROVEN |
| `theme` is mandatory and must be `light` or `dark` | `81543-81544` | PROVEN |
| The query string must match the canonical re-serialisation **exactly** (`if (t.search !== a) return null`) — extra or reordered params are rejected | `81554` | PROVEN |
| Two locator kinds: `active-user-store` from `/user/<canvasId>` and `store` from `/store/<storeId>/<canvasId>` | `81570-81579` | PROVEN |
| `room` is only valid on store locators, not user-store locators | `81571` (`o !== null ? null : …`) | PROVEN |
| `rev` is a 1-128 char `[\w.:-]` token, forwarded as `&rev=` | `X2e`, `Enn` | PROVEN |
| A `groupChatId` can be attached to a store canvas | `...(o === null ? {} : { groupChatId: o.value })` | PROVEN |

### Content caching and byte budget

```js
// recon/beautified/main-app.beauty.js:81585-81603, abridged
function tKe(e = {}) {
  let t = e.byteBudget ?? 33554432,
    n = new Map(), r = 0, o = 0,
    i = new AbortController(),
    a = (d, u) => { n.get(d) === u && (n.delete(d), (r -= u.bytes)); },
    s = (d, u) => { let f = bnn(u), g = n.get(d); if ((g != null && a(d, g), !(f > t))) { n.set(d, {content: u, bytes: f, isRefreshing: !1}), (r += f); for (let [A, S] of n) { if (r <= t) break; a(A, S); } } },
```

and the accounting function:

```js
// recon/beautified/main-app.beauty.js:81584
function bnn(e) { return (e.bundleJsonText.length + e.dataJsonText.length) * 2; }
```

| Fact | Evidence | Tag |
|---|---|---|
| Canvas content cache budget is **32 MiB** (`33554432`) of *estimated* bytes | `81585-81586` | PROVEN |
| Estimated bytes = `(bundleJsonText.length + dataJsonText.length) * 2` — i.e. **2× the character count**, an estimate for UTF-16 | `81584` | PROVEN |
| Eviction is LRU-ish: re-`get`ing an entry re-inserts it (Map insertion order) and eviction walks from the front | `81603` (`g != null && (n.delete(d), n.set(d, g), …)`) | PROVEN |
| Refresh is coalesced per entry and guarded by a generation counter `o` plus an `AbortController` | `81604-81613` | PROVEN |
| `clear()` bumps the generation, aborts in-flight refreshes, and resets the budget | `81617-81621` | PROVEN |
| Content is only cached if it fits within the whole budget individually (`!(f > t)`) — a single oversize canvas is simply not cached | `81597` | PROVEN |
| Refresh failures are reported through `reportRefreshFailure` → `reportDesktopEdgeFailure("canvas-frame","refresh",…)` | `81595`, `82187` | PROVEN |
| Typeface reads are a **separate telemetry class** `("canvas-frame","typeface-read","not_found")` | `82189-82191` | PROVEN |
| A different typeface bundle is selected for "Xvf" builds (`e.isXvfTypeface()`) | `82199` | PROVEN |

### Iframe sandboxing

```js
// recon/beautified/main-app.beauty.js:81632-81634, verbatim
var Cnn = ["allow-scripts", "allow-popups", "allow-popups-to-escape-sandbox"],
  vnn = Cnn.join(" "),
  gOr = `sandbox ${vnn}`;
```

| Fact | Evidence | Tag |
|---|---|---|
| The canvas iframe sandbox is exactly `allow-scripts allow-popups allow-popups-to-escape-sandbox` | `81632-81634` | PROVEN |
| `allow-same-origin` is **absent** — the canvas runs in an opaque origin and cannot reach the host's storage or cookies | absence in `Cnn` | PROVEN |
| `allow-forms`, `allow-modals`, `allow-top-navigation`, `allow-pointer-lock`, `allow-presentation`, `allow-downloads` are **absent** | absence in `Cnn` | PROVEN |
| `allow-popups-to-escape-sandbox` means a popup opened from a canvas is **not** sandboxed — a deliberate escape hatch, and the only one present | `81632` | PROVEN |
| Canvas-originated link opens are additionally gated on a recent genuine user gesture and an `http`/`https`/`mailto`/`tel` scheme (§1.6) | `main-core.beauty.js:28653-28678`, `main-app.beauty.js:108501` | PROVEN |
| A link-interception script (`canvasLinkHref`, reading `href` and `xlink:href`) is injected into canvas content | `main-app.beauty.js:81635-81646` (`function nKe()`), channel `sand-canvas-frame-open-link` at `81527` | PROVEN |

> **Security assessment (PROVEN facts, INFERRED risk).** The sandbox attribute set is strong: opaque origin,
> no forms, no modals, no top-navigation. The one deliberate hole is
> `allow-popups-to-escape-sandbox` — a link inside agent-generated HTML that opens a popup hands that popup
> **unsandboxed** context. That is mitigated by the gesture+scheme gate in §1.6, which is a real
> user-activation check (`isTrusted`-based, ≤1 s recency), so the combination is defensible. The larger
> exposure is `script-src 'self' 'unsafe-inline'` in the *preview* CSP (§4.5), which permits inline script —
> necessary for agent-generated HTML/JS artifacts, and the reason the origin must remain opaque.

## 4.5 `sand-html-preview:` — agent HTML with a generated CSP

```js
// recon/beautified/main-core.beauty.js:20316-20333, abridged
function wT(e) {
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${Aa(e?.resourceDomains)}`,
    `style-src 'self' 'unsafe-inline' ${Aa(e?.resourceDomains)}`,
    `connect-src 'self' ${Aa(e?.connectDomains)}`,
    `img-src 'self' data: ${Aa(e?.resourceDomains)}`,
    `font-src 'self' ${Aa(e?.resourceDomains)}`,
    `media-src 'self' data: ${Aa(e?.resourceDomains)}`,
    `frame-src ${Aa(e?.frameDomains) || "'none'"}`,
    "object-src 'none'",
    `base-uri ${Aa(e?.baseUriDomains) || "'self'"}`,
  ].join("; ");
}
function Aw(e, t, n) {
  let r = `<meta http-equiv="Content-Security-Policy" content="${wT(t)}">`,
    o = e.startsWith("\uFEFF") ? e.slice(1) : e;
  return `<!DOCTYPE html>${r}${ene(n)}${Zte}${o}`;
}
```

| Fact | Evidence | Tag |
|---|---|---|
| The preview CSP is generated **per document** from four caller-supplied domain lists (`resourceDomains`, `connectDomains`, `frameDomains`, `baseUriDomains`) | `wT(e)` | PROVEN |
| Baseline posture: `default-src 'none'`, `object-src 'none'`, `base-uri 'self'` | `20318`, `20326`, `20327` | PROVEN |
| Inline script and inline style are **allowed** (`'unsafe-inline'`) — required for agent-authored HTML | `20319-20320` | PROVEN |
| `frame-src` is **closed by default** (`'none'`) when no `frameDomains` are supplied | `20325` | PROVEN |
| The meta CSP is injected **immediately after `<!DOCTYPE html>`**, before any author content, so it cannot be superseded by author-supplied CSP meta tags later in the document | `Aw` above | PROVEN |
| A leading BOM is stripped before injection, so the meta tag lands first even for BOM-prefixed files | `Aw` | PROVEN |
| Two bridge scripts are injected between the CSP and the author content | `ene(n)` and `Zte` | PROVEN |
| Domain lists are sanitised before being interpolated | `Wm(e)` → `e.filter(zte)` at `main-core.beauty.js:20152-20156` | PROVEN |
| Domain interpolation escapes HTML metacharacters `& < > "` | `Aa(e)` at `main-core.beauty.js:20195-20201` | PROVEN |
| The domain allow-pattern requires a **public-looking** hostname and forbids scheme-less forms | `Yte = /^(?:https|wss):\/\/(?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?$/i` at `20110` | PROVEN |
| A 30-entry deny-list blocks internal / SSRF-adjacent domains, including wildcard-DNS bypass services | `qte` at `20111-20146`: `.local`, `.localhost`, `.internal`, `.intranet`, `.corp`, `.localdomain`, `.lan`, `.home`, `.svc`, `.home.arpa`, `.test`, `.invalid`, `.example`, `.alt`, `.onion`, `.nip.io`, `.sslip.io`, `.xip.io`, `.traefik.me`, `.localtest.me`, `.lvh.me`, `.localho.st`, `.vcap.me`, `.smackaho.st`, `.lacolhost.com`, `.localh.st`, `.local.gd`, `.1u.ms`, `.localhost.direct` | PROVEN |
| `zte(e)` strips the scheme and port, lowercases, and rejects an exact match on the bare TLD-less name **or** any suffix match | `20147-20154` | PROVEN |
| Preview content is gated on an account-gate admission check and rendered as `text/html; charset=utf-8` with the computed `content-length` | `main-core.beauty.js:21565-21572` (`r.admitPreview(e.signal)`), `21585-21587` (`"content-type": mc, "content-length": String(r), "cache-control": "no-cache"`) | PROVEN |
| Preview content is read through a chunked attachment reader (`readChunk(t, 0, …)`), so previews are backed by the attachment store | `21575-21584` (`e.readChunk(t, 0, 0)` returns `{totalSize}`) | PROVEN |
| Total preview size is bounded by `eg` and the first read by `Bne` | `20432`/`20433` region (`r > eg` → refuse) | PROVEN for the guard; the numeric values of `eg`/`Bne` were not resolved in this pass — **UNKNOWN** |

> Note: `sand-html-preview` is gated on the served content **being HTML** — `Ec(n) !== "html" ? Po() : …`
> at `main-core.beauty.js:21568`, where `Po()` is the refusal response. So the scheme cannot be used as a
> general file-read primitive.

## 4.6 `active-user-store-canvas` and `slack-canvas` are **not** protocols

`FINDINGS.md:54` lists these alongside the real schemes. The evidence shows they are **locator/provider
kinds inside the canvas and link-unfurling subsystems**, not registered schemes (they do not appear in the
`registerSchemesAsPrivileged` block, and no `protocol.handle` uses them):

| Literal | Actual role | Evidence |
|---|---|---|
| `"active-user-store-canvas"` | a **kind** in the canvas-locator union: `` `active-user-store-canvas:${e.canvasId}` `` | `main-app.beauty.js:75605-75606` |
| `"active-user-store-canvas"` | an RPC-wire literal for a canvas link: `rpcObject({kind: rpcLiteral("active-user-store-canvas"), canvasId: Pqe})` | `main-app.beauty.js:77192` |
| `"active-user-store-canvas"` | excluded from store-id collection (`N.kind === "active-user-store-canvas" ? [] : [N.storeId]`) because it has no store | `main-app.beauty.js:81324-81326` |
| `"active-user-store-canvas"` | exported from the preload as part of the canvas-link API | `preload.beauty.js:3486` |
| `"slack-canvas"` | a **link provider** id: `{provider: "slack-canvas", id: \`${n}/${r}\`, url: \`${e.origin}/docs/${n}/${r}\`}` parsed from `slack.com/docs/<F-id>/<p-id>` | `main-app.beauty.js:80780`, matcher `Htn` at `80773-80781` |

**INFERRED:** the naming collision is why `FINDINGS.md` grouped them; the correct reading is that
`sand-canvas:` is a transport scheme whose *locator grammar* includes a store/user-store distinction, and
that Slack "canvases" are just one of ~28 recognised external link providers.

## 4.7 The link-provider inventory

```js
// recon/beautified/main-app.beauty.js:80565-80592, verbatim
var D2e = [
  "notion", "google-docs", "google-sheets", "google-slides", "google-drive", "onedrive", "sharepoint",
  "figma", "figjam", "figma-slides", "linear-issue", "linear-document", "confluence-page", "jira-issue",
  "github-file", "github-gist", "github-issue", "slack-canvas", "box", "dropbox", "airtable", "coda",
  "miro", "canva", "hex", "gmail-draft", "google-calendar-event", "slack-message",
  "github-pull-request", "web",
];
```

Each provider has a hand-written matcher emitting `{provider, id, url}`, e.g. GitHub PRs
(`main-app.beauty.js:80731`), Jira (`80712`), Confluence (`80718`), Figma (`80683-80690`), Linear
(`80699-80704`), Notion (`80615`), Google Drive/Docs (`80636-80637`), OneDrive/SharePoint (`80660-80669`),
Airtable (`80799`), Coda (`80808`), Miro (`80812`), Canva (`80821`), Hex (`80832`), Gmail drafts (`80839`),
Google Calendar events (`80849`). **PROVEN** for all.

There is also a much larger **connector/provider id list** used by the UI:

```js
// recon/beautified/main-app.beauty.js:75742-75792, verbatim (47 entries)
var O7 = ["workspace","slack","notion","salesforce","microsoft-365","linkedin","zoom","github","cursor",
  "jira","figma","hubspot","canva","trello","monday","clickup","intercom","zendesk","box","dropbox",
  "docusign","calendly","loom","outreach","salesloft","apollo","clay","zoominfo","nooks","stripe",
  "shopify","quickbooks","netsuite","ramp","workday","rippling","ashby","greenhouse","vercel","tableau",
  "hex","amplitude","mixpanel","snowflake","databricks","mailchimp"],
```

This list maps 1:1 onto the vendor logos shipped in the renderer (`salesforce.svg`, `rippling.png`,
`snowflake.png`, `quickbooks.png`, `databricks.png`, `tableau.png`, `clay.png`, `zoominfo.png`,
`nooks.png`, `workday.svg`, `mailchimp.svg`, `canva.svg`, …), which is independent corroboration that these
are the marketed integrations. **PROVEN** for the list and the assets; **INFERRED** for the 1:1 claim.

## 4.8 `desktopMount` — the always-on-top desktop panel

This is a genuine device integration, not a renderer panel. The main process owns a borderless,
position-persisted window that floats on the user's desktop:

```js
// recon/beautified/main-app.beauty.js:85752-85770, verbatim (abridged to the method list)
  zJe = Ko("desktop-mount", {
    methods: {
      mount: I().args({ agentId: re(), name: ze, markSvgDataUrl: Ron }),
      unmount: I().noArgs,
      offerChoices: I().args({ choices: xon }),
      read: I().noArgs,
      readChoices: I().noArgs,
      readLayout: I().noArgs,
      submitPrompt: I().args({ prompt: OF }),
      switchTo: I().args({ agentId: re() }),
      unmountSelf: I().noArgs,
      reachForMenu: I().args({ heightPx: Mon }),
      movePanel: I().args({ dx: jJe, dy: jJe }),
      endPanelMove: I().noArgs,
    },
    events: Nr(),
    failureCodes: Nr(),
  });
```

| Fact | Evidence | Tag |
|---|---|---|
| The panel page is `src/electron-renderer/desktop-mount/panel/panel.html`, resolved to `renderer/desktop-mount/panel/panel.html` | `main-app.beauty.js:85696`, `85781-85782` | PROVEN |
| Its preload is `preload-desktop-mount-panel.cjs` (shipped at `dist/electron-preload/preload-desktop-mount-panel.cjs`) | `main-app.beauty.js:85780`; `dist/electron-preload/` listing | PROVEN |
| Geometry is fixed: panel `320 × 176`, avatar area `{x:12, y:60, w:56, h:56}`, plus constants `16` and `12` | `main-app.beauty.js:85784-85787` | PROVEN |
| Position is persisted to `desktop-mount-position.json` in `app.getPath("userData")` | `main-app.beauty.js:86091` | PROVEN |
| `movePanel({dx, dy})` is a **delta** API, clamped to a documented integer range; an out-of-range value is a validated failure, not a silent clamp at the RPC layer | `main-app.beauty.js:85750` (`nt(\`integer from -${OV} to ${OV}\`, VJe)`), `JJe(e,t,n) = Math.min(Math.max(e,t),n)` at `85812` | PROVEN |
| The panel is **only supported on macOS and Linux** | `FJe(e) { return e === "darwin" || e === "linux"; }` at `main-app.beauty.js:85699`; failure code `"desktop-mount/unsupported-platform"` at `85745` | PROVEN |
| Other failure codes: `"desktop-mount/nothing-mounted"`, `"desktop-mount/unknown-choice"` | `85746-85747` | PROVEN |
| The panel tracks display topology and prefers the work area with the largest overlap with its own rect | `XJe` (primaryWorkArea/all work areas) at `85783-85786`; `Bon(e, t)` overlap-area function and the `io` selector at `85803-85819` | PROVEN |
| The panel accepts a mark drawn as an **SVG data URL** (`markSvgDataUrl`, validated as `"svg data url"`) — the agent's identity mark | `main-app.beauty.js:85748`, `85754`, `85768`; preload `dd = _("svg data url", An)` at `preload.beauty.js:738` | PROVEN |
| The same `desktop-mount` RPC surface is mirrored in the preload and exposed as `contextBridge.exposeInMainWorld("desktopMount", …)` | `preload.beauty.js:741-758`, `4145` | PROVEN |
| The panel can `reachForMenu({heightPx})` — it grows taller to reveal a menu, then presumably shrinks | `reachForMenu` in the method list; validated with the same integer-range helper | PROVEN |
| The panel can submit a prompt directly (`submitPrompt({prompt})`) and `switchTo({agentId})` — so it is a full mini-client, not a status badge | method list | PROVEN |
| `mount` is idempotent-by-choice: `offerChoices({choices})` lets the backend offer which agent to mount when several are eligible | method list; `"at most ${Ite} mount targets"` validator at `85751` | PROVEN |

**INFERRED:** `desktopMount` is the "always there" surface for a **Forever Box** agent — the small floating
avatar that stays on the user's desktop so the bot is visibly present while working. The
`place_phone_call` / voice-call integration (`§6`), the `box-desktop-modal` (§8), and this panel together
form the "device integration" story beyond the browser.

---

# 5. MCP: client, servers, and MCP Apps

## 5.1 Transports

The server-config schema is the authoritative statement of which transports exist:

```js
// recon/beautified/main-app.beauty.js:57641-57658, abridged
      (Lbn = Zw({
        type: To(Mit("stdio")),
        command: ao(),
        args: To(Jw(ao())),
        env: To(Bj(ao(), ao())),
        envFile: To(ao()),
        cwd: To(ao()),
        enabledTools: To(Jw(ao())),
        startupTimeoutSec: Pit(To(Tit().check(gF())), void 0),
      })),
      (Ubn = Zw({
        type: To(Tae(["http", "sse"])),
        url: ao(),
        headers: To(Bj(ao(), ao())),
        auth: To(Dbn),
        tls: To(Nbn),
        placement: To(Tae(["server", "client"])),
        enabledTools: To(Jw(ao())),
      })),
      (Qit = xit([Lbn, Ubn])),
      (Dj = Qit),
      (Xw = Zw({ mcpServers: Bj(ao(), Qit) }));
```

| Fact | Evidence | Tag |
|---|---|---|
| Exactly **three** transports: `stdio`, `http`, `sse` | `Mit("stdio")` and `Tae(["http","sse"])` at `57643`/`57653` | PROVEN |
| The config file top-level shape is `{ "mcpServers": { "<name>": <server> } }` — the Claude/Cursor convention | `Xw = Zw({ mcpServers: Bj(ao(), Qit) })` | PROVEN |
| A **`placement`** field distinguishes servers that run on the `server` (the box) from those that run on the `client` (the desktop) | `placement: To(Tae(["server", "client"]))` | PROVEN |
| stdio servers support `command`, `args[]`, `env{}`, **`envFile`**, `cwd`, `enabledTools[]` and `startupTimeoutSec` | `Lbn` | PROVEN |
| http/sse servers support `url`, `headers{}`, `auth`, `tls`, and `enabledTools[]` | `Ubn` | PROVEN |
| Client credentials are `{CLIENT_ID, CLIENT_SECRET?, scopes[]}` | `Dbn = Zw({ CLIENT_ID: ao(), CLIENT_SECRET: To(ao()), scopes: To(Jw(ao())) })` at `57639` | PROVEN |
| A custom CA bundle is supported with a **128 KiB** ceiling | `Bbn = 128 * 1024`; `Nbn = Rit({ caBundle: ao().check(dS(), td(1), Qm(Bbn)) })` at `57638-57640` | PROVEN |
| Transport is inferred from the config shape when not explicit | `Idt(e) { return "command" in e ? "stdio" : e.type === "sse" ? "sse" : "http"; }` at `main-app.beauty.js:64709` | PROVEN |
| `type` is normalised case-insensitively, defaulting to `http` | `Wxn(e) { return e?.toLowerCase() === "sse" ? "sse" : "http"; }` at `main-app.beauty.js:66371` | PROVEN |
| A stdio server with an empty `command` and an http server with an empty `url` are both rejected as unusable | `Dce(e)` at `66378-66381`, `Wdt(e)` at `66382-66385` | PROVEN |
| Environment placeholders in stdio config are substituted before launch, across `command`, `args`, `env` values, `envFile` and `cwd` | `wdt(e, t)` at `main-app.beauty.js:64728-64740`; `Ice(e)` at `64723-64726` detects whether any of those contain a placeholder | PROVEN |
| A server is treated as "not usable" (negative id) via `Oce(e) { return e < 0; }` | `66387` | PROVEN |
| Config discovery includes `.cursor/**/mcp.json` workspace patterns | `exec-daemon.beauty.js:32003` (`{ type: "workspace", pattern: "**/.cursor/**/mcp.json" }`) | PROVEN |

**UNKNOWN:** which npm package (if any) implements the MCP client. Searches for
`@modelcontextprotocol/sdk`, `StdioClientTransport`, `SSEClientTransport` and `StreamableHTTPClientTransport`
returned nothing in these bundles, and the only `modelcontextprotocol` hits are the unrelated JSON-RPC
extension URI literal `"io.modelcontextprotocol/related-task"` (`main-app.beauty.js:56722`,
`exec-daemon.beauty.js:59401`). The client is therefore either inlined/renamed by the bundler or lives in a
chunk that the REA pass could not reach. **Do not assume a specific SDK.**

## 5.2 MCP manager and coordinator surface

| Method | Auth class | Args | Evidence |
|---|---|---|---|
| `getMcpState` | `background` | — | `coordinator.beauty.js` auth table |
| `getMcpCatalog` | `background` | — | idem |
| `getEffectiveMcpPlugins` | `background` | — | idem |
| `getMcpPluginLogo` | `background` | — | idem |
| `listMcpServerTools` | (person) | `wU` | `coordinator.beauty.js:34362` |
| `toggleMcpToolDisabled` | (person) | `kK` | `coordinator.beauty.js:34363` |
| `installMcpEntry` | `person` | `CZt` | `coordinator.beauty.js:32905`, `34357`; `main-app.beauty.js:41204` |
| `updateMcpPluginInstall` | `person` | — | coordinator auth table |
| `refreshMcp` | **`background`** | `{completion?}` | `coordinator.beauty.js:32922`, `34358` |
| `listBoxMcpServers` | **`background`** | `{serverIdentifiers[]}` | `coordinator.beauty.js:32924`; `main-app.beauty.js:108464-108467` |
| `authenticateMcpServer` | `person` | `W5` | `coordinator.beauty.js:32919`, `34356` |
| `completeMcpOAuth` | `person` | `{code, state}` | `coordinator.beauty.js:32923`, `34359`; `main-app.beauty.js:41281` |
| `setMcpCustomInstructions` | — | — | `FINDINGS.md:83` |
| `readMcpAppResource` | `person` | `Ws` | `coordinator.beauty.js:32920`, `34364` |
| `callMcpAppTool` | `person` | `{serverIdentifier, toolName, argumentsJson, userActivated, agentId?}` | `coordinator.beauty.js:34365-34371` |

Per-server MCP settings are part of the host settings object:

```js
// recon/beautified/main-app.beauty.js:40666-40675, abridged
        mcpCustomInstructions: (0, p.rpcOptional)(BF),
        mcpCustomInstructionsByServerId: (0, p.rpcOptional)(BF),
        mcpCustomInstructionsAccountScope: (0, p.rpcOptional)((0, p.rpcNullable)((0, p.rpcString)())),
        mcpDisabledToolsByServerId: (0, p.rpcOptional)((0, p.rpcRecord)((0, p.rpcArray)((0, p.rpcString)()))),
        mcpBoxServers: (0, p.rpcOptional)((0, p.rpcArray)((0, p.rpcString)())),
```

| Fact | Evidence | Tag |
|---|---|---|
| MCP custom instructions exist at three scopes: global, per-server-id, and per-account | the four `mcpCustomInstructions*` fields | PROVEN |
| Tool disabling is **per server id**, as a record of string arrays | `mcpDisabledToolsByServerId` | PROVEN |
| `mcpBoxServers: string[]` names which servers live on the box | `mcpBoxServers`; corroborated by `listBoxMcpServers` being `background`-class | PROVEN |
| `readMcpAppResource` args are `{serverIdentifier, resourceUri, agentId?, entryId?, sessionId?, documentSha256?}` | `Ws = w({...})` at `coordinator.beauty.js:34146-34152` | PROVEN |
| `documentSha256` is part of the request — the caller can pin the exact document revision it expects | `Ws` field; and `main-app.beauty.js:38094-38097` re-checks `Ee?.method !== "readMcpAppResource" || Ee.args.documentSha256 == null` | PROVEN |
| `callMcpAppTool` carries a **`userActivated`** boolean | `coordinator.beauty.js:34368` | PROVEN |
| A tool call with `serverId < 0` is treated as an unavailable server | `Oce(e) { return e < 0; }` at `main-app.beauty.js:66387` | PROVEN |

> **`userActivated` is the strongest single design fact in the MCP section.** Combined with the injected
> activation reporter (§5.5), it means **an MCP App cannot call a tool purely because its script ran**; the
> host can require that a real user gesture happened inside the app frame. That is the correct defence
> against a malicious MCP App enumerating tools and firing them at load time.

## 5.3 OAuth

```js
// recon/beautified/main-app.beauty.js:474-484, abridged
      (Ib = "https://www.cursor.com/agents/mcp/oauth/callback"),
      (Qpe = "grokbot://mcp/oauth/callback"),
      (rs = "http://localhost:8787/callback"),
      (Gpe = "gb"), (Vpe = "gw"), (bx = "gd"), (Fz = "x-cursor-mcp-oauth-relayed-loopback"),
      (Hpe = "xa"), (Bz = ".t"),
      (uh = [18787, 28787, 31787]));
    ((jpe = `${Bz}${bx}`),
      (GSt = new Map([[Gpe, Qpe], [Vpe, Dz], [bx, rs], [Hpe, Nz], ...uh.map((e) => [`${bx}${e}`, vx(e)])])));
```

| Fact | Evidence | Tag |
|---|---|---|
| Five redirect strategies exist, keyed by a short two-character mode code | `Gpe="gb"`, `Vpe="gw"`, `bx="gd"`, `Hpe="xa"`, and `gd<port>` for three fallback ports | PROVEN |
| Redirect targets: `grokbot://mcp/oauth/callback` (custom scheme), `https://grok.com/connectors-oauth-exchange-code/`, `https://x.com/i/connectors/oauth_callback`, `http://localhost:8787/callback`, and loopback on `18787`/`28787`/`31787` | `Qpe`, `Dz` (`342`), `Nz` (`343`), `rs`, `uh` | PROVEN |
| A custom header marks a loopback callback that was relayed through the backend | `Fz = "x-cursor-mcp-oauth-relayed-loopback"` | PROVEN |
| `cursor://anysphere.cursor-mcp/oauth/return` is another registered redirect | `QSt = \`cursor://${Upe}${Fpe}\`` with `Upe = "anysphere.cursor-mcp"`, `Fpe = "/oauth/return"` | PROVEN |
| Loopback redirect URIs are validated as **HTTP on a loopback hostname with an explicit port** | `` _w(e) { if (e.protocol !== "http:" || !_yn(e.hostname)) throw new Error("MCP OAuth redirect_uri must be a loopback HTTP URL."); let t = Number.parseInt(e.port, 10); if (!Number.isInteger(t) \|\| t <= 0) throw new Error("MCP OAuth redirect_uri must include a port."); return { port: t }; } `` at `main-app.beauty.js:54333-54338` | PROVEN |
| The accepted loopback hostnames are `"localhost"`, `"127.0.0.1"`, `"::1"` and `"[::1]"` | `_yn(e) { return e === Syn \|\| e === bw \|\| e === "[::1]" \|\| e === "::1"; }` at `54323` (with `bw = "app"` reused and `Syn` the `127.0.0.1` literal) | PROVEN |
| The callback listener claims the port on several candidate hosts, not just one | `hyn(e)` iterates `e.hosts` and matches a fixed body `Fnt`; `Ayn(e)` iterates hosts and validates `state` via `Hnt` | `54302-54321` | PROVEN |
| Callback query parsing requires `state` (bounded length `lyn`), accepts either `code` or `error`, and enforces a **pathname match plus a maximum query length** (`cyn`) and a `GET` | `Hnt` at `54305-54312`; `byn` at `54339-54349` | PROVEN |
| Discovery uses RFC 9728 protected-resource metadata | `` `${n.origin}/.well-known/oauth-protected-resource${n.pathname.replace(/\/+$/, "")}` `` at `main-app.beauty.js:53288`, with an in-memory cache keyed by URL and an expiry `Kgn` | PROVEN |
| Dynamic client registration is supported | `registration_endpoint` and `redirect_uris: Me(io)` in the DCR schemas at `main-app.beauty.js:57155-57222` | PROVEN |
| PKCE is advertised/negotiated | `code_challenge_methods_supported: Me(V()).optional()` at `main-app.beauty.js:57169` | PROVEN |
| `authenticateMcpServer` args include an outcome enum `connected | cancelled` and a requesting agent id | `RK = w({serverId, serverName, accountKey, serverIdentifier?, serverUrl?, requestingAgentId?, outcome: _e("auth outcome", ["connected","cancelled"])})` at `coordinator.beauty.js:34131-34140` | PROVEN |
| An auth callback arriving on the deep link is routed into the MCP manager and can be **accepted or rejected** | `main-app.beauty.js:98113-98117` (`noteAuthCallbackReceived(g)` / `noteAuthCallbackRejected(g)`) | PROVEN |
| The backend RPC is `CompleteMcpOAuthRequest{stateId, authorizationCode}` | `main-app.beauty.js:96182` | PROVEN |

### The static connector registry

Grok Bot ships a **hard-coded** host→provider map for first-party connectors, including their OAuth scopes:

| Host | Provider | Notable config | Evidence |
|---|---|---|---|
| `gmailmcp.googleapis.com` | `google-workspace` | `gmail.readonly`, `gmail.compose`, `gmail.modify` | `main-app.beauty.js:388-399` |
| `drivemcp.googleapis.com` | `google-workspace` | `drive.readonly`, `drive.file` | `400-405` |
| `calendarmcp.googleapis.com` | `google-workspace` | 4 calendar scopes | `406-415` |
| `docsmcp.googleapis.com` / `sheetsmcp.googleapis.com` / `slidesmcp.googleapis.com` | `google-workspace` | `documents` / `spreadsheets` / `presentations` | `416-418` |
| `bigquery.googleapis.com` | `google-workspace` | `bigquery` | `419` |
| `api.x.com` | `x` | 17 scopes incl. `dm.read`, `dm.write`, `developer.write`, `offline.access`; `pinsScopesOverConfiguredScopes: !0` | `420-446` |
| `mcp.money-dev.x.com`, `mcp.money-staging.x.com`, `mcp.money.x.com` | `x-money` | `backendOnlyTokenExchange: !0` | `447-449`, `349-355` |
| `connectors-gateway.grok.gcp.mouseion.dev`, `connectors-gateway.grok.com` | `grok-connectors` | scopes `grok-plugins:access`, `offline_access` | `455-456`, `364-371` |
| `mcp.hubspot.com` | `hubspot` | `backendOnlyTokenExchange: !0` | `457`, `358-363` |
| `setup.shopify.com` | `shopify` | `unauthenticatedConnect: !0`, `rejectsCustomSchemeRedirects: !1` | `458-466` |

Shared defaults: `clientRegistration: "static"`, and for Google `authorizationParams: { access_type: "offline", prompt: "select_account consent" }` with `unauthenticatedConnect: !0` and
`rejectsCustomSchemeRedirects: !0` (`main-app.beauty.js:344-353`). **PROVEN** for all.

**INFERRED:** `rejectsCustomSchemeRedirects: true` for Google/hubspot/x-money versus `false` for X and
Shopify explains the multi-mode redirect map above (`gb`/`gw`/`gd`/`xa`): the app must pick a redirect
strategy per provider, and hosts that reject custom schemes are forced onto the HTTPS or loopback paths.

## 5.4 `sand-mcp-app:` — the MCP App iframe protocol

```js
// recon/beautified/main-core.beauty.js:20336-20366, abridged
var gc = "sand-mcp-app", bw = "app", Kl = new Map(), tne = 32;
function xw(e) {
  let t = (0, LT.randomUUID)(), n = (0, LT.randomUUID)();
  for (Kl.set(t, { html: Aw(e.html, e.csp, n), csp: wT(e.csp) }); Kl.size > tne;) {
    let r = Kl.keys().next();
    if (r.done === !0) break;
    Kl.delete(r.value);
  }
  return { frameUrl: `${gc}://${bw}/${t}`, bridgeKey: n };
}
function nne(e, t) {
  if (!t()) return new Response(null, { status: 404 });
  let n;
  try { n = new URL(e.url); } catch { return new Response(null, { status: 400 }); }
  let r = n.pathname.replace(/^\/+/, ""), o = Kl.get(r);
  return o === void 0
    ? new Response(null, { status: 404 })
    : new Response(o.html, { status: 200,
        headers: { "content-type": mc, "content-security-policy": o.csp, "cache-control": "no-store" } });
}
function MT(e) { let t = URL.parse(e); return t?.protocol === `${gc}:` && t.host === bw; }
function vw(e, t) { return t != null && URL.parse(t)?.protocol === `${gc}:` && !MT(e); }
function Iw(e) { Rw.protocol.handle(gc, (t) => nne(t, e.isEnabled)); }
function Cw(e) { return () => e()?.checkFeatureGate("sand_mcp_apps", { disableExposureLog: !0 }) ?? !1; }
```

| Fact | Evidence | Tag |
|---|---|---|
| Frame URL shape is `sand-mcp-app://app/<uuid-v4>` | `xw` + `MT` | PROVEN |
| The document id is a **random UUID**, not derived from the server or resource — an app document is not addressable across app restarts | `(0, LT.randomUUID)()` | PROVEN |
| A second random UUID is minted as a **`bridgeKey`** — a per-document secret for the `postMessage` bridge | `xw` returns `{frameUrl, bridgeKey}` | PROVEN |
| Staged documents live in an in-memory `Map` capped at **32** entries, evicted FIFO (`Kl.keys().next()`) | `Kl`, `tne = 32`, the eviction loop | PROVEN |
| Only the **staged HTML** is served — the protocol never reads from disk or from the network | `nne` returns `o.html` | PROVEN |
| The response sets a **per-document `content-security-policy` header** *and* an equivalent `<meta>` tag | `headers: {"content-security-policy": o.csp}` and `Aw` injecting the meta | PROVEN |
| `cache-control: no-store` prevents a revoked app document from being served from cache | `nne` | PROVEN |
| A disabled feature gate turns **every** request into `404` (not `403`) | `if (!t()) return new Response(null, {status:404})` | PROVEN |
| A malformed URL returns `400`; an unknown id returns `404` | `nne` | PROVEN |
| Leading slashes are stripped, so `sand-mcp-app://app///<uuid>` resolves to the same entry | `n.pathname.replace(/^\/+/, "")` | PROVEN |
| `vw(e, t)` detects a **popup** case: the *referrer* is an mcp-app URL but the current URL is not — used to distinguish a popup opened from an app from the app itself | `vw` + call sites at `main-core.beauty.js:28682-28688` (`will-frame-navigate` handling) | PROVEN |
| The whole subsystem is gated on `sand_mcp_apps`, which **defaults to `false`** | `main-app.beauty.js:48431`; `Cw` above | PROVEN |
| Requesting an app while the gate is off raises a typed error with a literal message | `if (!e.mcpApps.isEnabled()) throw new st({ code: Zqe, detail: "MCP Apps are behind the sand_mcp_apps gate." });` at `main-app.beauty.js:94054` | PROVEN |
| An app document is capped at **8 MiB** | `DT = 8 * 1024 * 1024` at `main-core.beauty.js:20103`; error helper `yw()` → `` `This MCP App document is larger than ${DT / (1024 * 1024)} MiB.` `` and code `hw = "mcp_app_saved_page_unavailable"` at `20106-20108` | PROVEN |
| A separate `256 KiB` constant `qBe` sits next to `DT` — most plausibly the saved-page/sidecar limit | `qBe = 256 * 1024` at `20102` | INFERRED |

## 5.5 The injected bridge scripts

Every staged MCP App document is assembled as
`<!DOCTYPE html><meta CSP>{activation script}{resize script}{author HTML}` by `Aw`
(`main-core.beauty.js:20330-20333`). The two scripts are string constants.

**(a) The resize reporter** (`Zte`, `main-core.beauty.js:20203-20265`): measures the document height from
five independent signals (`body.scrollHeight`, `body.offsetHeight`, `documentElement.offsetHeight`, a
device-pixel-rounded `getBoundingClientRect().height`, and `scrollHeight > clientHeight ? scrollHeight : 0`),
takes the max, and reports changes to `window.parent` via `postMessage(..., "*")`. It implements hysteresis:
it refuses to shrink while the parent has not yet applied the smaller height (`refusedHeight`, `shrunkTo`).

**(b) The activation reporter** (`ene`, `main-core.beauty.js:20266-20306`):

```js
// recon/beautified/main-core.beauty.js:20267-20283, abridged — the non-activating key list
  Qte = ["Escape","Alt","AltGraph","CapsLock","Control","Fn","FnLock","Hyper","Meta","NumLock",
         "ScrollLock","Shift","Super","Symbol","SymbolLock"];
```

and the script itself binds:

```js
// recon/beautified/main-core.beauty.js:20285-20306, abridged
	const activation = navigator.userActivation;
	const isActive = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(activation), "isActive").get;
	const keyOf = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, "key").get;
	const timeStampOf = Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp").get;
	const timeOrigin = performance.timeOrigin;
	post({ jsonrpc: "2.0", method: ${Km(Kte)} }, "*");          // Kte = "ui/notifications/sandbox-document"
	const reportIfActive = (event) => {
		if (!event.isTrusted || !apply(isActive, activation, [])) return;
		post({ jsonrpc: "2.0", method: ${Km($te)},          // $te = "ui/notifications/sandbox-activation"
		       params: { key: ${Km(e)}, activatedAtMs: timeOrigin + apply(timeStampOf, event, []) } }, "*");
	};
	addEventListener("pointerdown", reportIfActive, { capture: true, passive: true });
	addEventListener("pointerup",   reportIfActive, { capture: true, passive: true });
	addEventListener("keydown", (event) => {
		if (nonActivatingKeys[apply(keyOf, event, [])] !== true) reportIfActive(event);
	}, { capture: true, passive: true });
	script?.remove();
```

| Fact | Evidence | Tag |
|---|---|---|
| The bridge is **JSON-RPC 2.0 over `postMessage`** with `targetOrigin: "*"` | the `post({jsonrpc:"2.0", method, params}, "*")` calls | PROVEN |
| Two notification methods are defined: `ui/notifications/sandbox-document` (on load) and `ui/notifications/sandbox-activation` (on a genuine activation) | `Kte`, `$te` at `20104-20105`; used in `ene` | PROVEN |
| Activation is verified with `event.isTrusted` **and** `navigator.userActivation.isActive`, resolved through saved property getters so the app cannot trivially monkey-patch them | `apply(isActive, activation, [])`, `Object.getOwnPropertyDescriptor(...).get` | PROVEN |
| `activatedAtMs` is computed as `performance.timeOrigin + event.timeStamp` — a **shared, monotonic-ish clock readable by the host** | `timeOrigin + apply(timeStampOf, event, [])` | PROVEN |
| Modifier-only and lock keys do **not** count as activation (15 keys) | `Qte` list | PROVEN |
| The injected script removes its own `<script>` element after install, so app code cannot re-read it | `script?.remove()` | PROVEN |
| `Km(e)` escapes `<` as `\u003c` in the interpolated key literal, preventing a script-tag break-out | `Km` at `main-core.beauty.js:20260-20262` | PROVEN |
| Both scripts bind `addEventListener` with `{capture: true, passive: true}`, so they observe without being cancellable by app code that stops propagation later in the bubble phase | `ene` and `Zte` | PROVEN |

> **Security assessment (PROVEN facts).** The activation bridge is well-constructed: trusted-event and
> `userActivation` checks, saved getters, capture-phase passive listeners, self-removal, and `<` escaping.
> The notable weakness is `targetOrigin: "*"` on the app→host direction: the app posts to any origin. That
> is largely harmless *outbound* (the app is in an opaque origin and the parent is fixed), but it means the
> host must validate `event.source` and cannot rely on origin matching, and the `bridgeKey` exists precisely
> because origin is unavailable. **Whether the host actually validates `bridgeKey` on inbound messages is
> not visible at the protocol-handler layer and remains UNKNOWN.**

## 5.6 Trays

```js
// recon/beautified/main-app.beauty.js:41232-41234
          getTrays: I().noArgs,
          dismissTray: I().args({ id: (0, p.rpcString)() }),
          clearTrays: I().noArgs,
```

| Method | Auth class | Evidence |
|---|---|---|
| `getTrays` | `background` | `main-app.beauty.js:74300` |
| `dismissTray` | `person` | `main-app.beauty.js:74301` |
| `clearTrays` | `person` | `main-app.beauty.js:74302` |

| Claim | Tag | Reasoning |
|---|---|---|
| A "tray" is an **accumulated, id-addressable collection of pending items** surfaced to the user: `getTrays` returns them all, `dismissTray({id})` removes one, `clearTrays` removes all | PROVEN | The three-method shape (list-all / remove-one / remove-all) is exactly a notification-tray API; the presence of `dismissTray` taking a single id is only meaningful if there are several concurrently |
| Trays are **read** without user presence (`background`) but **dismissed** only with it (`person`) — i.e. an agent can raise tray items unattended but cannot make them disappear | PROVEN | auth table |
| A tray item is not a widget, a form or a card: everything else in that region of the API has its own `respondToWidget` / `submitUserForm` / `resolveAutoReviewApproval` handler, whereas trays have only dismissal — they are **informational** | INFERRED | comparison of neighbouring methods at `main-app.beauty.js:41230-41245` |
| Tray contents (the element type) are **UNKNOWN** — no schema or `rpcObject` shape for a tray item was found; the coordinator's reply type is only `record` / `"record"` (`coordinator.beauty.js:36916`, similar entries) | UNKNOWN | — |

**INFERRED:** the closest user-facing analogue in the string catalog is the approval/status cluster
(`"Waiting for you"`, `"Only comes back when your approval is needed"`), suggesting trays are where a
background agent parks "here are the things that need you" items so the user's attention is batched rather
than interrupted. This is consistent with the app-store positioning quoted in `FINDINGS.md:126`.
