# Grok Bot — Web Automation & Device Integrations

Reverse-engineering dossier, section 04. Target: **Grok Bot** desktop, Electron bundle
`com.anysphere.sand` v0.71.2 (internal codename **sand**), by Anysphere / xAI. Backend host literal
`api2.cursor.sh`; realtime voice origin `wss://api.x.ai/`.

---

## Scope & method

**In scope.** How Grok Bot (the "host") reaches outside its own process: how it drives a browser, how it
carries a signed-in session there, how its egress is shaped, how it renders agent artifacts, how it hosts
MCP servers and MCP Apps, how it runs voice calls, how it binds to messaging platforms, how it presents a
remote desktop, and how it moves attachments and media.

**Evidence base.**
| Artifact | Size | Role here |
|---|---|---|
| `recon/FINDINGS.md` | 128 lines | Prior recon — treated as hypotheses to re-verify, not ground truth |
| `recon/rea/coordinator-methods.json` / `.txt` | 172 methods | RPC inventory with authz class (`background` / `person`) |
| `recon/beautified/main-core.beauty.js` | 1.19 MB / 41,314 lines | Protocol registration + handlers, webview hardening, proxying |
| `recon/beautified/main-app.beauty.js` | 3.67 MB | Desktop wiring, box/VNC, MCP manager, connectors, canvas, computer use |
| `recon/beautified/node-agent-coordinator.beauty.js` | 1.23 MB | Coordinator RPC schemas, protobuf descriptors, voice/MCP/channel/secret handlers |
| `recon/beautified/preload.beauty.js` | 140 KB | `contextBridge` surface, coordinator port claim, env exposure |
| `recon/beautified/preload-webview.beauty.js` | 8.7 KB / 338 lines | Browser-webview preload (read in full) |
| `recon/beautified/preload-vnc.beauty.js` | 56 KB / ~1,950 lines | noVNC preload / remote-desktop bridge |
| `recon/beautified/local-exec-daemon.beauty.js` | 5.0 MB | `computer_use_*` tool surface, local-exec settings, protobuf messages |
| `recon/grokbot-0.71.2/dist/renderer/assets/` | 588 files | Renderer feature chunks (filename inventory = feature inventory) |
| `recon/rea/projection-boundaries.json`, `projection-summary.json` | 289 KB | Electron boundary observations; REA limitations |
| `/Applications/Grok Bot.app/Contents/Info.plist` | — | ATS posture, usage descriptions, asar integrity |

**Method.** (1) Read `FINDINGS.md` first. (2) Locate each subsystem by exact string literal, then read a
contiguous window around every hit rather than sampling. (3) Cite `file:line` for every non-obvious claim —
line numbers refer to the **beautified** files under `recon/beautified/`, never to the shipped minified
bundles under `recon/grokbot-0.71.2/dist/**`, whose line numbers differ completely. (4) Prefer exact
minified literals; where a symbol is one or two letters it is a **minifier artifact** with no semantic
meaning — only quoted strings, regexes, numeric constants and protobuf field descriptors survive
minification and are therefore evidence. (5) Tag **PROVEN** (the cited bytes say it) / **INFERRED**
(reasoning stated) / **UNKNOWN**.

**Standing caveats.**
| # | Caveat |
|---|---|
| C1 | All bundles are **minified**; prettier restored formatting only. Identifiers such as `zl`, `gc`, `Rw`, `No`, `JAt` are meaningless. |
| C2 | This is **static** analysis. A string's presence proves the string exists at that offset; it does **not** prove the path executes, nor that a feature is enabled for any user. Several subsystems sit behind gates; at least one defaults to *off*. |
| C3 | REA's analysis **crashed** on `dist/electron-main/main-app.cjs` — `"Maximum call stack size exceeded"` (`recon/rea/projection-summary.json`, limitations[12]) — and declares coverage **partial**. Absence in REA is not absence in the product. |
| C4 | **No source maps ship** (`FINDINGS.md:43`), so original TypeScript names and paths are unrecoverable — except where the error registry leaks them (Appendix B). |
| C5 | `main-app.beauty.js` is a flattened `workspace:*` monorepo; module boundaries are erased except for Sentry `debugId` strings and chunk filenames. |
| C6 | Feature-gate defaults below are **client-side fallbacks** (`fallbackValues`), overridden by the server. A gate showing `default: !1` may be enabled in production. |

---

## Executive summary — five architectural facts

1. **There is no Playwright/Puppeteer/CDP automation stack.** The only DevTools-Protocol-shaped code drives
   **Node's own inspector** (`await import("node:inspector")`, `main-core.beauty.js:36405`). The real
   surfaces are an in-app Electron **`<webview>`** (`webviewTag: !0`, `main-core.beauty.js:28648`), a
   **remote VM desktop rendered as images over noVNC**, and a **macOS computer-use tool surface**
   (`computer_use_screenshot` … `computer_use_check_permissions`, `local-exec-daemon.beauty.js:104058-104094`). §1
2. **"Log in once" is a vault + target-rule + just-in-time per-origin human approval system**, not a stored
   password. Pieces: `GrokBotVaultCredential` (with CARD/CONTACT variants), `CredentialTargetRule{kind:
   EXACT_HOST_PORT | REGISTRABLE_DOMAIN}`, a 1Password broker reached via a signature-verified native
   launcher, a CTAP2 passkey ceremony backed by `sand-webauthn-signer`, and `resolveVirtualCardApproval`
   for agent-initiated spend. §2
3. **Egress is deliberately re-shaped.** A system-proxy resolver mirrors the OS proxy into children via
   `SAND_NODE_PROXY_ENV`; a per-box **egress tunnel** runs on ports 8790/8791 and can be claimed/toggled;
   the box routes inbound traffic through a host gateway on 1340; and macOS ATS is set to
   `NSAllowsArbitraryLoads = true`. §3
4. **Artifacts are a first-class, scheme-addressed, individually-CSP'd document type.** `sand-canvas://frame/<id>`
   with a strict URL grammar, `/user/<id>` and `/store/<storeId>/<id>` locators, a 32 MiB LRU content cache,
   and an iframe sandbox of exactly `allow-scripts allow-popups allow-popups-to-escape-sandbox`. MCP Apps
   get a different scheme, a generated per-document CSP, and two injected `postMessage` bridge scripts. §4, §5
5. **A voice call is not a text thread with audio.** It is a realtime WebSocket to `wss://api.x.ai/` with an
   ephemeral `client_secret`, a **server-supplied** tool list and greeting, `SAND_VOICE_HARNESS` selecting
   `backend` or `package` mode, and a six-stream recorded transcript committed back to the thread. §6

---

# 1. Browser automation architecture

## 1.1 Which technology it is *not*

| Candidate | Evidence | Verdict |
|---|---|---|
| Separate Chromium over CDP | `webSocketDebuggerUrl`, `Target.getTargets`, `Page.navigate`, `remote-debugging-port`: **0 hits** in `main-app`, `main-core`, `coordinator` | Ruled out (PROVEN by absence) |
| Playwright / Puppeteer | `puppeteer`: 0 hits. `playwright`: 8 hits, only substantive one is the flag `playwright_mcp_provider: { client: !0, default: !0 }` at `main-app.beauty.js:48806` | Ruled out as driver; an MCP *provider* for Playwright may be offered (INFERRED) |
| `BrowserView` | `"browser_view"` appears once, inside the Chromium surface-type enum `Qh = ["background_page","browser_view","remote","webview","offscreen","unknown"]` at `main-core.beauty.js:14846` — neighbours are `["crashed","oom",…]` and `["gpu","zygote","sandbox_helper",…]` | Enum member, not an API call site (PROVEN) |
| In-app `<webview>` | `webviewTag: !0` (`main-core.beauty.js:28648`); `will-attach-webview` handler (`main-app.beauty.js:108051`); `preload-webview.cjs` (`main-app.beauty.js:107942`) | **PROVEN — this is the browser surface** |
| Cloud browser | No such client. What exists is a cloud **VM desktop** viewed over noVNC (§8) and a *cloud agent* concept about deploying agent apps | Ruled out (INFERRED) |
| CDP-shaped debugging | `Debugger.enable`, `Debugger.resume`, `Debugger.setPauseOnExceptions`, `Runtime.getProperties` — but the session comes from `await import("node:inspector")` | **Node.js Inspector, not CDP-against-Chrome** (PROVEN) |

> **Correction to `FINDINGS.md:111`.** That line lists `Debugger.enable` / `Debugger.setPauseOnExceptions`
> as if they were browser-automation CDP. They are a `node:inspector` wrapper used to capture stack traces
> from Grok Bot's *own* workers:
```js
// recon/beautified/main-core.beauty.js:36403-36420, abridged
    static async create(t) {
      if (t) return t;
      let n = await import("node:inspector");
      return new e(new n.Session());
    }
    configureAndConnect(t, n) {
      this._session.post("Debugger.enable"),
      this._session.post("Debugger.setPauseOnExceptions", { state: n ? "all" : "uncaught" }));
```
The adjacent helpers (`getLocalVariables`, `Runtime.getProperties`, `_unrollArray`, `_unrollObject`) and the
log line `"Pausing debugger to capture stack trace"` (`main-core.beauty.js:38432`) identify this as
error-report variable capture, next to `"Failed to start worker"` / `"Failed to start inspector"`
(`main-core.beauty.js:36359-36369`). **PROVEN** for the import; INFERRED for the purpose.

## 1.2 The browser is a hardened `<webview>`
```js
// recon/beautified/main-core.beauty.js:28635-28649, abridged
      webPreferences: {
        additionalArguments: [...d.additionalArguments],
        contextIsolation: !0,
        nodeIntegration: !1,
        preload: Ng.default.join(JA, Ig({ isPackaged: ar.app.isPackaged, devCapability: n })),
        sandbox: !0,
        v8CacheOptions: m1(o),
        webviewTag: !0,
      },
```
| Fact | Evidence | Tag |
|---|---|---|
| `webviewTag` enabled; host window has `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` | `main-core.beauty.js:28648-28654` | PROVEN |
| Preload dir `dist/electron-preload`; host preload `preload.cjs`; document `renderer/index.html` | `main-core.beauty.js:28604-28605` | PROVEN |
| Every attached webview is **re-hardened from the main process**, overriding the renderer's request | `main-app.beauty.js:108052` | PROVEN |
| The preload is chosen by **session partition**, not by URL or a renderer flag | `main-app.beauty.js:108053` (`z.partition === iz`) | PROVEN |
| Privileged partition is `persist:sand-forever-box`; it gets `preload-vnc.cjs`, all others `preload-webview.cjs` | `main-app.beauty.js:107924`, `107943-107944`, `108055` | PROVEN |
| Non-`http:`/`https:`/`about:` sources have their `src` **deleted** | `main-app.beauty.js:108060-108062` | PROVEN |
| The whole `will-attach-webview` handler is three assignments plus a partition test — no URL-, origin- or options-based branching | `main-app.beauty.js:108051-108065` | PROVEN |

A privileged IPC edge is gated on the webview's *derived* identity, not on anything the renderer claims:
```js
// recon/beautified/main-app.beauty.js:107904-107910, verbatim
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
| The `box-vnc` RPC namespace exposes exactly `readClipboard` (no args) and `writeClipboard({text})` | `main-app.beauty.js:107898-107900` | PROVEN |
| Access requires the sender's **session** to be the box partition *and* its **frame URL** to pass a second predicate | `main-app.beauty.js:107899-107901` | PROVEN |
| Identity comes from `sender.session` / `senderFrame?.url` supplied by Electron, not from arguments | `main-app.beauty.js:108070-108072` | PROVEN |
| The second predicate accepts only a VNC page (`/vnc.html`) that is loopback or an origin already seen on the partition | `main-app.beauty.js:107938-107941` | PROVEN |
| Denial is reported as `reportDesktopEdgeFailureClass("box-vnc","trust-denial", <trust>:<method>)` | `main-app.beauty.js:107918-107931`, `108079-108081` | PROVEN |
| The backend just calls Electron `clipboard.readText()` / `writeText()` | `main-app.beauty.js:108076-108080` | PROVEN |

## 1.3 The webview preload, in full

338 beautified lines, 8.7 KB, and **no `contextBridge` API at all** — it is a pure agent. The browsed page
gains nothing; the host gains signals.
| # | Behaviour | Key literals | Line |
|---|---|---|---|
| 1 | Mouse back/forward interception | channel `"sand:mouse-history-navigation"`; button `3 → -1`, `4 → +1`; requires `isTrusted !== false` | `preload-webview.beauty.js:106-135` |
| 2 | `navigator.permissions.query` polyfill returning `state: "granted"` for `local-network-access` / `local-network` — **only** on an IdP allowlist | `permissions.__sandLocalNetworkPolyfill`; synthetic `EventTarget` | `187-216` |
| 3 | WebAuthn stall detection wrapping `credentials.create`/`.get` | policy `"sand-webview-passkey-stall"`, `timeoutMs: 6e4`, channel `"sand:browser-passkey-stalled"`, error `DOMException("Passkey request stalled","NotAllowedError")` | `225-265` |
| 4 | Dialog stubs | `alert = ()=>{}`, `confirm = ()=>true`, `prompt = ()=>null`, guarded by `window.__sandDialogOverridesApplied` | `266-277` |
| 5 | Lifecycle reporting | `"sand:browser-popup-closed"` `{url}`, `"sand:browser-origin-return"` `{origin, currentUrl}` | `278-301` |
```js
// recon/beautified/preload-webview.beauty.js:150-160, verbatim
var P = [
  ".okta.com", ".okta-emea.com", ".oktapreview.com", ".duosecurity.com",
  ".login.microsoftonline.com", ".onelogin.com", ".auth0.com", ".pingidentity.com", ".rippling.com",
];
```
| Claim | Tag | Reasoning |
|---|---|---|
| Behaviour 2 is installed only when `location.hostname` **ends with** one of those nine suffixes (line 184) | PROVEN | `e.endsWith(P[r])`, called from `G()` at 187-189 |
| On those pages the site is told a `local-network-access` grant exists though none was requested | PROVEN | synthetic status with `state: {value: "granted"}`, `onchange: {value: null, writable: true}` |
| Scope is narrow: only two descriptor names, original preserved otherwise, install is idempotent | PROVEN | `return originalQuery(descriptor)`; `__sandLocalNetworkPolyfill` guard |
| It is a workaround for SSO/device-trust probes, not a general bypass — every host is an IdP vendor plus Rippling | INFERRED | the allowlist is exclusively identity/HR platforms |
| **Security implication:** a page on those nine domains can falsely believe it holds a local-network grant, and cannot distinguish the synthetic status object from a real one | INFERRED | — |
| Behaviour 3 does **not** implement WebAuthn — it *times out* it and reports the stall, letting the host trigger the remote signer (§2.4) while the page gets a standard `NotAllowedError` | PROVEN for the mechanism; INFERRED for the host reaction | `x()` at `138-144` rethrows `DeadlineExceededError` (`code: "deadline_exceeded"`) after `reportStall` |

## 1.4 What the renderer actually renders

Of 588 renderer chunks, only **two** contain the token `webview`:
| File | Content | Tag |
|---|---|---|
| `index.eager-app-DSuGVQNC.js` | `upe = "webview, iframe"` — a **CSS selector list** in a copy/selection helper, beside `lpe = ".sand-message-prose, .sand-message-content"` | PROVEN |
| `chunk-teach-recording-controls-CQ4-Ikje.js` | real `jsx("webview", { ref, src, tabIndex, webpreferences })` plus a memo helper `ss(n){const e=Ue(n.src,n.isInteractive,!1); return e===n.url?n:{…}}` | PROVEN |

**INFERRED:** the only user-visible `<webview>` surfaces are the teach-recording/replay view (the "follow
along once, then it runs itself" feature) and the box-desktop modal (§8). The agent's own browsing is not
rendered as a `<webview>` in the main window.

## 1.5 Where the agent's browsing happens — three mechanisms

| Mechanism | Where it runs | Tool surface | Evidence |
|---|---|---|---|
| **A. Box desktop** | A remote VM ("box"), displayed locally as noVNC **images** in a `<webview>` on `persist:sand-forever-box` | VNC input injection + clipboard edge | §1.2, §8 |
| **B. Host computer use** | The **user's own Mac** | `computer_use_screenshot`, `_click`, `_scroll`, `_mouse_move`, `_mouse_button`, `_drag`, `_typing`, `_press_key`, `_check_permissions` | `local-exec-daemon.beauty.js:104058-104094` |
| **C. In-app webview browsing** | The user's Mac, inside Grok Bot | host-side signals only; no DOM or JS channel | §1.3 |

### Mechanism B — the closest thing to browser automation

The exec daemon carries a `computer_use_args` / `computer_use_result` message pair registered under the
service token `"computer-use-executor"` (`local-exec-daemon.beauty.js:84451`, `84596-84601`), with the wire
positions declared inside the shared descriptors:
```text
// recon/beautified/local-exec-daemon.beauty.js:83178 (ExecServerMessage), excerpt — one line
…|20 fetch_args #13 message|21 record_screen_args #14 message|22 computer_use_args #15 message|23 write_shell_stdin_args #16 message|…|40 canvas_diagnostics_args #23 message|…|43 web_fetch_allowlist_precheck_args #26 message|…
// recon/beautified/local-exec-daemon.beauty.js:83243 (ExecClientMessage), excerpt — one line
…|20 fetch_result #15 message|21 record_screen_result #16 message|22 computer_use_result #17 message|…|40 canvas_diagnostics_result #25 message|…|43 web_fetch_allowlist_precheck_result #28 message|…
```
```js
// recon/beautified/local-exec-daemon.beauty.js:104058-104094, excerpt
    return this.callTool(e, "computer_use_screenshot", {});
    return this.callTool(e, "computer_use_click", { … });
    return this.callTool(e, "computer_use_drag", { button: r.button, path: r.path, modifier_keys: r.modifierKeys });
    return this.callTool(e, "computer_use_typing", { value: r });
    return this.callTool(e, "computer_use_press_key", { key: r.key, hold_duration_ms: r.holdDurationMs });
    return this.callTool(e, "computer_use_check_permissions", {});
```
| Fact | Evidence | Tag |
|---|---|---|
| Nine `computer_use_<verb>` tools with snake_case args | `local-exec-daemon.beauty.js:104058-104094` | PROVEN |
| `record_screen` is a **separate** tool (field 21 vs 22 in one descriptor) | `local-exec-daemon.beauty.js:83178` | PROVEN |
| There is a "Computer" **tool** and a `computerUse` **subagent**, both disabled when no handler is registered | `local-exec-daemon.beauty.js:84135`: *"Computer use is not enabled for this environment, so the Computer tool and the computerUse subagent cannot run here… (No computer-use handler is registered on this exec daemon.)"* | PROVEN |
| Gated per environment | same string; `computer_use_supported 8?` in `RequestContextEnv` at `local-exec-daemon.beauty.js:76826` | PROVEN |
| Input/screen access is **lease**-based and metered | metrics `computer_use.desktop_lease.check`, `computer_use.session.duration_ms`, `.action_count`, `.result`, `.action_kind` at `local-exec-daemon.beauty.js:103720-103733` | PROVEN |
| Computer use has its **own configurable model** | `computerUseModel` at `local-exec-daemon.beauty.js:69539`, `69644`, `70056-70065`; `node-agent-coordinator.beauty.js:33989` | PROVEN |
| macOS requires **both** Accessibility and Screen Recording grants | `Omn = ["accessibility","screenRecording"]` at `main-app.beauty.js:93387`; `return e.accessibility && e.screenRecording` at `93388` | PROVEN |
| There is a native helper process (`helperName`) and a `macAccount` identity | `chunk-provider-computer-use-BvPQzCAR.js`; `main-app.beauty.js:93430` (`macAccount: (await o) ?? "unknown"`) | PROVEN |
| Individual applications can be **allowlisted and revoked** | `computer-use-permissions {id:"mmzR7e"}` / `computer-use-allowed-apps {id:"cLfYxG"}` in `chunk-provider-computer-use-BvPQzCAR.js`; `allowedApps` at `main-app.beauty.js:40622` | PROVEN |
| **Security implication:** those two grants plus a non-empty allowlist give full synthetic input and screen read over those apps; the only in-band gate is the local-tool-permission card (`ALLOW_ONCE | DENY | ALWAYS | NEVER`) | PROVEN for the enum; INFERRED for the mapping |

Related: `chunk-computer-screen-preview-LY_WYUeq.js` (26,139 B), `demo-computer-wallpaper-BO7Ye4dV.jpg`,
and a named network-diagnostic probe `computer-screen-websocket` that resolves `p.vncProxy?.primaryUrl`
and reports `screen-websocket-unavailable` / `screen-websocket-connected`
(`main-app.beauty.js:99047`, `99342-99348`). **INFERRED:** the box's websockify endpoint fronts both the
noVNC viewer and the computer-screen preview, so the user's on-screen image and the model's frames may share
one transport — consistent with ports 6080/6081 in §3.4.

## 1.6 Target discovery, session model, and the one JS-evaluation gate

With no CDP there is no protocol-level "target". What replaces it:
| Concept | Implementation | Evidence |
|---|---|---|
| Target | a `<webview>` identified by Electron session partition + frame URL | `main-app.beauty.js:107905-107907` |
| Session | `session.fromPartition("persist:sand-forever-box")` | `main-app.beauty.js:107924`, `108026` |
| Session hardening | `setVisualZoomLevelLimits(1,1)`, `setZoomFactor(1)` on `dom-ready` and `did-finish-load` | `main-app.beauty.js:108024-108033` |
| Navigation observation | `webRequest.onBeforeSendHeaders` + `onCompleted` on the partition | `main-app.beauty.js:108038-108046` |
| Input routing | `before-input-event` → `routeHostInput(z)` → `preventDefault()` | `main-app.beauty.js:108025-108027` |
| Page lifecycle | renderer-side noVNC class mutation → `{phase, clean}` | `preload-vnc.beauty.js:1696-1729` |

**PROVEN** for all five. The architectural consequence: **no page-object model, no DOM query channel, and
no JS-evaluation channel for the agent's browsed page.** Any claim that Grok Bot "uses CDP to script pages"
is unsupported.

Only two `executeJavaScript` call sites exist on webview-like frames, both narrow: the permissions polyfill
(`preload-webview.beauty.js:189`) and a "frame hold" script that defers rendering while the viewer is hidden
(`preload-vnc.beauty.js:1740-1744`). Separately, canvas frames get a gesture-gated external-link admission
check:
```js
// recon/beautified/main-core.beauty.js:28652-28677, abridged
var Hie = 1e3,
  jie = new Set(["http:", "https:", "mailto:", "tel:"]);
…
      admit(r) {
        let o = e.focusedFrame;
        if (o === null || !QT(o.url)) return !1;                 // QT: focused frame is sand-canvas:
        let a = n;                                               // n: timestamp of last trusted input
        if (((n = void 0), a === void 0 || yn(a, t.monotonicNow()) > Hie)) return !1;
        return jie.has(URL.parse(r)?.protocol);                  // jie = {http, https, mailto, tel}
      }
```
| Claim | Tag | Reasoning |
|---|---|---|
| A canvas frame may open an external link only after a **genuine, recent user gesture** (≤1 s) and only to `http`/`https`/`mailto`/`tel` | PROVEN | constants + the `admit` logic; exported as `attachSandCanvasLinkGate` (`main-core.beauty.js:39431`), installed at `main-app.beauty.js:108500` |
| This is a clickjacking / drive-by-navigation defence for agent-generated HTML | INFERRED | it applies specifically to `sand-canvas:` focused frames, where agent-authored content lives |

---

# 2. Session & identity injection — how "log in once" works

## 2.1 The model

Grok Bot does not hold one password per site. It holds a **vault** of credential items, each carrying
**target rules** describing which destinations the item may be used for, and it injects material into a
browsing context only after a **per-origin, human-visible approval** for the specific `(origin, profileId)`
pair. Three credential *classes* exist (login / card / contact), three *sources* exist (device Chrome
cookies, the 1Password app, Grok Bot's own passkey enrolment), and agent-initiated **spend** is a fourth,
separate ceremony.

## 2.2 The vault data model

Protobuf descriptors, format `MessageName|fieldNumber name typeCode` (all in `node-agent-coordinator.beauty.js`):
```text
GrokBotVaultCredential|1 id 9|2 title 9|3 username 9|4 notes 9|5 sites 9*|6 created_at_ms 3|7 updated_at_ms 3|8 card #0?|9 kind #1|10 contact #2?
GrokBotVaultCard|1 brand 9|2 last4 9|3 exp_month 5|4 exp_year 5|5 holder_name 9|6 billing_address #0?
GrokBotVaultCardBillingAddress|1 line1 9|2 line2 9|3 city 9|4 region 9|5 postal_code 9|6 country 9|7 name 9|8 phone 9
GrokBotVaultContact|1 address #0|2 default_shipping 8|3 email 9
CredentialTargetRule|1 kind #0|2 scheme 9|3 host 9|4 port 5|5 registrable_domain 9
PutGrokBotVaultCredentialRequest|1 id 9|2 title 9|3 username 9|4 notes 9|5 sites 9*|6 password 9
PutGrokBotVaultItemRequest|1 item #0|2 secret_fields 9,9
ListGrokBotVaultCredentialsRequest|1 include_kinds #0* ; …Response|1 credentials #0*
CreateGrokBotVaultCardRequest|1 values 9,9 ; UpdateGrokBotVaultCardRequest|1 id 9|2 holder_name 9|3 expiry 9|4 billing_address #0
GrokBotVaultItemKind :: UNSPECIFIED, LOGIN, CARD, CONTACT
CredentialTargetRuleKind :: UNSPECIFIED, EXACT_HOST_PORT, REGISTRABLE_DOMAIN
CredentialExpirationMode :: UNSPECIFIED, DISABLED, WARN, ENFORCE
CredentialLifecycleState :: UNSPECIFIED, ACTIVE, EXPIRING, GRACE, EXPIRED, PROVIDER_REJECTED
GrokBotCredentialRequestResolution :: UNSPECIFIED, APPROVED, DENIED
SandCredentialDecisionHarness :: UNSPECIFIED, BOX, TEMPORAL
```
| Fact | Evidence | Tag |
|---|---|---|
| Three item kinds: `LOGIN`, `CARD`, `CONTACT` | `GrokBotVaultItemKind` | PROVEN |
| A LOGIN carries `username`, `notes`, free-form `sites[]`, timestamps — and **no password field** | descriptor asymmetry: `GrokBotVaultCredential` has no password, `PutGrokBotVaultCredentialRequest` field 6 does, and `PutGrokBotVaultItemRequest` has a separate `secret_fields` **map** | PROVEN for the asymmetry; INFERRED that secrets live in the encrypted store (§2.6) |
| A CARD stores `brand`, `last4`, `exp_month`, `exp_year`, `holder_name`, full billing address — **never the PAN** | `GrokBotVaultCard` | PROVEN |
| Target rules are either an exact `scheme://host:port` or a whole registrable domain | `CredentialTargetRule` + its kind enum | PROVEN |
| Credentials expire under a policy and can be **rejected at the provider**, distinctly from local expiry | `CredentialExpirationMode`, `CredentialLifecycleState.PROVIDER_REJECTED` | PROVEN |
| Credential decisions are taken by a named harness — box or Temporal workflow engine | `SandCredentialDecisionHarness`; mirrors `GrokBotAgentHarnessKind :: BOX, TEMPORAL` | PROVEN |
| A request is approved/denied with `{agent_id, entry_id, resolution, session_id}` → `{accepted, refusal?}` | `ResolveGrokBotCredentialRequest{Request,Response}` | PROVEN |

## 2.3 Chrome cookie import — the actual "log in once" path

| Method | Auth class | Args | Evidence |
|---|---|---|---|
| `requestCookieOriginApproval` | `background` | `{requestId, origins: Array<{origin, profileId}>, agentId?}` | `node-agent-coordinator.beauty.js:32779`, `34206`; `_K` at `34116` |
| `awaitCookieOriginApproval` | `background` | `{requestId, waitMs}` | `node-agent-coordinator.beauty.js:32780`, `34207` |
| `cancelCookieOriginApproval` | `background` | `{requestId}` (also `noArgs` on the cancel path at `34727`) | `node-agent-coordinator.beauty.js:32781`, `34208` |
| `injectChromeCookies` | **`person`** | `{cookies: ChromeCookie[]}` | `node-agent-coordinator.beauty.js:32925`, `34424` |
```js
// recon/beautified/node-agent-coordinator.beauty.js:34116-34129, verbatim
  TK = w({
    name: p(), value: EK, domain: p(), path: p(), expires: ne(),
    httpOnly: Z(), secure: Z(),
    sameSite: A(_e("same-site policy", ["Strict", "Lax", "None"])),
    session: A(Z()),
    priority: A(_e("cookie priority", ["Low", "Medium", "High"])),
    partitionKey: A(Ve(p(), xt($x()))),
  }),
```
| Fact | Evidence | Tag |
|---|---|---|
| The injected cookie is a **full Chromium cookie**, including `httpOnly`, `secure`, `sameSite`, `priority` and a **`partitionKey`** (CHIPS / partitioned cookies) | above | PROVEN |
| `value` uses a distinct validator `EK` rather than plain `p()` — it is treated as a secret | `node-agent-coordinator.beauty.js:34118` | INFERRED |
| The approval unit is `(origin, profileId)` — **per Chrome profile**, so multi-profile users are asked per profile | `_K = Ve(p(), w({ origin: p(), profileId: p() }))` at `node-agent-coordinator.beauty.js:34115` | PROVEN |
| Approvals can be **raised** unattended (`background`) but injection cannot **complete** unattended (`person`) | auth table | PROVEN |
| Whole feature gated, default **off** | `sand_import_chrome_cookies: { client: !0, default: !1 }` at `main-app.beauty.js:48416`; *"Chrome cookie import is behind the sand_import_chrome_cookies gate."* at `93555` | PROVEN |
| The origin-grant sub-feature has a second gate | *"Cookie origin grants are behind the agent_prompted_cookie_sync gate."* at `main-app.beauty.js:93560` | PROVEN |
| Device-bound session cookies are recognised | `importIncludesDbscBoundHost(i)` at `main-app.beauty.js:93603` (`DBSC` = Device Bound Session Credentials) | PROVEN for the symbol; INFERRED for the expansion |

### How Chrome's file is read — the most sensitive mechanism here
```js
// recon/beautified/main-app.beauty.js:67655-67663, abridged
  aSt = 'tell application "Finder" to get name',
    name = "MacFinderAutomationPendingError";
      super("macOS Finder Automation is still off");
  await Jue("/usr/bin/osascript", ["-e", aSt], { timeout: 15e3 });
// recon/beautified/main-app.beauty.js:67718-67722, abridged
  name = "ChromeCookieImportPermissionError";
  constructor(t = "macOS Finder could not copy Chrome's cookie file") {
// recon/beautified/main-app.beauty.js:67824-67827
var dpe = "Chrome Safe Storage";
    constructor(t = "macOS denied Chrome Safe Storage") {
```
| Claim | Tag | Reasoning |
|---|---|---|
| Grok Bot reads Chrome's cookie DB by asking **Finder** (via `/usr/bin/osascript`) to copy it | PROVEN | the AppleScript probe, the 15 s timeout, and the default error *"macOS Finder could not copy Chrome's cookie file"* |
| It decrypts with the macOS Keychain item **`Chrome Safe Storage`** | PROVEN | `dpe = "Chrome Safe Storage"`; error *"macOS denied Chrome Safe Storage"* |
| The Keychain password can be supplied out-of-band, bypassing the prompt | PROVEN | `chromeImportSafeStoragePassword` from the environment → `safeStoragePassword` (`main-app.beauty.js:108123`, `68025`, `68031`, `68070`) |
| Flow: enumerate profiles → collect → filter by allowed `(origin, profileId)` → inject | PROVEN | `uniqueChromeCookieAllowProfileIds` → `collectProfileCookies` → `selectCookiesForAllowIds` → `injectChromeCookies` at `93588-93601` |
| Undecryptable cookies are **counted, not dropped silently** | PROVEN | `c += w.undecryptable` at `93595`; `undecryptable` is a `classifyChromeCookieImportSkip` field at `93608-93617` |
| The remedy string names all three required grants | PROVEN | key `xibDFX`: *"macOS is blocking Chrome cookies. Turn on Grok Bot in Privacy & Security → Full Disk Access and Automation (Finder), click Always Allow on Chrome Safe Storage, then retry."* (`main-core.beauty.js:20042`) |
| The app can deep-link to those panes | PROVEN | `OX = "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"`, `NX = "…?Privacy_Automation"` at `main-core.beauty.js:14403-14404`; exported as `MACOS_*_SETTINGS_URL` at `39691-39694` |

> **Security assessment (INFERRED).** The Finder-copy trick is a deliberate **TCC-avoidance** pattern:
> Finder already holds Full Disk Access on a stock Mac, so an AppleScript-mediated copy reads
> `~/Library/Application Support/Google/Chrome/**/Cookies` **without granting Grok Bot Full Disk Access**.
> Grok Bot asks instead for two narrower grants (Automation→Finder, and the Chrome Safe Storage keychain
> item). The trade-off is that Grok Bot becomes a scripted controller of Finder, and the resulting cookie
> set — including `httpOnly` and session cookies for every approved origin — ends up in Grok Bot's memory
> and is then pushed to the box. The consent boundary is the per-`(origin, profileId)` approval, behind a
> flag that defaults off.

### Approval UX literals

All from the compiled Lingui catalog on the single line `main-core.beauty.js:20042` (keys are content
hashes, not identifiers):
| Key | String | Meaning |
|---|---|---|
| `1Q+cpb` | `"The Bot wants to use your existing logins"` | approval card title |
| `MRaD32` | `"The user did not allow listing which local browser cookies are available."` | enumeration denied |
| `pLJubv` | `"No Chrome cookies match those origins."` | empty result |
| `KRzYIC` | `"Grok Bot is not open on this computer, so Chrome cookie approval cannot be shown."` | GUI required |
| `umduSc` | `"Chrome cookie approval could not be completed on this computer."` | failure |
| `9AT0Dv` | `"That account's saved sign-in is missing. Add the account again to use it."` | vault miss |
| `FS36gZ` / `pKu300` | `"The secure input could not write the credential to its store"` / `"Could not store the secret"` | `submitSecret` / `storeSecret` failure |
| `fXID+t` | `"Bot failed to resume after secret submission"` | the bot was blocked awaiting the secret |

## 2.4 WebAuthn / passkeys — the `sand-webauthn-signer` path

> `"A browser in your Grok Bot box is asking to sign in to ",["rpId"]," with the security key plugged into
> this computer. Approve only if you started this."` — key `ugATw1`, `main-core.beauty.js:20042`
| Fact | Evidence | Tag |
|---|---|---|
| The ceremony **originates in the box's browser**; the authenticator is the **user's local security key** | `ugATw1` above | PROVEN |
| The request forwards the raw WebAuthn options JSON | `requestWebAuthnCeremony: I().args(v$)` where `v$ = w({kind: N$, origin: p(), optionsJson: p()})` at `node-agent-coordinator.beauty.js:34208`, `34209` | PROVEN |
| The request is `background`-class; resolution is a separate `person` edge | `node-agent-coordinator.beauty.js:32782` | PROVEN |
| Ceremony kind and status are closed enums | `PasskeyCeremonyKind :: REGISTER, APPROVE, APPROVE_WITH_REGISTRATION`; `PasskeyCeremonyStatus :: PENDING, COMPLETED, FAILED, EXPIRED` | PROVEN |
| Signing is done by a **separate native binary** | `IE = process.platform === "win32" ? "sand-webauthn-signer.exe" : "sand-webauthn-signer"` at `node-agent-coordinator.beauty.js:3299` | PROVEN |
| Packaged path | `path.join(process.resourcesPath ?? "", "app.asar.unpacked", "dist", "native", IE)` — `node-agent-coordinator.beauty.js:3310-3314` | PROVEN |
| Dev paths are `<repoRoot>/target/release/<IE>` then `target/debug/<IE>` | same | PROVEN for the paths; INFERRED for "Cargo/Rust build" from the `target/release` layout |
| Spawned per request with `stdio: ["pipe","pipe","pipe"]`, newline-delimited JSON on stdin, events parsed from stderr lines prefixed `"[signer-event] "` | `node-agent-coordinator.beauty.js:3292-3294`; `TO = "[signer-event] "` at `3296`; stderr handler at `3389-3397` | PROVEN |
| Event vocabulary is fixed | `o0 = ["pin-blocked","pin-not-set","presence-required","select-device","uv-blocked","uv-invalid"]` at `3290`; plus `pin-required` / `pin-invalid` at `3330-3337` | PROVEN |
| PIN prompts are answered as `{kind:"pin", pin}` or `{kind:"cancel"}` on the same stdin pipe | `node-agent-coordinator.beauty.js:3359-3375` | PROVEN |
| Cancellation kills with `SIGTERM` and raises `NotAllowedError`, `code: "cancelled_or_timeout"`, message `"the security key request was cancelled"` | `node-agent-coordinator.beauty.js:3351-3362` | PROVEN |
| Fact | Evidence | Tag |
|---|---|---|
| A **proxy bridge** mediates the ceremony, with a provider registry | error registry cites `webauthn-proxy-bridge.ts requestCeremony`, `selectProvider empty registry`, `selectProvider live-resolve miss`, `provider.send throw`, `unattributed error settlement`; and `node-agent-coordinator/webauthn/provider.ts` with a `consent decline branch` and `signer error frames` | PROVEN |
| The box reaches the key through a **Unix socket inside the box** | `/run/sand-webauthn-proxy` and `` `${X8t}/credential` `` at `main-app.beauty.js:79037-79038` | PROVEN |
| CTAP2 PIN retry counting is implemented and surfaced | key `Sno38j`: `"That PIN was not accepted. # attempt(s) left before the key locks itself."`; plus `1mX2HI` `"Your security key is locked"`, `vrYX/k` `"Your security key's fingerprint check is locked"`, `IZuLG+` `"This security key has no PIN set, but the site asked for one"` | PROVEN for the strings; INFERRED that the counter is CTAP2's |
| The ceremony is also wired into **spend** approval | `GetPasskeyCeremonyResponse|1 kind #0|2 options_json 9|3 spend #1?`; `SpendApprovalAttestation|1 challenge_id 9`; `SpendApprovalCeremonyMode :: ASSERT, REGISTER`; `PasskeyCeremonyKind.APPROVE_WITH_REGISTRATION` | PROVEN |
| Other ceremony UI states exist | keys `fjHsol` `"Security key request"`, `Bi0+rD` `"Use your security key?"`, `GAbz2q` `"Touch your security key now"`, `FD44bW` `"Waking your security key…"`, `RjHsw+` `"Touch the security key you want to use"`, `DEuljI` `"Enter your security key PIN"`, `tZ/wv4` `"Your security key is protected by a PIN. Enter it to sign in to ",["rpId"]` | PROVEN |
| Enrolment flow: `VerifyPasskeyEnrollmentCode{code}` → `enrollment_ticket` → `BeginPasskeyRegistration{enrollment_ticket}` → `{ceremony_id, creation_options_json, ceremony_path, ceremony_token}` → `FinishPasskeyRegistration{ceremony_token, attestation_json, name}` → `credential_id` | descriptors | PROVEN |
| Stored passkey record includes whether it is synced | `Passkey|1 credential_id 9|2 name 9|3 created_at_ms 3|4 last_used_at_ms 3?|5 device_type 9|6 backed_up 8`; `ListPasskeysResponse|1 passkeys #0*`; `RevokePasskeyRequest|1 credential_id 9` | PROVEN |

> **Security assessment (INFERRED).** `ceremony_path` + `ceremony_token` imply the registration ceremony
> completes in a **backend-served browser context**, with the desktop polling `GetPasskeyCeremony` /
> `GetPasskeyCeremonyStatus` rather than driving WebAuthn itself. The private key therefore never enters the
> Electron renderer: `attestation_json` comes from `sand-webauthn-signer` and is forwarded. The residual risk
> is that **the approval prompt is the only thing distinguishing a user-initiated box sign-in from an
> agent-initiated one** — hence the deliberate wording *"Approve only if you started this."*

## 2.5 1Password — the broker path
```js
// recon/beautified/main-app.beauty.js:108636-108647, abridged
      T = bft({
        backend: Mt,
        openBrowser: (H) => Ne.shell.openExternal(H),
        isBrokerEnabled: () => of("sand_new_1pass"),
        launcherPath: Ne.app.isPackaged
          ? Wd.default.join(process.resourcesPath, "app.asar.unpacked", "dist", "native", "sand-op-launcher")
          : Wd.default.join(__dirname, "..", "native", "sand-op-launcher"),
        launcherVerification: Ne.app.isPackaged ? "anysphere" : "development",
```
| Fact | Evidence | Tag |
|---|---|---|
| The integration is a separate native binary `sand-op-launcher`, unpacked from the asar | `108642-108645` | PROVEN |
| Packaged builds verify it against the signing identity literal **`"anysphere"`**; dev uses `"development"` | `108646` | PROVEN — the string names the expected identity |
| Broker selection is gated on `sand_new_1pass`; a second gate `sand_1pass_manual_service_acct` defaults **true** | `108641`; `main-app.beauty.js:48320` | PROVEN |
| There is an auto-refresh path with its own failure telemetry class `("onepassword","refresh",…)` | `108647` | PROVEN |
| A dev-only escape hatch opens the OAuth window without the `sand` protocol handler | `108640` | PROVEN |
| The 1Password service code is `onepassword-connection-service.ts` with `detectMint`, `startMint` and `mintError` mapping | error registry | PROVEN |
```text
OnePasswordConnectionKind        :: UNSPECIFIED, SERVICE_ACCOUNT, OAUTH_BROKER
OnePasswordBrokerConnectionState :: UNSPECIFIED, PAIRING, CONNECTED, RECONNECT_REQUIRED
OnePasswordSyncTrigger           :: UNSPECIFIED, MANUAL, APP_FOCUS
OnePasswordCredentialItem|1 credential_id 9|2 title 9|3 category 9|4 sites 9*|5 target_rules #0*|6 vault_name 9|7 connection_id 9|8 catalog_revision 9|9 has_one_time_code 8
ApproveOnePasswordCredentialRequestRequest|1 entry_id 9|2 agent_id 9|3 credential_id 9|4 connection_id 9|5 catalog_revision 9|6 target_site 9|7 harness #0
DenyOnePasswordCredentialRequestRequest|1 entry_id 9|2 agent_id 9|3 harness #0
OnePasswordCredentialDecisionResponse|1 ok 8|2 detail 9
```
| Fact | Evidence | Tag |
|---|---|---|
| Two connection kinds: a headless **service account** or an **OAuth broker** through the 1Password desktop app | `OnePasswordConnectionKind` | PROVEN |
| Items carry `target_rules` — the **same `CredentialTargetRule` shape** as the native vault, so one matching engine serves both | field 5 `#0*` | PROVEN |
| The approval is bound to a **`catalog_revision`**, so a stale approval cannot be replayed against a changed item | field 5 | PROVEN |
| The approval names the specific **`target_site`** the user is approving | field 6 | PROVEN |
| The approver must state which **harness** is asking | field 7 | PROVEN |
| TOTP is a **boolean capability** (`has_one_time_code`), not a stored seed at this layer | field 9 | PROVEN for the field; INFERRED that the seed stays in 1Password |
| Sync happens on app focus as well as manually | `OnePasswordSyncTrigger` | PROVEN |
| Denial needs only `entry_id`, `agent_id`, `harness` — the minimum to unblock the requester | `Deny…` | PROVEN |
| Whether 1Password's own user-presence prompt is *always* enforced in addition to Grok Bot's approval | — | **UNKNOWN** |

## 2.6 Secrets

Two distinct concepts share the word:

**(a) Agent-facing named secrets** — `GrokBotSecret|1 name 9|2 description 9|3 created_at_ms 3|4 updated_at_ms 3`,
with `Put`/`List`/`Delete` and team variants `SandSetupSecret|1 name 9|2 value 9`,
`SandSetupTeamSecrets|1 team_id 9|2 secrets #0*`.

**(b) Just-in-time secrets the agent asks for and the user types in** —
`SubmitGrokBotSecretRequest|1 agent_id 9|2 entry_id 9|3 value 9|4 session_id 9` →
`…Response|1 accepted 8|2 refusal #0?`.
```js
// recon/beautified/node-agent-coordinator.beauty.js:34212-34219, verbatim
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
| `storeSecret` has exactly two destinations: a **box environment variable** or a **channel credential field** (`platform` + `field`) | above | PROVEN |
| `submitSecret` is scoped to an `entryId` **and a `sessionId`** — one agent session, not global | `34213` | PROVEN |
| `storeSecret` is `background`; `submitSecret` is `person` | `node-agent-coordinator.beauty.js:32784-32785` | PROVEN |
| Box secrets are **pushed**, not pulled | `setBoxSecrets({secrets})` (`background`), `getBoxSecretsStatus` (`person`), `carryBoxSecretsToBot({serverId, names[]})` (`person`) at `node-agent-coordinator.beauty.js:34429-34431`; auth table `32927-32930` | PROVEN |
| `carryBoxSecretsToBot` moves named secrets from the box to a **specific bot server** — how a team bot inherits credentials | `34432`; `main-app.beauty.js:41276` | PROVEN |
| `getBoxSecretsStatus()` returns `{cardKeys: [...]}` | `main-app.beauty.js:89183` | PROVEN |
| A bot's secret names = deduplicated union of local keystore keys and box `cardKeys` | `main-app.beauty.js:89183-89187` | PROVEN |
| Unfetchable secrets degrade to `{name, outcome: "missing"}` rather than failing the call | `89187-89189` | PROVEN |

### At-rest encryption
```js
// recon/beautified/main-app.beauty.js:103610-103614, 103685-103695, abridged
      "[sand] OS secure storage (keychain/keyring) is unavailable; box secrets are kept in memory for this session only and will NOT persist across restart.",
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
| Secrets at rest are encrypted with Electron **`safeStorage`** (macOS Keychain / Linux keyring / Windows DPAPI), base64-encoded, in one file | `103685-103691` | PROVEN |
| The file is `USER_SECRETS_FILENAME` under `app.getPath("userData")` | `103606` | PROVEN |
| With no OS secure storage, secrets are **memory-only** and the degradation is reported to Sentry as a warning | `103611-103615` (`captureSandSentryWarning`) | PROVEN |
| Decryption failures are reported as `reportDesktopEdgeFailure("user-secrets","decrypt",…)` and treated as "no value" | `103650-103655` | PROVEN |
| Files are written with `mode: 384` (octal `0600`) | `103747-103749` | PROVEN |
| Secrets are namespaced per account scope and blocked from export while the account is departing | `103658-103666`, `103795` | PROVEN |
| A box push returns `{isApplied}`; failures classify as `keychain_locked` vs `other` | `103799-103812` | PROVEN |
| Pushes stop at quit, throwing `SandBoxSecretsPushStoppedError` (`"Box secrets pushes are stopped for quit"`) | `103779-103783` | PROVEN |

## 2.7 Virtual cards and agent-initiated spend
```text
RaiseGrokBotVirtualCardRequest|1 agent_id 9|2 amount_cents 3|3 currency 9|4 merchant_name 9|5 merchant_url 9|6 context 9
RaiseGrokBotVirtualCardResponse|1 outcome #0|2 request_id 9|3 merchant_name 9?|4 superseded_request_id 9?
ResolveGrokBotVirtualCardApprovalRequest|1 agent_id 9|2 entry_id 9|3 request_id 9|4 resolution #0|5 payment_method_id 9?|6 attestation #1?
ResolveGrokBotVirtualCardApprovalResponse|1 outcome #0|2 spend_request_id 9?|3 approval_url 9?|4 message 9?|5 refusal #1?|6 enrolled_credential_ids 9*
GrokBotVirtualCardRaiseOutcome :: UNSPECIFIED, RAISED, ALREADY_PENDING
GrokBotVirtualCardResolution  :: UNSPECIFIED, APPROVED, DENIED
GrokBotVirtualCardOutcome     :: UNSPECIFIED, APPROVED, DENIED, NEEDS_AUTH, FAILED, NEEDS_PASSKEY
GrokBotStripeLinkPaymentMethodKind        :: UNSPECIFIED, CARD, BANK_ACCOUNT
GrokBotStripeLinkPaymentMethodsOutcome    :: UNSPECIFIED, OK, NEEDS_AUTH, UNAVAILABLE
```
| Fact | Evidence | Tag |
|---|---|---|
| The agent requests a card for a specific **amount in cents, currency, merchant name, merchant URL and free-text context** | `RaiseGrokBotVirtualCardRequest` | PROVEN |
| A new request can supersede a pending one | field 4 `superseded_request_id` | PROVEN |
| Resolution is a `person` coordinator method with `resolution ∈ approved/failed/expired/denied` and an optional `attestation` | `node-agent-coordinator.beauty.js:32774`, `34192-34201` | PROVEN |
| The backend's enum is narrower than the coordinator's — local timeouts and failures are desktop concepts | `GrokBotVirtualCardResolution` vs `node-agent-coordinator.beauty.js:11673` | PROVEN |
| A successful resolution can return an **`approval_url`** — approval may finish in a browser | response field 3 | PROVEN |
| A passkey can be **enrolled as part of approving spend** | response field 6 `enrolled_credential_ids`; `PasskeyCeremonyKind.APPROVE_WITH_REGISTRATION`; `SpendApprovalCeremonyMode.REGISTER` | PROVEN |
| Spend specifically can fail needing a passkey | `GrokBotVirtualCardOutcome.NEEDS_PASSKEY` | PROVEN |
| Payment methods come from **Stripe Link**; `listVirtualCardPaymentMethods` exists | `GrokBotStripeLink*`; `node-agent-coordinator.beauty.js:34552`, `34641`, `37051` | PROVEN |
| Backend RPCs are unary `raiseGrokBotVirtualCard` / `resolveGrokBotVirtualCardApproval` | `node-agent-coordinator.beauty.js:28260-28261` | PROVEN |
| UI copy names the merchant | `yys/x+` `"Approve a card for ",["merchantName"]`; `gtUhhC` `"The purchase could not be authorized"`; `QqzfGy` *"…Update Grok Bot, then request a new card."* | PROVEN |

## 2.8 Connector grants — the fourth approval axis
```text
ResolveGrokBotConnectorGrantRequest|1 agent_id 9|2 request_id 9|3 resolution #0|4 session_id 9?|5 entry_id 9?
ResolveGrokBotConnectorGrantResponse|1 dispatched 8|2 workflow_id 9?|3 refusal #0?
ClearGrokBotConnectorAlwaysAllowResponse|1 cleared_count 13
GrokBotConnectorType          :: UNSPECIFIED, USER, TEAM
GrokBotConnectorGrantResolution :: UNSPECIFIED, ALLOWED, SKIPPED, ALWAYS_THIS_BOT, ALWAYS_ALL_TEAM_BOTS, ALLOW_IN_CHANNEL
```
| Fact | Evidence | Tag |
|---|---|---|
| Grants persist (`ALWAYS_THIS_BOT`, `ALWAYS_ALL_TEAM_BOTS`) and can be bulk-forgotten (`ClearGrokBotConnectorAlwaysAllow` returns `cleared_count`) | descriptors | PROVEN |
| A grant can be scoped to a **channel** (`ALLOW_IN_CHANNEL`), not just globally | enum | PROVEN |
| Connectors are owned by a `USER` or a `TEAM` | `GrokBotConnectorType` | PROVEN |
| Resolution **dispatches** work (`dispatched`, `workflow_id`) rather than completing synchronously — the human's answer resumes a durable workflow | response fields 1-2 | PROVEN |
| `resolveConnectorGrant` is `person`-class | `node-agent-coordinator.beauty.js:32773` | PROVEN |
| UI copy distinguishes the bot's account from the user's | `rT3y+O` *"…is connected to your account, not the Bot's, so signing in won't help; the Bot needs your approval for this turn instead"*; `sDjEmJ` *"…runs on Grok Bot's computer and doesn't use browser sign-in. Configure its credentials in the environment settings."* | PROVEN |

## 2.9 Consolidated approval inventory

| Layer | Method / RPC | Auth | Scope | Persisted? |
|---|---|---|---|---|
| Chrome cookies | `request`/`await`/`cancelCookieOriginApproval` | `background` | `(origin, profileId)` | no |
| Chrome cookies | `injectChromeCookies` | `person` | per call | no |
| WebAuthn | `requestWebAuthnCeremony` | `background` | per ceremony | passkey record if registering |
| 1Password | `Approve`/`DenyOnePasswordCredentialRequest` | backend | `credential_id` + `catalog_revision` + `target_site` | in 1Password |
| Native vault | `ResolveGrokBotCredentialRequest` | `person` | `entry_id` + `session_id` | vault item |
| Virtual card | `Raise` → `resolveVirtualCardApproval` | `person` | per `request_id` | server-side |
| Connector | `ResolveGrokBotConnectorGrant` | `person` | per `request_id`, optionally channel-scoped | `ALWAYS_*` persists |
| Secrets | `submitSecret` / `storeSecret` | `person` / `background` | `entry_id`+`session_id` / `box-env:<name>` or `channel-credential:<platform>:<field>` | only via `storeSecret` |
| Local tools | `resolveLocalToolPermission` | `person` | tools / reads / writes | `recordLocalToolApproval` → `getLocalToolApprovalsPath()` (`main-app.beauty.js:108707-108708`) |
| macOS Messages | `request`/`await`/`cancel`/`resolveMessagesGrants` | `background` ×3, `person` ×1 | per `requestId` + grant list | no |
| Auto-review | `resolveAutoReviewApproval` | `person` | per review | `GrokBotAutoReviewApprovalResolution` = `APPROVED`, `DENIED`, **`ALWAYS`** |

The policy vocabulary is shared:
```js
// recon/beautified/node-agent-coordinator.beauty.js:33971-33974, abridged
  cw = Ve(U("always_allow"), U("needs_approval"), U("blocked")),
  $$ = w({ scopes: xt(w({ tools: A(xt(cw)), reads: A(xt(cw)), writes: A(xt(cw)) })) }),
```
| Fact | Evidence | Tag |
|---|---|---|
| Policy attaches to tools, reads and writes **separately**, each `always_allow` / `needs_approval` / `blocked` | `33972-33975` | PROVEN |
| The backend enum `GrokBotToolPermission` mirrors it | enum table | PROVEN |
| The local card offers four answers, not three: `ALLOW_ONCE`, `DENY`, `ALWAYS`, `NEVER` | `GrokBotLocalToolPermissionCardResolution` | PROVEN |
| A mid-computer-use permission denial is distinguishable and recoverable, not fatal | `t.tool === "computer_use_screenshot" \|\| t.code === "permission_required"` at `local-exec-daemon.beauty.js:104029` | PROVEN |

---

# 3. Egress & network model

## 3.1 macOS App Transport Security
```text
// plutil -p "/Applications/Grok Bot.app/Contents/Info.plist"
"NSAppTransportSecurity" => {
  "NSAllowsArbitraryLoads" => true
  "NSAllowsLocalNetworking" => true
  "NSExceptionDomains" => {
    "127.0.0.1" => { "NSIncludesSubdomains" => false,
                     "NSTemporaryExceptionAllowsInsecureHTTPLoads"  => true,
                     "NSTemporaryExceptionAllowsInsecureHTTPSLoads" => false,
                     "NSTemporaryExceptionMinimumTLSVersion" => "1.0",
                     "NSTemporaryExceptionRequiresForwardSecrecy" => false }
    "localhost"  => { …identical… } } }
```
| Fact | Evidence | Tag |
|---|---|---|
| `NSAllowsArbitraryLoads = true` — **ATS is effectively disabled process-wide** | `Info.plist` | PROVEN |
| `NSAllowsLocalNetworking = true` additionally permits local-network hosts | idem | PROVEN |
| Loopback exceptions allow insecure **HTTP** but explicitly not insecure HTTPS, TLS floor 1.0, no forward secrecy required | `NSExceptionDomains` | PROVEN |
| The loopback exceptions are redundant given arbitrary loads | INFERRED — likely a leftover, or belt-and-braces for when the global switch is turned off | — |

> **Note (INFERRED).** `NSAllowsArbitraryLoads: true` means Grok Bot will fetch plaintext `http://`
> anywhere. That is *consistent with its purpose* (the agent drives legacy intranet apps), but it means the
> app's ATS posture is not a usable security control for agent browsing. The compensating controls are the
> renderer CSP (§3.5) and the box's own policy layer.

Other plist keys worth recording: `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`,
`NSCameraUsageDescription`, `NSBluetoothAlwaysUsageDescription` (all present, all with the minimal generic
strings), `LSMinimumSystemVersion = 12.0`, `NSHumanReadableCopyright = "Copyright © 2026 SpaceXAI"`,
`CFBundleURLSchemes = ["grokbot","sand"]`, and
`ElectronAsarIntegrity["Resources/app.asar"].hash = 88c570ca443a0b43486399ea0e285aabd4c51be991e8940a4e4c389d412ffd4c`.

## 3.2 The system-proxy resolver
```js
// recon/beautified/main-core.beauty.js:20552-20557, abridged
    childEnv: () => (i === null ? {} : { [Am]: JSON.stringify(i) }),
    loginFetch: () => globalThis.fetch,
    webSocketAgent: (x) => (i === null ? void 0 : sne(x)),
    logTo: (x) => {
      (x(["[sand] system-proxy mode=on", `source=${e.source}`, `decision=${d}`].join(" ")), Ow(e, x));
    },
```
| Fact | Evidence | Tag |
|---|---|---|
| The resolved proxy reaches children through one env var | `childEnv` + `var Am = "SAND_NODE_PROXY_ENV"` at `main-core.beauty.js:18488` | PROVEN |
| Secure vs insecure WebSockets use different global agents | `sne(e)`: `wss:` → `Pw.default.globalAgent` (`node:https`); `ws:` → `UT.default.globalAgent` (`node:http`) — `20504-20507` | PROVEN |
| Chromium's own resolution is the source of truth, applied globally | `t.resolveWithChromium(t.backendUrl)` at `20524`; default apply `setGlobalProxyFromEnv({...x})` at `20512` | PROVEN |
| `SAND_SYSTEM_PROXY` / `SAND_HTTPS_PROXY` are honoured and **validated**; unusable values are ignored and logged, not fatal | `Dw(e)` at `20414-20429`; ignored accumulator `20430-20438`; log `"[sand] system-proxy ignored-unusable=…"` at `20456-20460` | PROVEN |
| SOCKS is detected and explicitly **unsupported** | `N.sawSocks && t.reportFailure("socks_unsupported")` at `20517` | PROVEN |
| Three deadlines: 3,000 / 10,000 / 7,000 ms | `rne`, `one`, `ane` at `20408-20410` | PROVEN |
| Failure vocabulary: `apply_failed`, `resolve_failed`, `timeout`, `socks_unsupported` | `20513`, `20528`, `20535`, `20517` | PROVEN |
| Env shape is `{HTTPS_PROXY, HTTP_PROXY, NO_PROXY}` | `ww(e, t = "")` at `20431-20434` | PROVEN |
| A config file `system-proxy.json` exists | `kw = "system-proxy.json"` at `20406` | PROVEN |
| `loginFetch` deliberately uses **unproxied** `globalThis.fetch` | `20555` | PROVEN |

> **Note (INFERRED).** Exempting auth fetches from the proxy avoids a broken proxy bricking sign-in, but it
> means **the user's IdP traffic does not necessarily traverse the same egress path as agent traffic.** If a
> customer expects all Grok Bot traffic to be proxy-inspected, this is a gap worth flagging.

## 3.3 The box egress tunnel

| Fact | Evidence | Tag |
|---|---|---|
| Gate `sand_box_egress_tunnel` exists and **defaults true** | `main-app.beauty.js:49045` | PROVEN |
| Telemetry operation `"sand.desktop.egress_tunnel"` | `70185`; used at `92753` | PROVEN |
| `isEgressTunnelAvailable` is `background`, no args → boolean | `node-agent-coordinator.beauty.js:32902`, `34398`, `36987`; `main-app.beauty.js:41247` | PROVEN |
| The tunnel is a **WebSocket** on a fixed port | `egressTunnelWebSocket: 8790`, `egressConnectProxy: 8791` at `79019-79028` | PROVEN |
| The tunnel host is derived by rewriting the backend hostname to embed `-8790` (or setting port 8790) and forcing `wss:` | `e7t(e, t)` at `79044-79058` | PROVEN |
| A client can **claim** the tunnel to avoid two clients racing for one box | `claimEgressTunnel` at `94387-94389`, again at `94667` | PROVEN |
| Ownership is tracked per box | `$d.noteBoxEgressOwnership(H?.egressTunnelOwnership)` at `108953`, `109095` | PROVEN |
| Enabling is additionally gated on a team policy provider and an `isAllowed` predicate | `policyProvider: Oze(Mt)`, `isAllowed: dx.isAllowed`, `dx.subscribe(…)` at `108945-108954` | PROVEN |
| Status/enable changes are broadcast as `"egress-tunnel-status-changed"` / `"egress-tunnel-changed"` | `108946`, `108955`, `108687` | PROVEN |
| The tunnel reuses the system proxy's WebSocket agent | `connectAgent: ye.systemProxy.webSocketAgent` at `108952` | PROVEN |
| A persisted preference is separate from effective state; `setEgressTunnelEnabled` writes both | `local-exec-daemon.beauty.js:70012-70013`, `70006-70016` | PROVEN |

**INFERRED:** the egress tunnel is how the box (a VM with no stable inbound path) reaches the backend and
how desktop and box agree on a single outbound identity for box-run tools.

## 3.4 The box service port map
```js
// recon/beautified/main-app.beauty.js:79018-79040, verbatim
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
var X8t = "/run/sand-webauthn-proxy",
  mxr = `${X8t}/credential`;
```
| Port / path | Purpose | Tag |
|---|---|---|
| 1337 | primary exec daemon (sandboxed shell/file tool server) | PROVEN |
| 1338 | primary PTY | PROVEN |
| 6080 / 6081 | noVNC **websockify**, primary and forked | PROVEN |
| 1339 | "window router" | PROVEN for the literal |
| 1340 | host gateway — the box's path back to the desktop | PROVEN for the literal |
| 8790 / 8791 | egress tunnel WebSocket / connect proxy | PROVEN |
| `/run/sand-webauthn-proxy/credential` | Unix socket **inside the box** fronting the local computer's security key | PROVEN |

## 3.5 Renderer CSP
```text
// recon/grokbot-0.71.2/dist/renderer/index.html (per FINDINGS.md:49-52)
connect-src 'self' ws: sand-media: https://grok.com
frame-src   sand-html-preview: sand-canvas: sand-mcp-app:
img-src     'self' blob: data: file: https: sand-avatar: sand-favicon: sand-media://image
```
| Fact | Evidence | Tag |
|---|---|---|
| WebSockets to **any** host are allowed (`ws:` with no host restriction) | `connect-src` | PROVEN |
| HTTPS is restricted to `'self'` and `https://grok.com` — **not** `api2.cursor.sh` | idem | PROVEN |
| Only the three agent-artifact schemes may be framed | `frame-src` | PROVEN |
| `sand-media://image` is host-qualified in `img-src` — the host component is semantically `image` | idem | PROVEN |
| The renderer may load `file:` images | idem | PROVEN |

**INFERRED:** the renderer's real data channel is the loopback coordinator port (§3.6), which is a WebSocket
— hence the unqualified `ws:`. `api2.cursor.sh` need not appear because the renderer never talks to the
backend directly; the main process and the coordinator do.

## 3.6 The loopback coordinator channel

| Fact | Evidence | Tag |
|---|---|---|
| The renderer requests the port over IPC | `preload.beauty.js:4099` (`invoke("sand:coordinator-port-request", void 0)`) | PROVEN |
| The main process answers on `sand:coordinator-port` | `main-app.beauty.js:85107-85108`; listener `preload.beauty.js:4145` | PROVEN |
| Exposed as `contextBridge.exposeInMainWorld("coordinatorPort", …)` | `preload.beauty.js:4141` | PROVEN |
| Only loopback hosts accepted | `FINDINGS.md:70` — `new Set(["localhost","127.0.0.1","::1","[::1]"])` | PROVEN (prior recon) |
| Main→coordinator traffic is a **streaming/reconnecting** transport | `new DG(sh, cx.transportStream.openReconnectId)` at `109297` | PROVEN |
| Handoff is a first-class lifecycle event with telemetry | `kYe(pz.reportDesktopCoordinatorHandoff)` at `108184`; op `sand.desktop.coordinator_handoff` at `70184` | PROVEN |

> **Security assessment (INFERRED).** Loopback binding plus a port discovered through the preload/main IPC
> handshake is reasonable — the agent runtime stays off the network. The residual risk is that **any local
> process that can observe or guess the loopback port can speak the protocol**: the allowlist is by hostname,
> no token appears in the `claim` schema, and the error registry names the sink as `"coordinator port sinks
> in electron-main/main.cts"` without an auth step. **Whether the coordinator requires authentication is
> UNKNOWN.**

## 3.7 Other network surfaces

| Surface | Literal / value | Evidence | Tag |
|---|---|---|---|
| Diagnostic probes (17) | `api-dns`, `api-tls`, `api-unary`, `auth-page`, `auth-ui`, `auth-service`, `computer-dns`, `computer-tls`, `computer-health`, `computer-events`, `computer-screen-websocket`, `updates-feed`, `updates-download`, `feature-flags`, `origin-api`, `telemetry`, `voice-realtime` | `main-app.beauty.js:99050-99068` | PROVEN |
| Probe concurrency | `{ max: DMn }` with `DMn = 4` | `99061`, `99374` | PROVEN |
| Auth hosts | `https://authenticator.cursor.sh`, `https://prod.authentication.cursor.sh` | `99073-99074` | PROVEN |
| Update CDN | `https://downloads.cursor.com` | `99075` | PROVEN |
| Feature flags | `` `${F_}/rgstr` `` | `99352-99355` | PROVEN |
| Telemetry origin | `new URL(Cpt.SAND_SENTRY_DSN).origin` | `99360-99363` | PROVEN |
| Origin backend | `e.backend.originBackendUrl` | `99356-99359` | PROVEN |
| TLS probe | `HEAD` with `rejectUnauthorized: false`, then reads peer-cert issuer `O`/`CN` | `LMn` at `99098-99114`; `NMn` at `99088-99095` | PROVEN |
| Diagnostic detail cap | 240 chars (`BMn`) | `99071`, `99077` | PROVEN |
| Probe auth header | `` `authorization: ${rNe} ${e.token}` `` | `99084-99086` | PROVEN |
| Network state broadcast | channel `sand:network-online` | `FINDINGS.md:61` | PROVEN (prior recon) |

---

# 4. Canvas, artifacts and HTML preview

## 4.1 Six privileged schemes, one registration block
```js
// recon/beautified/main-core.beauty.js:21330-21342, verbatim
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
| Binding | Literal | Declared at |
|---|---|---|
| `No` | `"sand-media"` | `main-core.beauty.js:20572` |
| `zl` | `"sand-canvas"` | `main-core.beauty.js:21330` |
| `fc` | `"sand-html-preview"` | `main-core.beauty.js:20335` |
| `Dl` | `"sand-avatar"` | `main-core.beauty.js:17730` |
| `Ml` | `"sand-favicon"` | `main-core.beauty.js:18476` |
| `gc` | `"sand-mcp-app"` | `main-core.beauty.js:20337` |
| Fact | Evidence | Tag |
|---|---|---|
| **No** sand scheme sets `bypassCSP`, `corsEnabled`, `allowServiceWorkers` or `codeCache` | the block above | PROVEN |
| `sand-media` is the only sand scheme with `supportFetchAPI` and `stream` — the only fetchable, streamable one | `21334` | PROVEN |
| `file:` is re-registered as `standard` with `codeCache` — the renderer heap loads with V8 code cache | `21340` | PROVEN |
| A **seventh** scheme `sentry-ipc` is registered by the Sentry SDK with `{bypassCSP: !0, corsEnabled: !0, supportFetchAPI: !0, secure: !0}`, and the SDK **wraps `registerSchemesAsPrivileged` in a `Proxy`** so any later call also appends its own entry | `main-core.beauty.js:38782-38786` | PROVEN |

> `sentry-ipc` is the **only** scheme in the app with `bypassCSP: true`. It is served solely from Sentry's own
> `app.whenReady` handler across all app sessions (`main-core.beauty.js:38788-38803`), which bounds exposure,
> but the contrast with the sandboxed artifact schemes is worth recording.

## 4.2 Handler installation
```js
// recon/beautified/main-core.beauty.js:40660-40665, verbatim
      ee.protocol.handle(Dl, c.serve),
      DL(async (h) => (await _o.serveAttachmentImage?.(h)) ?? new Response(null, { status: 503 })),
      ee.protocol.handle(Ml, async (h) => (await _o.serveLinkFavicon?.(h)) ?? new Response(null, { status: 503 })));
    let S = { isEnabled: Cw(() => _o.readExperimentService?.()), stageDocument: xw };
    (Iw(S),
```
| Scheme | Handler | Backing implementation | Tag |
|---|---|---|---|
| `sand-avatar` | `c.serve` | an avatar server object | PROVEN |
| `sand-media` | inline lambda | `serveAttachmentImage(url)`, **HTTP 503** if absent | PROVEN |
| `sand-favicon` | inline lambda | `serveLinkFavicon(url)`, **HTTP 503** if absent | PROVEN |
| `sand-mcp-app` | `Iw(S)` → `Rw.protocol.handle(gc, t => nne(t, S.isEnabled))` | in-memory staged-document `Map` | PROVEN |
| `sand-html-preview` | `qne`, registered alongside `sand-media` in `DL` | preview renderer | PROVEN |
| `sand-canvas` | `wKe.protocol.handle(RKe.SAND_CANVAS_SCHEME, qnn(…))` at `main-app.beauty.js:81526` | canvas server | PROVEN |
| scheme constant | `SAND_CANVAS_SCHEME` re-exported from main-core and equal to `zl` | `main-core.beauty.js:39679-39681` | PROVEN |

**INFERRED:** the 503-when-missing shape means image loads fail as **broken images rather than errors** — no
exception reaches the renderer. Right choice for a UI surface, but a missing media backend is invisible
except through `desktopEdgeFailure` telemetry.

## 4.3 `sand-media://image/<id>`
```js
// recon/beautified/main-core.beauty.js:20572-20590, abridged
var No = "sand-media", FT = "image", cne = /^[0-9a-f]{32}$/;
function Bw(e, t = 0) { let n = t > 0 ? `?r=${t}` : ""; return `${No}://${FT}/${e}${n}`; }
function Gw(e) {
  if (!URL.canParse(e)) return null;
  let t = new URL(e);
  if (t.protocol !== `${No}:` || t.host !== FT) return null;
  let n = t.pathname.slice(1);
  return dne(n) ? { id: n } : null;         // dne = cne.test
}
```
| Fact | Evidence | Tag |
|---|---|---|
| Shape is exactly `sand-media://image/<32 lowercase hex>` with optional `?r=<n>` cache-buster | `Bw` / `Gw` / `cne` | PROVEN |
| The id is a 128-bit hex token, not a path or filename — media is addressable only by opaque id | `cne` | PROVEN |
| Path traversal is structurally impossible: any segment not matching 32 hex fails the parse | `Gw` returns `null` | PROVEN |
| A second, unrelated hasher exists for media: SHA-256 over `` `sand-media\0${e}\0${t}` ``, base64url, first 22 chars (~132 bits), with domain separation | `SL(e, t)` at `main-core.beauty.js:21325-21327` | PROVEN |
| Requests matching `Ym` (protocol + host `image`) go to the injected handler; everything else falls through to `Kne` | `Xne` at `21593-21595` | PROVEN |
| The CSP `img-src` host form `sand-media://image` matches `FT = "image"` | CSP vs `FT` | PROVEN |
| `resolve-media` (named in `FINDINGS.md:54`) was not isolated; whether it is a channel or a function | — | **UNKNOWN** |

> **Security assessment (INFERRED).** `sand-media` is a **capability-URL** design: possessing the 32-hex id
> suffices to fetch the bytes, and no per-request authorization check is visible in `Xne`/`DL`. The `SL`
> hash makes ids unguessable, but ids are visible to anything that can read the DOM of a message, and there is
> **no evidence of expiry or single-use semantics**.

## 4.4 `sand-canvas:` — the artifact scheme
```js
// recon/beautified/main-app.beauty.js:81532-81555, abridged
var _nn = "frame", X2e = /^[\w.:-]{1,128}$/;
function eKe(e) {
  let t = URL.canParse(e) ? new URL(e) : null;
  if (t == null || t.protocol !== `${J2e.SAND_CANVAS_SCHEME}:` || t.hostname !== _nn ||
      t.port !== "" || t.username !== "" || t.password !== "" || t.hash !== "") return null;
  let n = t.searchParams.get("theme");
  if (n !== "light" && n !== "dark") return null;
  let a = `?theme=${n}${o === null ? "" : `&room=${o.value}`}${Enn(i)}`;
  if (t.search !== a) return null;                            // query must match exactly
  if (c.length === 3 && c[0] === "" && c[1] === "user")
    return o !== null ? null : { locator: { kind: "active-user-store", canvasId: d.value }, theme: n, ...s };
```
| Fact | Evidence | Tag |
|---|---|---|
| Canonical URL: `sand-canvas://frame/<canvasId>?theme=light\|dark[&room=<id>][&rev=<id>]` | `eKe` | PROVEN |
| Host must be exactly `frame`; port, username, password and fragment must all be **empty** | `81537-81542` | PROVEN |
| `theme` is mandatory, `light` or `dark` only | `81543-81544` | PROVEN |
| The query must match the canonical re-serialisation **exactly** — extra or reordered params rejected | `81554` | PROVEN |
| Two locator kinds: `active-user-store` from `/user/<canvasId>`, `store` from `/store/<storeId>/<canvasId>` | `81570-81579` | PROVEN |
| `room` is valid only on store locators, never on user-store locators | `81571` | PROVEN |
| `rev` is a 1-128 char `[\w.:-]` token forwarded as `&rev=` | `X2e`, `Enn` | PROVEN |
| A `groupChatId` can attach to a store canvas | `...(o === null ? {} : { groupChatId: o.value })` | PROVEN |
| Cache budget **32 MiB** (`33554432`), estimated as `(bundleJsonText.length + dataJsonText.length) * 2` — i.e. 2× char count as a UTF-16 estimate | `tKe` at `81585-81586`; `bnn` at `81584` | PROVEN |
| Eviction is LRU-ish: re-`get` re-inserts (Map order), eviction walks from the front | `81603` | PROVEN |
| Refresh is coalesced per entry, guarded by a generation counter and an `AbortController` | `81604-81613` | PROVEN |
| `clear()` bumps the generation, aborts in-flight refreshes, resets the budget | `81617-81621` | PROVEN |
| A single oversize canvas is simply not cached | `81597` (`!(f > t)`) | PROVEN |
| Refresh failures → `reportDesktopEdgeFailure("canvas-frame","refresh",…)`; typeface reads → `("canvas-frame","typeface-read","not_found")` | `81595`, `82187`, `82189-82191` | PROVEN |
| A different typeface bundle applies to "Xvf" builds | `e.isXvfTypeface()` at `82199` | PROVEN |
```js
// recon/beautified/main-app.beauty.js:81631-81633, verbatim
var Cnn = ["allow-scripts", "allow-popups", "allow-popups-to-escape-sandbox"],
  vnn = Cnn.join(" "),
  gOr = `sandbox ${vnn}`;
```
| Fact | Evidence | Tag |
|---|---|---|
| Sandbox is exactly `allow-scripts allow-popups allow-popups-to-escape-sandbox` | `81632-81634` | PROVEN |
| `allow-same-origin` is **absent** — opaque origin, no access to host storage or cookies | absence in `Cnn` | PROVEN |
| `allow-forms`, `allow-modals`, `allow-top-navigation`, `allow-pointer-lock`, `allow-presentation`, `allow-downloads` all **absent** | absence in `Cnn` | PROVEN |
| `allow-popups-to-escape-sandbox` means a popup from a canvas is **not** sandboxed — the only escape hatch | `81632` | PROVEN |
| Canvas link opens are additionally gated on a recent trusted gesture and an `http`/`https`/`mailto`/`tel` scheme (§1.6) | `main-core.beauty.js:28659-28684`; `main-app.beauty.js:108500` | PROVEN |
| A link-interception script (`canvasLinkHref`, reading `href` **and** `xlink:href`) is injected into canvas content | `nKe()` at `81635-81646`; channel `sand-canvas-frame-open-link` at `81527` | PROVEN |

> **Security assessment.** The sandbox set is strong (opaque origin, no forms, no modals, no top-navigation).
> The single deliberate hole, `allow-popups-to-escape-sandbox`, is mitigated by the real user-activation gate
> in §1.6. The larger exposure is `script-src 'unsafe-inline'` in the preview CSP (§4.5) — necessary for
> agent-generated HTML/JS, and precisely why the origin must remain opaque.

## 4.5 `sand-html-preview:` — agent HTML with a generated CSP
```js
// recon/beautified/main-core.beauty.js:20315-20332, abridged
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
| CSP is generated **per document** from four caller-supplied domain lists | `wT(e)` | PROVEN |
| Baseline: `default-src 'none'`, `object-src 'none'`, `base-uri 'self'` | `20318`, `20326`, `20327` | PROVEN |
| Inline script and style are **allowed** — required for agent-authored HTML | `20319-20320` | PROVEN |
| `frame-src` is closed by default (`'none'`) when no `frameDomains` are supplied | `20325` | PROVEN |
| The meta CSP is injected **immediately after `<!DOCTYPE html>`**, before any author content, so a later author-supplied CSP meta cannot supersede it | `Aw` | PROVEN |
| A leading BOM is stripped so the meta tag still lands first | `Aw` | PROVEN |
| Two bridge scripts are injected between the CSP and the author content | `ene(n)`, `Zte` | PROVEN |
| Domain lists are sanitised before interpolation | `Wm(e)` → `e.filter(zte)` at `20152-20156` | PROVEN |
| Domain interpolation escapes `& < > "` | `Aa(e)` at `20195-20201` | PROVEN |
| The allow-pattern requires a public-looking hostname with an explicit scheme | `Yte = /^(?:https\|wss):\/\/(?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?$/i` at `20110` | PROVEN |
| A **30-entry deny-list** blocks internal / SSRF-adjacent domains **including wildcard-DNS bypass services** | `qte` at `20111-20146`: `.local`, `.localhost`, `.internal`, `.intranet`, `.corp`, `.localdomain`, `.lan`, `.home`, `.svc`, `.home.arpa`, `.test`, `.invalid`, `.example`, `.alt`, `.onion`, `.nip.io`, `.sslip.io`, `.xip.io`, `.traefik.me`, `.localtest.me`, `.lvh.me`, `.localho.st`, `.vcap.me`, `.smackaho.st`, `.lacolhost.com`, `.localh.st`, `.local.gd`, `.1u.ms`, `.localhost.direct` | PROVEN |
| `zte(e)` strips scheme and port, lowercases, and rejects an exact bare-name match **or** any suffix match | `20147-20154` | PROVEN |
| Preview content is gated on an account-gate admission check, served as `text/html; charset=utf-8` with `cache-control: no-cache` | `main-core.beauty.js:20336-20343`, `21585-21587` | PROVEN |
| Previews are backed by the attachment store — content is read via `readChunk(t, 0, …)` | `21575-21584` | PROVEN |
| Only **HTML** content is served; anything else yields the refusal response (`Ec(n) !== "html" ? Po() : …`) | `21568` | PROVEN |
| Total preview size is bounded by `eg` and the first read by `Bne` | `21577`, `21581` — the numeric values were not resolved | PROVEN for the guard; **UNKNOWN** for the values |

## 4.6 `active-user-store-canvas` and `slack-canvas` are **not** protocols

`FINDINGS.md:54` lists these beside the real schemes. Both are **locator/provider kinds** in other
subsystems; neither appears in `registerSchemesAsPrivileged` nor in any `protocol.handle`.
| Literal | Actual role | Evidence |
|---|---|---|
| `"active-user-store-canvas"` | a **kind** in the canvas-locator union: `` `active-user-store-canvas:${e.canvasId}` `` | `main-app.beauty.js:75605-75606` |
| idem | an RPC-wire literal: `rpcObject({kind: rpcLiteral("active-user-store-canvas"), canvasId: Pqe})` | `77192` |
| idem | excluded from store-id collection because it has no store | `81324-81326` |
| idem | exported from the preload as part of the canvas-link API | `preload.beauty.js:3485` |
| `"slack-canvas"` | a **link provider** parsed from `slack.com/docs/<F-id>/<p-id>`: `{provider:"slack-canvas", id:`${n}/${r}`, url:`${e.origin}/docs/${n}/${r}`}` | `main-app.beauty.js:80779`, matcher `Htn` at `80773-80781` |

## 4.7 Link providers and connector ids
```js
// recon/beautified/main-app.beauty.js:80564-80591, verbatim (30 entries)
var D2e = [
  "notion", "google-docs", "google-sheets", "google-slides", "google-drive", "onedrive", "sharepoint",
  "figma", "figjam", "figma-slides", "linear-issue", "linear-document", "confluence-page", "jira-issue",
  "github-file", "github-gist", "github-issue", "slack-canvas", "box", "dropbox", "airtable", "coda",
  "miro", "canva", "hex", "gmail-draft", "google-calendar-event", "slack-message",
  "github-pull-request", "web",
];
```
Each has a hand-written matcher emitting `{provider, id, url}` — GitHub PRs (`80731`), Jira (`80712`),
Confluence (`80718`), Figma (`80683-80690`), Linear (`80699-80704`), Notion (`80615`), Google
Drive/Docs (`80636-80637`), OneDrive/SharePoint (`80660-80669`), Airtable (`80799`), Coda (`80808`), Miro
(`80812`), Canva (`80821`), Hex (`80832`), Gmail drafts (`80839`), Google Calendar (`80849`). **PROVEN.**
```js
// recon/beautified/main-app.beauty.js:75741-75791, verbatim (47 entries)
var O7 = ["workspace","slack","notion","salesforce","microsoft-365","linkedin","zoom","github","cursor",
  "jira","figma","hubspot","canva","trello","monday","clickup","intercom","zendesk","box","dropbox",
  "docusign","calendly","loom","outreach","salesloft","apollo","clay","zoominfo","nooks","stripe",
  "shopify","quickbooks","netsuite","ramp","workday","rippling","ashby","greenhouse","vercel","tableau",
  "hex","amplitude","mixpanel","snowflake","databricks","mailchimp"],
```
This maps 1:1 onto the vendor logos shipped in the renderer (`salesforce.svg`, `rippling.png`,
`snowflake.png`, `quickbooks.png`, `databricks.png`, `tableau.png`, `clay.png`, `zoominfo.png`, `nooks.png`,
`workday.svg`, `mailchimp.svg`, `canva.svg`, `calendly.svg`, `linear.svg`, `ashby.png`) — independent
corroboration that these are the marketed integrations. **PROVEN** for list and assets; INFERRED for the 1:1.

## 4.8 `desktopMount` — the always-on-top desktop panel

A genuine device integration: a borderless, position-persisted window floating on the user's desktop.
```js
// recon/beautified/main-app.beauty.js:85751-85769, verbatim (method list)
  zJe = Ko("desktop-mount", {
    methods: {
      mount: I().args({ agentId: re(), name: ze, markSvgDataUrl: Ron }),
      unmount: I().noArgs, offerChoices: I().args({ choices: xon }), read: I().noArgs,
      readChoices: I().noArgs, readLayout: I().noArgs, submitPrompt: I().args({ prompt: OF }),
      switchTo: I().args({ agentId: re() }), unmountSelf: I().noArgs,
      reachForMenu: I().args({ heightPx: Mon }), movePanel: I().args({ dx: jJe, dy: jJe }),
      endPanelMove: I().noArgs,
    },
    events: Nr(), failureCodes: Nr(),
  });
```
| Fact | Evidence | Tag |
|---|---|---|
| Page is `src/electron-renderer/desktop-mount/panel/panel.html` → `renderer/desktop-mount/panel/panel.html` | `85696`, `85781-85782` | PROVEN |
| Preload is `preload-desktop-mount-panel.cjs` (shipped in `dist/electron-preload/`) | `85780`; dir listing | PROVEN |
| Fixed geometry: panel `320 × 176`, avatar area `{x:12,y:60,w:56,h:56}`, constants `16` and `12` | `85784-85787` | PROVEN |
| Position persisted to `desktop-mount-position.json` in `userData` | `86091` | PROVEN |
| `movePanel({dx,dy})` is a **delta** API with a validated integer range; out-of-range is a failure, not a silent clamp | `85750`, `JJe` at `85812` | PROVEN |
| **macOS and Linux only** — `FJe(e) { return e === "darwin" \|\| e === "linux"; }` | `85699`; failure code `"desktop-mount/unsupported-platform"` at `85745` | PROVEN |
| Other failure codes: `"desktop-mount/nothing-mounted"`, `"desktop-mount/unknown-choice"` | `85746-85747` | PROVEN |
| Multi-display aware: prefers the work area with the largest overlap with its rect | `XJe` at `85783-85786`; `Bon(e,t)` overlap area at `85803-85819` | PROVEN |
| The agent's identity mark is an **SVG data URL** (`markSvgDataUrl`, validated as `"svg data url"`) | `85748`, `85754`, `85768`; `preload.beauty.js:742` | PROVEN |
| Mirrored in the preload and exposed as `contextBridge.exposeInMainWorld("desktopMount", …)` | `preload.beauty.js:740-757`, `4145` | PROVEN |
| The panel can grow to reveal a menu (`reachForMenu({heightPx})`) | method list | PROVEN |
| It is a **full mini-client**: it can submit a prompt and switch agent | `submitPrompt`, `switchTo` | PROVEN |
| `offerChoices({choices})` lets the backend offer which agent to mount when several are eligible; capped by a `"at most ${Ite} mount targets"` validator | method list; `85751` | PROVEN |

**INFERRED:** `desktopMount` is the "always there" surface for a Forever Box agent — the floating avatar that
remains on the desktop while the bot works. With `place_phone_call`/voice (§6) and the box-desktop modal
(§8), these form the device-integration story beyond the browser.

---

# 5. MCP: client, servers and MCP Apps

## 5.1 Transports
```js
// recon/beautified/main-app.beauty.js:57640-57657, abridged
      (Lbn = Zw({ type: To(Mit("stdio")), command: ao(), args: To(Jw(ao())), env: To(Bj(ao(), ao())),
                  envFile: To(ao()), cwd: To(ao()), enabledTools: To(Jw(ao())),
                  startupTimeoutSec: Pit(To(Tit().check(gF())), void 0) })),
      (Ubn = Zw({ type: To(Tae(["http", "sse"])), url: ao(), headers: To(Bj(ao(), ao())), auth: To(Dbn),
                  tls: To(Nbn), placement: To(Tae(["server", "client"])), enabledTools: To(Jw(ao())) })),
      (Qit = xit([Lbn, Ubn])),
      (Xw = Zw({ mcpServers: Bj(ao(), Qit) }));
```
| Fact | Evidence | Tag |
|---|---|---|
| Exactly **three** transports: `stdio`, `http`, `sse` | `Mit("stdio")`, `Tae(["http","sse"])` at `57643` / `57653` | PROVEN |
| Config top level is `{ "mcpServers": { "<name>": <server> } }` — the Claude/Cursor convention | `Xw` | PROVEN |
| A **`placement`** field distinguishes servers on the `server` (box) from the `client` (desktop) | `57655` | PROVEN |
| stdio supports `command`, `args[]`, `env{}`, **`envFile`**, `cwd`, `enabledTools[]`, `startupTimeoutSec` | `Lbn` | PROVEN |
| http/sse supports `url`, `headers{}`, `auth`, `tls`, `enabledTools[]` | `Ubn` | PROVEN |
| Client credentials are `{CLIENT_ID, CLIENT_SECRET?, scopes[]}` | `Dbn` at `57639` | PROVEN |
| A custom CA bundle is supported with a **128 KiB** ceiling | `Bbn = 128 * 1024`; `Nbn` at `57638-57640` | PROVEN |
| Transport inferred from shape when not explicit | `Idt(e) { return "command" in e ? "stdio" : e.type === "sse" ? "sse" : "http"; }` at `64709` | PROVEN |
| `type` normalised case-insensitively, defaulting to `http` | `Wxn(e)` at `66371` | PROVEN |
| Empty `command` (stdio) or empty `url` (http) are rejected as unusable | `Dce` at `66378-66381`, `Wdt` at `66382-66385` | PROVEN |
| Env placeholders are substituted before launch across `command`, `args`, `env`, `envFile`, `cwd` | `wdt(e,t)` at `64728-64740`; `Ice(e)` at `64723-64726` | PROVEN |
| A server with a negative id is treated as unavailable | `Oce(e) { return e < 0; }` at `66387` | PROVEN |
| Config discovery includes `.cursor/**/mcp.json` workspace patterns | `local-exec-daemon.beauty.js:32002` | PROVEN |
| **UNKNOWN:** which library implements MCP. `@modelcontextprotocol/sdk`, `StdioClientTransport`, `SSEClientTransport`, `StreamableHTTPClientTransport` are all absent; the only `modelcontextprotocol` hits are the unrelated extension URI `"io.modelcontextprotocol/related-task"` (`main-app.beauty.js:56721`, `local-exec-daemon.beauty.js:59400`) | — | **UNKNOWN** |

## 5.2 Manager and coordinator surface

| Method | Auth | Args | Evidence |
|---|---|---|---|
| `getMcpState`, `getMcpCatalog`, `getEffectiveMcpPlugins`, `getMcpPluginLogo` | `background` | — | coordinator auth table |
| `listMcpServerTools` | person | `wU` | `node-agent-coordinator.beauty.js:34361` |
| `toggleMcpToolDisabled` | person | `kK` | `34363` |
| `installMcpEntry` | `person` | `CZt` | `32905`, `34357`; `main-app.beauty.js:41203` |
| `updateMcpPluginInstall` | `person` | — | auth table |
| `refreshMcp` | **`background`** | `{completion?}` | `32922`, `34358` |
| `listBoxMcpServers` | **`background`** | `{serverIdentifiers[]}` | `32924`; `main-app.beauty.js:108446-108449` |
| `authenticateMcpServer` | `person` | `W5` | `32919`, `34356` |
| `completeMcpOAuth` | `person` | `{code, state}` | `32923`, `34359`; `main-app.beauty.js:41280` |
| `readMcpAppResource` | `person` | `Ws` | `32920`, `34364` |
| `callMcpAppTool` | `person` | `{serverIdentifier, toolName, argumentsJson, userActivated, agentId?}` | `34365-34371` |
```js
// recon/beautified/main-app.beauty.js:40665-40674, abridged (host settings)
        mcpCustomInstructions: (0, p.rpcOptional)(BF),
        mcpCustomInstructionsByServerId: (0, p.rpcOptional)(BF),
        mcpCustomInstructionsAccountScope: (0, p.rpcOptional)((0, p.rpcNullable)((0, p.rpcString)())),
        mcpDisabledToolsByServerId: (0, p.rpcOptional)((0, p.rpcRecord)((0, p.rpcArray)((0, p.rpcString)()))),
        mcpBoxServers: (0, p.rpcOptional)((0, p.rpcArray)((0, p.rpcString)())),
```
| Fact | Evidence | Tag |
|---|---|---|
| Custom instructions exist at three scopes: global, per-server-id, per-account | the four `mcpCustomInstructions*` fields | PROVEN |
| Tool disabling is **per server id**, as a record of string arrays | `mcpDisabledToolsByServerId` | PROVEN |
| `mcpBoxServers: string[]` names which servers live on the box | `mcpBoxServers`; `listBoxMcpServers` is `background` | PROVEN |
| `readMcpAppResource` args are `{serverIdentifier, resourceUri, agentId?, entryId?, sessionId?, documentSha256?}` | `Ws` at `node-agent-coordinator.beauty.js:34145-34151` | PROVEN |
| `documentSha256` lets the caller pin the exact document revision | `Ws`; re-checked at `main-app.beauty.js:40894-40897` | PROVEN |
| `callMcpAppTool` carries a **`userActivated`** boolean | `node-agent-coordinator.beauty.js:34364` | PROVEN |

> **`userActivated` is the strongest single design fact here.** With the injected activation reporter (§5.5)
> it means an MCP App **cannot call a tool purely because its script ran** — the host can require a real user
> gesture inside the app frame. That is the correct defence against a malicious app enumerating tools and
> firing them at load.

## 5.3 OAuth
```js
// recon/beautified/main-app.beauty.js:473-483, abridged
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
| Five redirect strategies keyed by short mode codes (`gb`, `gw`, `gd`, `xa`, `gd<port>`) | above | PROVEN |
| Redirect targets: `grokbot://mcp/oauth/callback`, `https://grok.com/connectors-oauth-exchange-code/`, `https://x.com/i/connectors/oauth_callback`, `http://localhost:8787/callback`, and loopback on 18787/28787/31787 | `Qpe`, `Dz` (`342`), `Nz` (`343`), `rs`, `uh` | PROVEN |
| A custom header marks a backend-relayed loopback callback | `Fz = "x-cursor-mcp-oauth-relayed-loopback"` | PROVEN |
| `cursor://anysphere.cursor-mcp/oauth/return` is another registered redirect | `QSt = \`cursor://${Upe}${Fpe}\`` with `Upe = "anysphere.cursor-mcp"`, `Fpe = "/oauth/return"` | PROVEN |
| Loopback redirect URIs must be **HTTP on a loopback host with an explicit port** | `` _w(e) `` at `54333-54338`: *"MCP OAuth redirect_uri must be a loopback HTTP URL."* / *"…must include a port."* | PROVEN |
| Accepted loopback hostnames: `localhost`, `127.0.0.1`, `::1`, `[::1]` | `_yn(e)` at `54323` | PROVEN |
| The callback listener claims the port across several candidate hosts and matches a fixed body | `hyn` at `54302-54304`; `Ayn` at `54313-54321` | PROVEN |
| Callback parsing requires a bounded `state`, accepts `code` or `error`, enforces pathname match, max query length and `GET` | `Hnt` at `54305-54312`; `byn` at `54339-54349` | PROVEN |
| Discovery uses RFC 9728 protected-resource metadata, cached with an expiry | `` `${n.origin}/.well-known/oauth-protected-resource${n.pathname.replace(/\/+$/, "")}` `` at `53288`; cache `att.set(…)` | PROVEN |
| Dynamic client registration is supported | `registration_endpoint`, `redirect_uris: Me(io)` at `57155-57222` | PROVEN |
| PKCE is negotiated | `code_challenge_methods_supported: Me(V()).optional()` at `57169` | PROVEN |
| `authenticateMcpServer` reports an outcome `connected \| cancelled` with a requesting agent id | `RK` at `node-agent-coordinator.beauty.js:34130-34139` | PROVEN |
| Deep-link auth callbacks are routed into the MCP manager and can be accepted **or rejected** | `main-app.beauty.js:98112-98116` | PROVEN |
| Backend RPC is `CompleteMcpOAuthRequest{stateId, authorizationCode}` | `main-app.beauty.js:96181` | PROVEN |
| Auth watching is a lifecycle module | error registry: `mcp-auth-watch-lifecycle.ts` for `authenticateServer` refusal branches, `checkAuthStatus` throw, `pollPendingAuthWatch` expiry | PROVEN |
| The loopback helper is its own module | error registry: `mcp-oauth-loopback.ts` `handleRequest` failure branches | PROVEN |

### Static connector registry

Shared defaults: `clientRegistration: "static"`; Google also `authorizationParams: {access_type:"offline",
prompt:"select_account consent"}`, `unauthenticatedConnect: !0`, `rejectsCustomSchemeRedirects: !0`
(`main-app.beauty.js:346-355`).
| Host | Provider | Notable | Evidence |
|---|---|---|---|
| `gmailmcp.googleapis.com` | `google-workspace` | `gmail.readonly`, `gmail.compose`, `gmail.modify` | `388-399` |
| `drivemcp.googleapis.com` | `google-workspace` | `drive.readonly`, `drive.file` | `400-405` |
| `calendarmcp.googleapis.com` | `google-workspace` | 4 calendar scopes | `406-415` |
| `docsmcp` / `sheetsmcp` / `slidesmcp.googleapis.com` | `google-workspace` | `documents` / `spreadsheets` / `presentations` | `416-418` |
| `bigquery.googleapis.com` | `google-workspace` | `bigquery` | `419` |
| `api.x.com` | `x` | 17 scopes incl. `dm.read`, `dm.write`, `developer.write`, `offline.access`; `pinsScopesOverConfiguredScopes: !0` | `420-446` |
| `mcp.money-dev/-staging/.x.com` | `x-money` | `backendOnlyTokenExchange: !0` | `447-449`, `349-355` |
| `connectors-gateway.grok.gcp.mouseion.dev`, `connectors-gateway.grok.com` | `grok-connectors` | scopes `grok-plugins:access`, `offline_access` | `455-456`, `364-371` |
| `mcp.hubspot.com` | `hubspot` | `backendOnlyTokenExchange: !0` | `457`, `358-363` |
| `setup.shopify.com` | `shopify` | `unauthenticatedConnect: !0`, `rejectsCustomSchemeRedirects: !1` | `458-466` |

**INFERRED:** `rejectsCustomSchemeRedirects: true` for Google/hubspot/x-money versus `false` for X and
Shopify explains the multi-mode redirect map: the app must pick a redirect strategy per provider, and hosts
that reject custom schemes are forced onto the HTTPS or loopback paths.

## 5.4 `sand-mcp-app:` — the iframe protocol
```js
// recon/beautified/main-core.beauty.js:20337-20377, abridged
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
  let n; try { n = new URL(e.url); } catch { return new Response(null, { status: 400 }); }
  let r = n.pathname.replace(/^\/+/, ""), o = Kl.get(r);
  return o === void 0 ? new Response(null, { status: 404 })
    : new Response(o.html, { status: 200,
        headers: { "content-type": mc, "content-security-policy": o.csp, "cache-control": "no-store" } });
}
function MT(e) { let t = URL.parse(e); return t?.protocol === `${gc}:` && t.host === bw; }  // bw = "app"
function vw(e, t) { return t != null && URL.parse(t)?.protocol === `${gc}:` && !MT(e); }     // popup detector
function Cw(e) { return () => e()?.checkFeatureGate("sand_mcp_apps", { disableExposureLog: !0 }) ?? !1; }
```
| Fact | Evidence | Tag |
|---|---|---|
| Frame URL shape is `sand-mcp-app://app/<uuid-v4>` | `xw` + `MT` | PROVEN |
| The document id is a **random UUID**, not derived from server+resource — app documents are not addressable across restarts | `LT.randomUUID()` | PROVEN |
| A second random UUID is minted as **`bridgeKey`**, a per-document secret for the `postMessage` bridge | `xw` return | PROVEN |
| Staged documents live in an in-memory `Map` capped at **32**, evicted FIFO | `Kl`, `tne = 32`, eviction loop | PROVEN |
| Only the **staged HTML** is served — never disk, never the network | `nne` returns `o.html` | PROVEN |
| The response sets a **per-document CSP header** *and* an equivalent `<meta>` | `headers["content-security-policy"]`; `Aw` injecting the meta | PROVEN |
| `cache-control: no-store` prevents serving a revoked app document from cache | `nne` | PROVEN |
| A disabled gate turns **every** request into `404`, not `403` | `if (!t()) return new Response(null, {status:404})` | PROVEN |
| Malformed URL → `400`; unknown id → `404` | `nne` | PROVEN |
| Leading slashes are stripped, so `sand-mcp-app://app///<uuid>` resolves identically | `n.pathname.replace(/^\/+/, "")` | PROVEN |
| `vw(e,t)` detects a **popup**: referrer is an mcp-app URL but the current URL is not | `vw`; used in `will-frame-navigate` handling at `main-core.beauty.js:28681-28687` | PROVEN |
| The whole subsystem is gated on `sand_mcp_apps`, which **defaults to `false`** | `main-app.beauty.js:48430`; `Cw` | PROVEN |
| Requesting an app while gated off raises a typed error with a literal message | `main-app.beauty.js:94053`: `throw new st({ code: Zqe, detail: "MCP Apps are behind the sand_mcp_apps gate." })` | PROVEN |
| An app document is capped at **8 MiB** | `DT = 8 * 1024 * 1024` at `main-core.beauty.js:20107`; helper `yw()` → `` `This MCP App document is larger than ${DT / (1024 * 1024)} MiB.` ``; code `hw = "mcp_app_saved_page_unavailable"` at `20106-20108` | PROVEN |
| A separate **256 KiB** constant `qBe` sits beside `DT` — most plausibly a saved-page/sidecar limit | `qBe = 256 * 1024` at `20102` | INFERRED |

## 5.5 The two injected bridge scripts

Every staged document is `<!DOCTYPE html><meta CSP>{activation}{resize}{author HTML}` (`Aw`).

**(a) Resize reporter** (`Zte`, `main-core.beauty.js:20202-20264`). Measures height from five independent
signals (`body.scrollHeight`, `body.offsetHeight`, `documentElement.offsetHeight`, a device-pixel-rounded
`getBoundingClientRect().height`, and `scrollHeight > clientHeight ? scrollHeight : 0`), takes the max, and
posts changes to `window.parent` with `targetOrigin: "*"`. It implements hysteresis — it refuses to shrink
while the parent has not yet applied the smaller height (`refusedHeight`, `shrunkTo`) — so a transient
layout collapse cannot ratchet the iframe down.

**(b) Activation reporter** (`ene`, `main-core.beauty.js:20265-20305`):
```js
// recon/beautified/main-core.beauty.js:20266-20282 and 20285-20306, abridged
  Qte = ["Escape","Alt","AltGraph","CapsLock","Control","Fn","FnLock","Hyper","Meta","NumLock",
         "ScrollLock","Shift","Super","Symbol","SymbolLock"];
…
	const activation = navigator.userActivation;
	const isActive = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(activation), "isActive").get;
	const keyOf = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, "key").get;
	const timeStampOf = Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp").get;
	const timeOrigin = performance.timeOrigin;
	post({ jsonrpc: "2.0", method: ${Km(Kte)} }, "*");        // Kte = "ui/notifications/sandbox-document"
	const reportIfActive = (event) => {
		if (!event.isTrusted || !apply(isActive, activation, [])) return;
		post({ jsonrpc: "2.0", method: ${Km($te)},         // $te = "ui/notifications/sandbox-activation"
		       params: { key: ${Km(e)}, activatedAtMs: timeOrigin + apply(timeStampOf, event, []) } }, "*");
	};
	addEventListener("pointerdown", reportIfActive, { capture: true, passive: true });
	addEventListener("keydown", (event) => {
		if (nonActivatingKeys[apply(keyOf, event, [])] !== true) reportIfActive(event);
	}, { capture: true, passive: true });
	script?.remove();
```
| Fact | Evidence | Tag |
|---|---|---|
| The bridge is **JSON-RPC 2.0 over `postMessage`** with `targetOrigin: "*"` | the `post({jsonrpc:"2.0", …}, "*")` calls | PROVEN |
| Exactly two notification methods: `ui/notifications/sandbox-document` (load) and `ui/notifications/sandbox-activation` (genuine activation) | `Kte`, `$te` at `20104-20105` | PROVEN |
| Activation requires `event.isTrusted` **and** `navigator.userActivation.isActive`, resolved through **saved property getters** so app code cannot trivially monkey-patch them | `apply(isActive, activation, [])`, `Object.getOwnPropertyDescriptor(...).get` | PROVEN |
| `activatedAtMs = performance.timeOrigin + event.timeStamp` — a shared clock the host can verify | `timeOrigin + apply(timeStampOf, event, [])` | PROVEN |
| Modifier-only and lock keys do **not** count as activation (15 keys) | `Qte` | PROVEN |
| The script **removes its own `<script>` element** after install, so app code cannot re-read it | `script?.remove()` | PROVEN |
| `Km(e)` escapes `<` as `\u003c` in the interpolated key literal, preventing a script-tag break-out | `Km` at `20260-20262` | PROVEN |
| Both scripts bind with `{capture: true, passive: true}` — observed without being cancellable by app code | `ene`, `Zte` | PROVEN |

> **Security assessment (PROVEN facts).** The activation bridge is well built: trusted-event and
> `userActivation` checks, saved getters, capture-phase passive listeners, self-removal, `<` escaping. The
> notable weakness is `targetOrigin: "*"` on the app→host direction — harmless outbound (the app is in an
> opaque origin and the parent is fixed) but it means the host must validate `event.source`, and the
> `bridgeKey` exists precisely because origin matching is unavailable. **Whether the host actually validates
> `bridgeKey` on inbound messages is not visible at the protocol-handler layer and remains UNKNOWN.**

## 5.6 Trays
```js
// recon/beautified/main-app.beauty.js:41231-41233, verbatim
          getTrays: I().noArgs,
          dismissTray: I().args({ id: (0, p.rpcString)() }),
          clearTrays: I().noArgs,
```
| Method | Auth class | Evidence |
|---|---|---|
| `getTrays` | `background` | `main-app.beauty.js:74299` |
| `dismissTray` | `person` | `74301` |
| `clearTrays` | `person` | `74302` |
| Claim | Tag | Reasoning |
|---|---|---|
| A tray is an **accumulated, id-addressable collection of pending items**: list-all / remove-one / remove-all | PROVEN | the three-method shape; `dismissTray({id})` is only meaningful if several coexist |
| Trays can be **read** unattended but **dismissed** only with the user present | PROVEN | auth table |
| Tray items are **informational**, not actionable: every neighbouring API has its own response handler (`respondToWidget`, `submitUserForm`, `resolveAutoReviewApproval`) while trays have only dismissal | INFERRED | comparison of methods at `main-app.beauty.js:41229-41244` |
| The tray item element type | — | **UNKNOWN** — no schema was found; the coordinator reply type is only `record` (`node-agent-coordinator.beauty.js:36915`) |

**INFERRED:** trays are where a background agent parks "here are the things that need you" items so the
user's attention is batched rather than interrupted — consistent with the product's "only comes back when
your approval is needed" positioning.

---

# 6. Voice harness

## 6.1 The `SAND_VOICE_HARNESS` switch

Exactly **one** occurrence in the whole evidence set:
```js
// recon/beautified/preload.beauty.js:4121, verbatim
      devVoiceHarness: process.env.SAND_VOICE_HARNESS === "backend" ? "backend" : "package",
```
| Fact | Evidence | Tag |
|---|---|---|
| The variable takes exactly two effective values: `"backend"` and the fallback `"package"` | above | PROVEN |
| Any other value — including unset — yields `"package"`; there is **no enum validation**, so a typo silently selects `package` | the ternary | PROVEN |
| It is a dev-only switch, surfaced on the preload object as `devVoiceHarness` | the property name | PROVEN |
| The package `@anysphere/voice-call-harness` and any dynamic `import`/`require` of it | **NOT FOUND** in any of the nine beautified bundles | — |
| Whether `"package"` means "use the bundled in-process harness" and `"backend"` means "delegate to the `VoiceCallHarness*` RPCs" | **INFERRED** — the pairing of the two values with the two available implementations is the only reading consistent with the naming, but no line states it | — |

## 6.2 The backend service
```js
// recon/beautified/node-agent-coordinator.beauty.js:28492-28493, verbatim
    voiceCallHarnessSession: { name: "VoiceCallHarnessSession", I: hh, O: Ah, kind: g.Unary },
    voiceCallHarnessTool:    { name: "VoiceCallHarnessTool",    I: Eh, O: _h, kind: g.Unary },
```
```text
VoiceCallHarnessSessionRequest|1 agent_id 9|2 agent_name 9|3 user_name 9?|4 description 9?|5 spoken_language 9?
VoiceCallHarnessSessionResponse|1 instructions 9|2 tools #0*|3 has_overheard 8|4 greeting #1|5 receipt #2
VoiceCallHarnessToolRequest|1 agent_id 9|2 call_id 9|3 name 9|4 input #0|5 line #1
VoiceCallHarnessToolResponse|1 kind #0|2 output #1
VoiceCallToolDescriptor|1 type 9|2 name 9|3 description 9|4 parameters #0
VoiceCallGreeting|1 direction 9|2 with_landed_work 9
VoiceCallLineState|1 they_just_talked 8|2 news_owed 8|3 receipt_owed 8|4 already_spoke_this_turn 8
VoiceCallReceipt|1 output #0|2 instructions 9 ; VoiceCallReceiptOutput|1 receipt 9
VoiceCallHarnessToolOutcomeKind :: UNSPECIFIED, SERVED, UNKNOWN_TOOL, INVALID_INPUT
```
| Fact | Evidence | Tag |
|---|---|---|
| Both RPCs are **unary** and sit on the same service descriptor as the virtual-card RPCs | `kind: g.Unary`; juxtaposition with `28260` | PROVEN |
| Service name `aiserver.v1.GrokBotService` | `FINDINGS.md:99` | PROVEN (prior recon) |
| The **server** decides the call's `instructions` and the entire `tools[]` list — the desktop does not choose them | `VoiceCallHarnessSessionResponse` fields 1-2 | PROVEN |
| Tool descriptors are a name/description/JSON-schema triple — the OpenAI Realtime "function tool" shape | `VoiceCallToolDescriptor` | PROVEN for the shape; INFERRED for the Realtime attribution |
| The server also supplies the **greeting**, its `direction`, and whether it should mention `landed_work` | `greeting #1` → `VoiceCallGreeting` | PROVEN |
| Tool outcomes are a closed enum; the server validates names and arguments | `SERVED`, `UNKNOWN_TOOL`, `INVALID_INPUT` | PROVEN |
| A tool call carries the **spoken `line`** alongside `input` — the harness knows what was said around it | field 5 | PROVEN |
| The session reports whether the model `has_overheard` | field 3 | PROVEN |
| A `receipt` couples a structured object to follow-up `instructions` | `VoiceCallReceipt` + `VoiceCallReceiptOutput` | PROVEN |
| `VoiceCallLineState` tracks four conversational booleans | `they_just_talked`, `news_owed`, `receipt_owed`, `already_spoke_this_turn` | PROVEN |

**INFERRED:** `news_owed` and `receipt_owed` are **conversational debt** flags, so the harness can decide each
turn whether the bot owes the caller information (`news`) or an acknowledgement (`receipt`). With
`already_spoke_this_turn` this is a turn-taking state machine, not a transcript buffer.

## 6.3 The realtime transport
```text
MintSandVoiceCallSecretRequest|1 model 9
MintSandVoiceCallSecretResponse|1 client_secret 9|2 expires_at_unix_seconds 3|3 model 9|4 websocket_url 9
```
```js
// recon/beautified/main-app.beauty.js:99061-99068, verbatim
var X$ = class e {
  static DIALABLE_ORIGIN = "wss://api.x.ai/";
  static isDialableURL(t) { return t.startsWith(e.DIALABLE_ORIGIN); }
  static undialableHostError(t) { return `${t} is not the allowed Sand voice-call realtime endpoint.`; }
};
```
| Fact | Evidence | Tag |
|---|---|---|
| Audio flows over a **WebSocket**, not WebRTC — `RTCPeerConnection`, `getUserMedia` and `MediaRecorder` appear **0 times** across all nine bundles | `websocket_url` field; grep counts | PROVEN |
| The only permitted realtime origin is `wss://api.x.ai/`, matched by `startsWith` on the full string | `DIALABLE_ORIGIN`, `isDialableURL` | PROVEN |
| Authentication is an **ephemeral `client_secret`** with a server-supplied expiry — the long-lived key never reaches the client | `MintSandVoiceCallSecretResponse` fields 1-2 | PROVEN |
| The model id is chosen server-side and echoed back | request field 1 → response field 3 | PROVEN |
| The endpoint is also probed in network diagnostics as `voice-realtime` | `99057`, `99364-99367` | PROVEN |

> **Note (INFERRED).** `startsWith("wss://api.x.ai/")` includes scheme and trailing slash, so the two classic
> bypasses fail: `wss://api.x.ai.evil.com/` (character after the host is `.`, not `/`) and
> `wss://api.x.ai@evil.com/` (`@` follows). The check is safe as written but is a **string comparison rather
> than a URL parse**, and it is *stricter* than a hostname check — `wss://api.x.ai:8443/` would also be
> rejected.

## 6.4 Presence, nudging, and the call record
```js
// recon/beautified/node-agent-coordinator.beauty.js:34326-34345, abridged
      setAgentVoice:        I().args({ id: q(), voiceId: A(at(p())), voiceSpeed: A(ne()), voiceLanguage: A(p()) }),
      previewVoice:         I().args({ voiceId: p(), greetingId: p() }),
      nudgeVoiceCall:       I().args({ id: q(), callId: p(), request: p(), spokenTurns: ae(p()) }),
      recordVoiceCall:      I().args({ record: rK }),
      setVoiceCallPresence: I().args({ id: q(), callId: p(), isOnTheLine: Z(), acceptsOverheard: A(Z()) }),
      getVoiceCall:         I().args({ id: q(), callId: p() }),
      readVoiceCallSentMessages: I().args(Tt),
      transcribeAudio:      I().args(vK),
```
| Method | Auth | What it does | Tag |
|---|---|---|---|
| `setAgentVoice` | `person` | sets `voiceId`, `voiceSpeed`, `voiceLanguage`; backend mirror `SetGrokBotAgentVoiceRequest\|1 id 9\|2 voice_id 9?\|3 voice_speed 2?\|4 voice_language 9?` | PROVEN |
| `previewVoice` | `person` | plays a sample identified by `{voiceId, greetingId}` — previews reuse real greeting audio | PROVEN for the shape; INFERRED for the reuse |
| `nudgeVoiceCall` | **`background`** | injects a `request` into a live call with `spokenTurns[]` — a supervising agent can steer a call it is not on | PROVEN |
| `recordVoiceCall` | `person` | commits a full call record | PROVEN |
| `setVoiceCallPresence` | `person` | two distinct booleans: `isOnTheLine` (is the human on the call) and `acceptsOverheard` (may audio be captured) | PROVEN |
| `getVoiceCall` | `person` | reads one call by `(agentId, callId)` | PROVEN |
| `readVoiceCallSentMessages` | **`background`** | messages the agent sent **during** the call — the bridge from a live call back to the text thread | PROVEN |
| `transcribeAudio` | (person) | `vK = w({audioBase64: NK, mimeType: p(), language: A(p())})` at `34168` — a **stateless, whole-utterance** transcription call | PROVEN |
```js
// recon/beautified/node-agent-coordinator.beauty.js:34013-34048, abridged
  Z$ = w({ id: p(), speaker: Ve(U("user"), U("assistant")), text: p(), atMs: ne() }),
  X$ = w({ id: p(), request: p(), atMs: ne(), answer: at(p()), answeredAtMs: A(at(ne())),
           direction: A(Ve(U("to-main"), U("to-voice"))),
           cut: A(at(w({ atMs: ne(), heardMs: ne() }))) }),
  Q$ = w({ kind: Ve(U("caller-speech-started"), U("caller-speech-stopped"), U("caller-interrupted"),
                     U("agent-speech-started"), U("agent-speech-stopped"), U("response-create"),
                     U("protocol-error")), atMs: ne(), … }),
  eK = w({ id: p(), name: p(), argumentsJson: p(), atMs: ne(), result: at(w({ json: p(), atMs: ne() })) }),
  tK = w({ id: p(), text: p(), atMs: ne() }),
  rK = w({ callId: p(), agentId: q(), model: p(), realtimeConversationId: A(at(p())),
           agentRequestId: A(p()), startedAtMs: ne(), endedAtMs: ne(), durationMs: ne(),
           ending: Ve(U("hung-up"), U("disconnected"), U("failed")),
           turns: ae(Z$), nudges: ae(X$), events: A(ae(Q$)), toolCalls: A(ae(eK)),
           overheard: A(ae(tK)), harnessMayCollect: A(Z()) }),
```
| Fact | Evidence | Tag |
|---|---|---|
| A recorded call has **six parallel streams**: `turns`, `nudges`, `events`, `toolCalls`, `overheard`, plus scalars | `rK` | PROVEN |
| Each turn is `{speaker: "user"\|"assistant", text, atMs}` — a diarised transcript, not raw audio | `Z$` | PROVEN |
| Each nudge records its **direction** (`to-main`/`to-voice`), whether it was answered, and if cut off how much was `heardMs` of the cut point | `X$`, especially `cut: {atMs, heardMs}` | PROVEN |
| VAD/endpointing is first-class: caller/agent speech start/stop, `caller-interrupted`, `response-create`, `protocol-error` | `Q$` | PROVEN |
| `realtimeConversationId` ties the record to the vendor-side session (also a host setting, bounded to 128 chars) | `rK` field 4; `main-app.beauty.js:40662`; `main-core.beauty.js:18554` | PROVEN |
| `harnessMayCollect` is a per-call recording-consent flag | `rK`; corroborated by `acceptsOverheard` | PROVEN |
| Overheard content is stored **separately** from turns | `overheard[]` vs `turns[]` | PROVEN |
| `ending` distinguishes a deliberate `hung-up` from `disconnected` and `failed` | `rK` | PROVEN |
| There is a first-class **phone-call** tool distinct from a voice call | `firstPartySendTools: [{name:"phone_call", toolName:"place_phone_call"}, {name:"imessage", toolName:"SendIMessage"}]` at `main-app.beauty.js:50848-50851` | PROVEN |
| Placing a phone call is approval-gated with copy naming the destination | `DmWmrW` = `"Place a phone call to ",["destination"]` | PROVEN |
| Meetings are a *different* subsystem with their own transcript and a buffering recorder | `GrokBotMeetingTranscriptLine`, `AdminGetGrokBotMeetingTranscript`, and `GrokBotMeetingRequestLogJevCall` with `lines`, `request_line_count`, `earlier_line_count`, `handoff_index`, `cancel`, `cancel_threshold`, `forced`, `saved`, `decision` | PROVEN |
| Six feature gates govern realtime voice: three per-client-surface gates, a steer kill-switch, and three `*_new_agent` variants | `glass_realtime_voice`, `web_realtime_voice`, `mobile_realtime_voice`, `realtime_voice_steer_kill_switch`, `glass/web/mobile_realtime_voice_new_agent` at `48699-48705` | PROVEN |
| A fourth client surface exists beyond desktop/mobile | `GrokBotClientSurface :: UNSPECIFIED, DESKTOP, MOBILE, GLASS` | PROVEN |

## 6.5 What distinguishes a voice call from a text thread

| Dimension | Text thread | Voice call |
|---|---|---|
| Transport | coordinator RPC → backend | direct client↔`wss://api.x.ai/` with an ephemeral `client_secret` |
| Other party | a prompt author | `turns[].speaker ∈ {user, assistant}` plus VAD events |
| Steerability | `sendPrompt` (`person`) | `nudgeVoiceCall` (**`background`**) — a background agent can steer a live call |
| Model | per-agent settings | server-minted per call session |
| Tools | MCP servers + local tools | **server-supplied** `tools[]` for the call |
| Recording | transcript entries in the agent transcript | a separate `recordVoiceCall` payload with six streams |
| Consent | turn-level approvals | per-call `acceptsOverheard` + `harnessMayCollect` |
| Cross-over | — | `readVoiceCallSentMessages` exposes call content to the thread |
| Injection surface | user-authored text | **ambient audio from a third party who may not be the user** |

> **Security assessment (INFERRED).** A voice call is a distinctly weaker-authority channel: content is
> authored by whoever is on the line, it arrives as untrusted audio, there is no per-message approval gate,
> and the bot is being instructed in real time. The mitigations present are real — a server-controlled tool
> list (the model cannot invent tools), `UNKNOWN_TOOL`/`INVALID_INPUT` validation, and `nudgeVoiceCall` being
> `background` so a supervisor can intervene — but the *authorization* boundary sits at the tools the session
> was minted with, not at the utterance.

---

# 7. Channel integrations

## 7.1 Platform inventory
```text
GrokBotAgentSessionKind :: UNSPECIFIED, MAIN, SLACK_DM, SLACK_THREAD, DM, GROUP, TEAMS_DM, TEAMS_THREAD, TEAMS_GROUP_CHAT
GrokBotEmailProvider :: UNSPECIFIED, GOOGLE, MICROSOFT
GrokBotEmailDirection :: UNSPECIFIED, INBOUND, OUTBOUND
GrokBotEmailSearchMode :: UNSPECIFIED, HYBRID, KEYWORD, SEMANTIC
GrokBotEmailBodyStatus :: UNSPECIFIED, AVAILABLE, NOT_INDEXED, PURGED, REJECTED
GrokBotEmailAddressAvailability :: UNSPECIFIED, AVAILABLE, YOURS, TAKEN, INVALID, RESERVED, NOT_CONFIGURED
GrokBotEmailSuppressionReason :: UNSPECIFIED, PERMANENT_BOUNCE, COMPLAINT, UNSUBSCRIBE_REQUEST, MANUAL
```
| Fact | Evidence | Tag |
|---|---|---|
| Two external platforms are modelled with per-surface session kinds: **Slack** (DM, thread) and **Microsoft Teams** (DM, thread, group chat) | `GrokBotAgentSessionKind` | PROVEN |
| Generic `DM` and `GROUP` also exist — Grok Bot's own conversations | idem | PROVEN |
| **Email** is modelled with two providers, both directions, and a local-part allocation concept | the `GrokBotEmail*` enums | PROVEN |
| Email has a suppression list with standard reasons | `GrokBotEmailSuppressionReason` | PROVEN |
| **GitHub** has a **GitHub App** installation flow, not plain OAuth — the args include `installationId` and `setupAction` | `completeGithubConnect: I().args({state, code?, installationId?, setupAction?, error?})` at `main-app.beauty.js:41138-41144` | PROVEN |
| **iMessage** is a first-party send channel | `{name:"imessage", toolName:"SendIMessage"}` at `50851`; the macOS Messages worker reads `chat.db` (`FINDINGS.md:118-120`) | PROVEN |
| **Phone calls** are a first-party send channel | `50850` | PROVEN |
| **Discord** is marked "coming soon" in the shipped strings | `8feLum` = `"Message in Discord servers and DMs (coming soon)"` | PROVEN |
| Slack and Teams are **also** labelled "coming soon" in one string each, despite complete client code | `y54UoK`, `mszXTG` | PROVEN |
| A fourth UI list of integration names exists for a different feature | `Lne = ["figma","slack","linear","notion-workspace"]` at `49534` | PROVEN |

> **Apparent contradiction.** `GrokBotAgentSessionKind` models Slack/Teams session kinds in detail and
> `GrokBotSlack*` models a full install lifecycle, yet UI strings say "coming soon". **INFERRED:** the shipped
> string catalog lags capability (compiled `.po` files are not pruned), or these channels are server-gated
> while the client is complete. The client side is clearly finished: `grok-bot-slack-dialog-live.js` ships,
> and `GrokBotSlackInstallOutcome` has 13 outcomes including `RATELIMITED`, `SLACK_REJECTED`,
> `INSUFFICIENT_SCOPES`, `PENDING_ADMIN_APPROVAL` and `WORKSPACE_NOT_ALLOWED`.

## 7.2 Coordinator methods
```js
// recon/beautified/main-app.beauty.js:41128-41141 and 41231-41234, abridged
          getListenerIntegrations: I().noArgs,
          getListenerConnectUrl: I().args({ platform: (0, p.rpcString)(),
            forceOauth: (0, p.rpcOptional)((0, p.rpcBoolean)()), oauthRedirectUri: XFe }),
          disconnectListenerPlatform: I().args({ platform: (0, p.rpcString)() }),
          completeGithubConnect: I().args({ state, code?, installationId?, setupAction?, error? }),
          getAgentChannels: I().args(Yo),
          connectChannel: I().args({ ...O5, token: (0, p.rpcString)() }),
          disconnectChannel: I().args(O5),
          refreshChannel: I().args(O5),
```
| Method | Auth | Args | Evidence |
|---|---|---|---|
| `getAgentChannels` | `person` | `Yo` (shared agent-id object) | `74303`, `41231` |
| `connectChannel` | person | channel descriptor `O5` **plus a `token`** | `41232` |
| `disconnectChannel` / `refreshChannel` | person | `O5` | `41233-41234` |
| `getListenerIntegrations` | `person` | none → reply `record` | `41129`, `74244`; `node-agent-coordinator.beauty.js:32830`, `34312`, `36916` |
| `getListenerConnectUrl` | `person` | `{platform, forceOauth?, oauthRedirectUri}` | `41130-41134` |
| `disconnectListenerPlatform` | `person` | `{platform}` | `41135` |
| `completeGithubConnect` | `person` | `{state, code?, installationId?, setupAction?, error?}` | `41136-41142` |

## 7.3 What a "listener" is

| Concept | Meaning | Evidence | Tag |
|---|---|---|---|
| **Channel** | an *outbound* destination bound to **one agent** — `connectChannel` requires a `token` and `refreshChannel` re-validates it | the three channel methods; `storeSecret`'s `{kind:"channel-credential", platform, field}` target at `node-agent-coordinator.beauty.js:34211-34213` | PROVEN for the shape; INFERRED for "outbound" |
| **Listener** | an *inbound* integration bound to the **platform/account**, not to one agent — `getListenerIntegrations` takes no agent id and `disconnectListenerPlatform({platform})` is platform-scoped | `main-app.beauty.js:41128-41134` | PROVEN |
| The connect flow can be forced through OAuth and accepts a caller-supplied redirect URI | `getListenerConnectUrl` args | PROVEN |
| A listener connect can fail in a way that leaves the bot unable to resume | key `caw2Vm` = `"Bot failed to resume after listener connect"` | PROVEN |
| Whether a listener is a webhook receiver, a poller, or a broker subscription | — | **UNKNOWN** |

### Slack / Teams install lifecycle
```text
GrokBotSlackInstallStatus    :: NOT_CONNECTED, APP_CREATED, CONNECTED, UNSUPPORTED_HARNESS
GrokBotSlackInstallOutcome   :: INSTALLED, PENDING_ADMIN_APPROVAL, NOT_CONNECTED, WORKSPACE_REQUIRED,
                                MANAGER_REAUTH_REQUIRED, INSUFFICIENT_SCOPES, INSTALL_CONFLICT, RATELIMITED,
                                SLACK_REJECTED, UNSUPPORTED_HARNESS, NOT_PUBLISHED, WORKSPACE_NOT_ALLOWED
GrokBotSlackReinstallOutcome :: UPDATED, UP_TO_DATE, RECREATE_REQUIRED, PENDING_ADMIN_APPROVAL, NOT_CONNECTED,
                                MANAGER_REAUTH_REQUIRED, INSUFFICIENT_SCOPES, RATELIMITED, SLACK_REJECTED,
                                UNSUPPORTED_HARNESS, THROTTLED
GrokBotSlackConnectOutcome   :: STARTED, UNSUPPORTED_HARNESS, NOT_PUBLISHED
GrokBotSlackConnectFailureKind :: CANCELLED, ORG_INSTALL, WRONG_CURSOR_ACCOUNT, INCOMPLETE
GrokBotSlackUninstallOutcome :: REMOVED, NOT_CONNECTED, MANAGER_REAUTH_REQUIRED, RATELIMITED, SLACK_REJECTED, UNSUPPORTED_HARNESS
GrokBotTeamsInstallState     :: NOT_CONNECTED, CONNECTED, APP_CREATED, PENDING_ADMIN_APPROVAL, INSTALLED,
                                UPDATE_PENDING, REMOVED_IN_TEAMS, REMOVED, UNSUPPORTED_HARNESS, NOT_PUBLISHED, UNAVAILABLE
```
| Fact | Evidence | Tag |
|---|---|---|
| Grok Bot **creates its own Slack app** in the workspace (`APP_CREATED` precedes `CONNECTED`) rather than asking the customer to install a pre-existing app | state ordering | PROVEN for states; INFERRED for the flow |
| Reinstall can require **recreating** the app | `RECREATE_REQUIRED` | PROVEN |
| The integration is tied to a specific Grok Bot account — wrong account is a distinct failure | `WRONG_CURSOR_ACCOUNT` | PROVEN |
| Org-wide installs are a special case that can be refused | `ORG_INSTALL` | PROVEN |
| Workspaces can be disallowed server-side | `WORKSPACE_NOT_ALLOWED` | PROVEN |
| The Slack connect form collects **`app id`**, **`bot token`** and **`app token`** | i18n keys `ndxqGN`, `qWvCPP`, `hN+ReX`; UI chunk `grok-bot-slack-dialog-live.js` | PROVEN |
| Slack messaging requires a validated channel **address** | `WP+7HZ` = `"\"",["address"],"\" isn't a valid channel address, so that message wasn't delivered"` | PROVEN |
| Delivery failures are reported with platform name + technical detail | `XdaOH0`; `beZty6` = *"…isn't connected on this computer, so that message wasn't delivered. Connect [platform] (add its token) to send there."* | PROVEN |
| Channel messaging can be unavailable on a given machine, as a handled state | `QS9fR1` = `"Channel messaging isn't available on this computer, so that message wasn't delivered"` | PROVEN |
| Follow-up turns from channel messages are tracked separately | `Z1AYSG` `"Channel message follow-up failed"`; `6W/ZQ/` `"Broadcast message failed"` | PROVEN |

### Outbound-send classification
```js
// recon/beautified/main-app.beauty.js:50808-50859, abridged (grok_bot_external_send_labeling_config fallback)
            connectors: [
              { name: "slack",   hosts: ["mcp.slack.com"], sendTools: ["slack_send_message", "slack_schedule_message"] },
              { name: "gmail",   hosts: ["gmailmcp.googleapis.com", "api.cursor.com"],
                sendTools: ["send_message","reply","forward","send_email","send_draft"] },
              { name: "outlook", hosts: ["api.cursor.com/rest-mcp/outlook"],
                sendTools: ["send_mail","reply_to_mail_message","forward_mail_message","send_draft"] },
              { name: "google_calendar", hosts: ["calendarmcp.googleapis.com","api.cursor.com"],
                sendTools: ["create_event","update_event"], participants: {...}, ownerArgs: ["calendarId"] },
              { name: "outlook_calendar", hosts: ["api.cursor.com"],
                sendTools: ["create_calendar_event","update_calendar_event"], participants: {...} },
              { name: "google_drive_share", hosts: ["drivemcp.googleapis.com","api.cursor.com"],
                sendTools: ["share_file","google_drive_share_file"] },
              { name: "teams",   hosts: ["api.cursor.com"],
                sendTools: ["send_chat_message","send_channel_message","reply_to_channel_message"] },
            ],
            firstPartySendTools: [ { name: "phone_call", toolName: "place_phone_call" },
                                   { name: "imessage",   toolName: "SendIMessage" } ],
            labelAutoReviewSends: !1, autoReviewSendsSampleRate: 0,
            subagentCommitOutcomeSampleRate: 0.01, unsentSampleRate: 0,
            skipSubagentDelegation: !1, lowStakesReviewedSampleRate: 1,
```
| Fact | Evidence | Tag |
|---|---|---|
| "Sending" is defined **per connector as a list of tool names**, not by a heuristic | the `sendTools` arrays | PROVEN |
| The mapping is server-configurable (it lives in a `fallbackValues` block with `sampleRate`) | the enclosing gate object | PROVEN |
| Calendar events have an explicit notion of **participants** and **owner**, with several accepted spellings for the same concept (`attendees`, `attendeeEmails`, `addedAttendees`, `addedAttendeeEmails`, `addAttendees`) — a hedge against MCP schema drift | `participants.args`, `ownerArgs` | PROVEN |
| Sending is **not** auto-labelled by default | `labelAutoReviewSends: !1`, `autoReviewSendsSampleRate: 0` | PROVEN |
| An auto-review sampling pipeline over agent commits exists | `subagentCommitOutcomeSampleRate: 0.01`, `lowStakesReviewedSampleRate: 1`; `resolveAutoReviewApproval`; `GrokBotAutoReviewApprovalResolution` | PROVEN |

> **INFERRED (design intent).** This config is the mechanism behind "the bot messages people on your behalf"
> appearing in a review queue rather than happening silently: external *sends* are enumerated by tool name so
> they can be labelled, sampled and gated by auto-review, while *reads* are not.

---

# 8. VNC / remote desktop

## 8.1 What is displayed

The remote desktop is the **box** — a cloud VM hosting the always-on agent. Its desktop is served as a
**noVNC** page inside a `<webview>` on the privileged partition.
| Fact | Evidence | Tag |
|---|---|---|
| The client is **noVNC** | `preload-vnc.beauty.js:1712-1722` reads the DOM classes `noVNC_connected`, `noVNC_reconnecting`, `noVNC_connecting`, `noVNC_disconnecting`; `702-708` names noVNC's own module paths `./core/rfb.js`, `./core/display.js`, `./core/websock.js` | PROVEN |
| noVNC is **not shipped in the app** — nothing under `dist/` matches `*novnc*`/`*vnc*` except the preload | `find dist -iname "*novnc*" -o -iname "*vnc*"` | PROVEN |
| The viewer page is therefore **served by the box** over the network; the app only injects a preload | `sx(e) { return e.pathname.endsWith("/vnc.html"); }` at `main-app.beauty.js:107936` | PROVEN |
| The preload installs into the page's own `window.ui.rfb` (noVNC's UI global) | `var rfb = ui && ui.rfb;` at `preload-vnc.beauty.js:983`, `1043`, `1189`, `1821-1822` | PROVEN |
| Export is `installVncPreload` | `Ae(_r, { installVncPreload: () => et })` at `40`; impl `function et(e = we)` at `1896` | PROVEN |
| The viewer UI is the box-desktop modal chunk | `chunk-box-desktop-modal--0USskmH.js` (26,420 B) | PROVEN for the file; INFERRED for the mapping |

## 8.2 The noVNC surface the preload patches
```js
// recon/beautified/preload-vnc.beauty.js:700-707, verbatim
var D = [
  { member: "keyEvent", modulePath: "./core/rfb.js" },
  { member: "QEMUExtendedKeyEvent", modulePath: "./core/rfb.js" },
  { member: "pointerEvent", modulePath: "./core/rfb.js" },
  { member: "_damage", modulePath: "./core/display.js" },
  { member: "_recvMessage", modulePath: "./core/websock.js" },
  { member: "fbUpdateRequest", modulePath: "./core/rfb.js" },
  { member: "flip", modulePath: "./core/display.js" },
];
```
| Fact | Evidence | Tag |
|---|---|---|
| The preload requires **seven specific noVNC internals** and fails loudly if any is missing | table above; `` `noVNC RFB lacks messages.${n.member}` `` at `921` | PROVEN |
| It patches the input path (`keyEvent`, `QEMUExtendedKeyEvent`, `pointerEvent`) and the framebuffer path (`_damage`, `flip`, `_recvMessage`, `fbUpdateRequest`) | `D` | PROVEN |
| Chords are injected via `rfb.sendKey(keysym, code, down)` with explicit modifier press/release around them | `1832-1836` | PROVEN |
| Held modifiers are released defensively on teardown | `1828` | PROVEN |
| Clipboard integration uses noVNC's own `clipboardPasteFrom(text)` | `845-846` | PROVEN |
| The live socket is `ui.rfb._sock` (used for diagnostics) | `1189` | PROVEN |
| **INFERRED:** because it patches *internals*, this integration is **pinned to a specific noVNC version**; a box image upgrade changing them trips the guard. That fail-loud coupling is why the viewer is served by the box rather than bundled | — | INFERRED |

## 8.3 Channels

| Channel | Direction | Payload | Evidence |
|---|---|---|---|
| `sand:vnc-session` | webview → host | `JSON.stringify({phase, clean})`, phases `rfb_connect`, `reconnect`, `rfb_disconnect` | `1697`, `1722-1723` |
| `sand:vnc-host-key` | webview → host | a bare key name, restricted to `ArrowUp/Down/Left/Right` | `682`, `1685-1694` |
| `sand:vnc-interactive` | host → webview | interactivity toggle | `687` |
| `sand:vnc-accepts-input` | host → webview | whether the viewer accepts input | `688` |
| `sand:vnc-liveness` | host → webview | liveness probe (10 s period, 3 strikes: `_e = 1e4`, `vn = 3`) | `694-695` |
| `sand:vnc-viewer-visible` | host → webview | boolean; drives frame-hold and clipboard-mirror gating | `698`, `1735`, `1749` |
| `sand:mouse-history-navigation` | webview → host | `-1`/`+1` from mouse buttons 3/4 | `1279`; `preload-webview.beauty.js:106-135` |
| `sand:encode-png` | renderer → main → worker | PNG encode over a `MessageChannelMain` port | `main-app.beauty.js:98602`; `preload.beauty.js:564` |
| `sand:render-trace-port` | renderer → main | a `MessagePort` for render-trace delivery | `main-core.beauty.js:28244`; `preload.beauty.js:4071` |
```js
// recon/beautified/preload-vnc.beauty.js:1698-1723, abridged
  function p() {
    let c = document.documentElement.classList;
    return c.contains("noVNC_connected")     ? "connected"
         : c.contains("noVNC_reconnecting")  ? "reconnecting"
         : c.contains("noVNC_connecting")    ? "connecting"
         : c.contains("noVNC_disconnecting") ? "disconnecting" : "disconnected";
  }
  function m() {                       // s = connect count
    let c = p();
    c !== u && ((u = c),
      c === "connected" ? ((s += 1), a(s > 1 ? "reconnect" : "rfb_connect", !0), (d = !0))
                        : d && c !== "connecting" && (a("rfb_disconnect", c === "disconnecting"), (d = !1)));
  }
```
| Fact | Evidence | Tag |
|---|---|---|
| State is observed by a `MutationObserver` on `documentElement`'s `class` attribute — **no noVNC event API is used** | `new MutationObserver(m)`, `attributeFilter: ["class"]` at `1727-1729` | PROVEN |
| The observer disconnects on `pagehide` (`{once: true}`) to avoid a leak | `1730` | PROVEN |
| The first `rfb_connect` of a page's life reports `clean: true`; later connects report `reconnect` | `a(s > 1 ? "reconnect" : "rfb_connect", !0)` | PROVEN |
| `rfb_disconnect` reports `clean` only when the state was `disconnecting` | `a("rfb_disconnect", c === "disconnecting")` | PROVEN |
| A dedicated liveness detector is its own module | error registry: `"createVncLivenessDetector emission in box-vnc-liveness.ts"` at `main-core.beauty.js:27119` | PROVEN |

## 8.4 Adaptive quality
```js
// recon/beautified/preload-vnc.beauty.js:713-738, verbatim
var hn = {
  low: 6, high: 8, raiseAtMbps: 15, lowerBelowMbps: 11, maxEstimateMbps: 30,
  sampleWeight: 0.25, sampleMinBytes: 96 * 1024, sampleMinMessages: 3,
  raiseHoldMs: 1e4, maxRaiseHoldMs: 16e4,
};
function Xt(e, { quality: n, link: t, sampleMbps: i, nowMs: o }) {
  let a = t.estimateMbps == null ? i : t.estimateMbps + e.sampleWeight * (i - t.estimateMbps),
    s = Math.min(a, e.maxEstimateMbps);
  return n > e.low && s < e.lowerBelowMbps
    ? { quality: e.low, estimateMbps: s, raiseNotBeforeMs: o + t.raiseHoldMs,
        raiseHoldMs: Math.min(t.raiseHoldMs * 2, e.maxRaiseHoldMs) }   // doubling backoff
    : n < e.high && s >= e.raiseAtMbps && o >= t.raiseNotBeforeMs
      ? { ...t, quality: e.high, estimateMbps: s }
      : { ...t, quality: n, estimateMbps: s };
}
```
| Fact | Evidence | Tag |
|---|---|---|
| Two-level controller between noVNC quality **6** and **8** | `low: 6`, `high: 8` | PROVEN |
| Bandwidth estimated by an **EWMA** (`sampleWeight = 0.25`) over samples of ≥96 KiB and ≥3 messages | `sampleWeight`, `sampleMinBytes`, `sampleMinMessages` | PROVEN |
| Estimate capped at 30 Mbps | `maxEstimateMbps: 30` | PROVEN |
| Drops below 11 Mbps, raises at/above 15 Mbps — a 4 Mbps hysteresis band | `lowerBelowMbps: 11`, `raiseAtMbps: 15` | PROVEN |
| After a downgrade it refuses to raise for a hold that **doubles** each successive downgrade, capped at 160 s | `raiseHoldMs: 1e4`, `Math.min(t.raiseHoldMs * 2, e.maxRaiseHoldMs)`, `maxRaiseHoldMs: 16e4` | PROVEN |
| Controller state lives on the global marker `"__sandVncAdaptiveQuality"` | `740` | PROVEN |
| **INFERRED:** the doubling backoff is anti-flap for a congested link, so a viewer on a bad connection settles at quality 6 instead of oscillating | — | INFERRED |

## 8.5 Frame holding, host keys, clipboard

| Behaviour | Detail | Evidence |
|---|---|---|
| Frame hold | When the viewer is hidden or the host reports it not visible, the preload injects a script into the page to hold frame rendering, and the inverse when it returns | `gr({...})` at `1736-1758`; generators `An(p)`, `Mn(f)`, `On(y)`; listener `1749` |
| Arrow keys | Forwarded **to the host**, not the remote desktop — the user can navigate host UI while the viewer is focused | `mr({...})` at `1679-1695` |
| Clipboard mirror | A scheduled loop named `"vnc-clipboard-mirror"` reconciles local and remote clipboards, reading the host clipboard over the `box-vnc` RPC; triggers on `focus`, `mousedown` (capture) and `visibilitychange` | `1640-1678`; RPC `me("box-vnc", {methods:{readClipboard: noArgs, writeClipboard: args({text})}})` at `683` |
| Clipboard commit | Host text is committed into the local clipboard and written into the page's own editable element if present | `f.commitHostText(g)`, `E.value = g` at `1640-1644` |
| Logging | Specific failure messages: `"vnc clipboard paste failed"`, `"vnc clipboard read failed"`, `"vnc host key forward failed"`, `"vnc session report failed"`, `"vnc frame hold failed"` | `1646`, `1666`, `1692`, `1704`, `1743` |

### Box access tokens and hibernation
```js
// recon/beautified/main-app.beauty.js:107945-107950 and 107960-107965, verbatim
    i = [ { queryParam: "port_token",    header: "x-anyrun-port-token" },
          { queryParam: "network_token", header: "x-anyrun-network-token" } ];
…
  let d = [ { queryParam: "resume_lower_s", header: "x-anyrun-hibernation-lower-bound-s" },
            { queryParam: "resume_upper_s", header: "x-anyrun-hibernation-upper-bound-s" } ],
    u = new Set(["mainFrame", "subFrame", "webSocket"]),   // resource types that get the headers
    f = new Map();
```
| Fact | Evidence | Tag |
|---|---|---|
| The box platform is named **"anyrun"** in header names | the four headers above | PROVEN |
| Access tokens travel as **URL query parameters** and are then promoted into request headers by an `onBeforeSendHeaders` hook on the box session | the tables; `U.requestHeaders[ee.header] = ee.value` at `108043-108045` | PROVEN |
| Tokens are learned from any URL carrying them and cached **per host** | `s = new Map()`; `c(P)` sets `s.set(U.host, G)` | PROVEN |
| Provenance is tracked as `"url"`, `"cached"` or `"none"` for diagnostics | `S`, `E(P)`, `b(P)` at `107991-108001` | PROVEN |
| Hibernation bounds are injected **only** for `mainFrame`, `subFrame`, `webSocket` — excluding images/scripts/fonts | `u`, `A(P)` at `108009-108012` | PROVEN |
| Hibernation headers are suppressed entirely when the viewer may not wake the box | `e.mayViewerWakeBox?.() === !1 ? [] : …` at `108012`; `viewerMayWakeBox: () => o !== void 0 && o.awayPark.parksUntilNeeded() && o.awayPark.isLive()` at `75017` | PROVEN |
| Bounds are read from the VNC page URL itself | `g(P)` at `107966-107970`, gated on `sx(U)` | PROVEN |
| An asset failure (HTTP ≥400) is reported once per host with `token_seeded`, `token_source`, `resource: "page"\|"asset"` | `R(P,U)` at `108003-108018`; event `"vncAssetFail"` | PROVEN |
| Hosts returning 5xx are not re-reported; 4xx clears the per-host suppression | `if (U < 400) {C.delete(G.host); return;} if (U >= 500 \|\| C.has(G.host)) return;` | PROVEN |
| Zoom is pinned to 1 and visual zoom limits disabled | `setVisualZoomLevelLimits(1,1)`, `setZoomFactor(1)` at `108022-108027` | PROVEN |
| Only `http:`/`https:`/`about:` sources are allowed on attach | `108062-108064` | PROVEN |
| Loopback is trusted for the VNC page | `isLoopbackHostname(U.hostname) \|\| o.has(U.origin)` at `108035` | PROVEN |
| Box lifecycle states and intents are fully modelled | `GrokBotBoxHandBackTrigger :: BUTTON, VIEWER_CLOSED, DISMISSED`; `handBackForeverBox({id, trigger?, requestId?})` at `41254-41258`; `GrokBotBoxIntent :: APP_FOREGROUND, APP_BACKGROUND, CHAT_OPEN, COMPOSER_FOCUS, TYPING, UPLOAD_START, FILE_OPEN, COMPUTER_OPEN`; `GrokBotBoxIntentAction :: NONE, IN_FLIGHT, PRETHAW, REFUSED`; `GrokBotBoxDiskPressureLevel :: NONE, SOFT, HARD`; `GrokBotSessionBoxCredentialState :: ABSENT, PRESENT, REVOKED` | PROVEN |

> **Security assessment.** Box access tokens travel in query strings and are then lifted into headers. Query
> strings are logged by proxies, retained in history, and readable via `location.href` inside the box-origin
> page — which the injected preloads can read. The mitigation is that a token grants access only to *that
> user's own* box over the `anyrun` fabric, and headers are attached only to hosts whose URL once carried a
> token. The residual risk is **URL-borne token leakage**, not privilege escalation. The `mayViewerWakeBox`
> gate is a deliberate cost control: the viewer cannot keep a hibernating box awake by accident.

## 8.6 `encode-png` and `render-trace-port`

| Channel | Implementation | Evidence |
|---|---|---|
| `sand:encode-png` | A `MessageChannelMain` round-trip to a worker; the request carries `gpuRaster: app.getGPUFeatureStatus().rasterization.startsWith("enabled")`; guarded by a 10 s deadline policy `"sand-encode-png"`; response normalised via `Buffer.from(e.buffer, e.byteOffset, e.byteLength)` | `main-app.beauty.js:98599-98601`, `98604-98617` |
| Purpose | PNG encoding for the **clipboard** — `pngClipboard: process.platform` selects a platform encoder | `108917` |
| Failure telemetry | `onEdgeFailure` with `{leg, errorClass}` — legs are named, so each stage reports separately | `98721-98722` |
| Signature constant | `Uint8Array.of(0,0,0,1,115,82,71,66,0,174,206,28,233)`; the tail 8 bytes are the PNG magic | `98597` |
| `sand:render-trace-port` | A `MessagePort` handoff: `UF = "sand:render-trace-port"` at `main-core.beauty.js:28244`, `renderTracePorts: lJ` exported at `40684`, installed at `main-app.beauty.js:108977` | PROVEN |
| Render trace bound at window construction | `FF(u.webContents, a.deliverPort)` with `renderTrace: a` | `main-core.beauty.js:28624`, `28657` |
| Renderer bridge member is `sandRenderTrace.postMessage` | `FINDINGS.md:47` | PROVEN (prior recon) |
| A dedicated renderer hook chunk exists | `dune-render-trace-hook.js` | PROVEN for the filename |

---

# 9. Attachments and the media pipeline

## 9.1 Coordinator surface
```js
// recon/beautified/node-agent-coordinator.beauty.js:33960-33963, 34410-34419, 34256
var L$ = w({ agentId: A(q()), filename: p(), bytesBase64: p() }),
  U$ = w({ agentId: A(q()), uploadId: p(), filename: p(), offset: ne(), totalSize: ne(), bytesBase64: p() }),
  J$ = w({ agentId: A(q()), path: p() }),
  G$ = w({ agentId: A(q()), path: p(), offset: ne(), length: ne(), videoPlayback: A(Z()) }),
…
      uploadAttachment:      I().args(L$),
      uploadAttachmentChunk: I().args(U$),
      readAttachmentImage:   I().args({ … }),
      readAttachmentText:    I().args(J$),
      readAttachmentChunk:   I().args(G$),
      searchMedia:           I().args({ query: p(), limit: A(ne()) }),
```
| Method | Args | Notes | Tag |
|---|---|---|---|
| `uploadAttachment` | `{agentId?, filename, bytesBase64}` | whole-file, base64 | PROVEN |
| `uploadAttachmentChunk` | `{agentId?, uploadId, filename, offset, totalSize, bytesBase64}` | resumable: `uploadId` + `offset` + `totalSize` | PROVEN |
| `readAttachmentText` | `{agentId?, path}` | **by path**, not id | PROVEN |
| `readAttachmentChunk` | `{agentId?, path, offset, length, videoPlayback?}` | random access; the `videoPlayback` hint lets a player request seek-friendly ranges | PROVEN |
| `readAttachmentImage` | an object with at least the same `path` family (descriptor truncated in evidence) | — | PROVEN for existence |
| `searchMedia` | `{query, limit?}` | search over the media store, distinct from attachment reads | PROVEN |
| All attachment methods are `person`-class | `node-agent-coordinator.beauty.js:32929-32933`-region | an unattended agent cannot exfiltrate files by itself | PROVEN |

## 9.2 Staging
```js
// recon/beautified/main-app.beauty.js:77341-77342
      stageAttachmentBytes: I().args({ filename: (0, p.rpcString)(), bytes: (0, p.rpcUint8Array)() }),
      stageAttachmentPath: I().args({ filename: (0, p.rpcString)(), sourcePath: (0, p.rpcString)() }),
// recon/beautified/preload.beauty.js:4102-4106
  { stageAttachmentPath: Tu, ..._i } = Fe(si, fi),
      stagePath: Tu,
      stageBytes: (e, n) => _i.stageAttachmentBytes({ filename: e, bytes: n }),
```
| Fact | Evidence | Tag |
|---|---|---|
| Two staging forms: raw `bytes` as a `Uint8Array`, or a `sourcePath` the host reads itself | the two methods | PROVEN |
| The preload exposes them as `stageBytes(filename, bytes)` (positional) and `stagePath({filename, sourcePath})` (object) — argument order differs | `4103-4107` | PROVEN |
| `stageBytes` is preferred; `stagePath` is the fallback | `` ? await e.stagePath({filename: n, sourcePath: a}) `` at `4088` | PROVEN for the fallback site; INFERRED for the order |
| A third entry `stageAttachmentFile: (e, n) => mi(Cu, e, n)` handles a file object | `4127` | PROVEN |
| Staging validates size with an explicit reason | `R2(e) { return e.size === 0 ? {ok:!1, reason:"empty"} : e.size > e.limitBytes ? {ok:!1, reason:"too-large"} : null; }` at `68499-68501` | PROVEN |
| The limit is **per file name/kind**, not one global cap | `byteLimitForName: (H) => sye({storeUploads: u()}).forName(H)` at `108602`; `sye(e) { return e.storeUploads ? bMt : EMt; }` at `68495-68497` | PROVEN |
| Limits differ depending on whether uploads are stored | `storeUploads` selects `bMt` or `EMt` | PROVEN |
| Enforced at least twice — staging and commit | `R2({size: J.byteLength, …})` at `73228`; `R2({size: se, …})` at `73242` | PROVEN |

## 9.3 Upload modes and refusals
```text
GrokBotAttachmentUploadMode    :: UNSPECIFIED, USE_BOX, SINGLE_PUT, MULTIPART, REFUSED
GrokBotAttachmentUploadRefusal :: UNSPECIFIED, TOO_LARGE, AGENT_FULL, EXPIRED, INCOMPLETE, SIZE_MISMATCH,
                                  NOT_AN_IMAGE, TARGET_CHANGED, UNSUPPORTED_TYPE
GrokBotAttachmentReadOutcome   :: UNSPECIFIED, STORE, NOT_IN_STORE, NO_STORAGE
```
| Fact | Evidence | Tag |
|---|---|---|
| Attachments can be routed to the **box** or uploaded directly via single PUT or multipart | `GrokBotAttachmentUploadMode` | PROVEN |
| Storage can be **full** per agent — quota is per-agent | `AGENT_FULL` | PROVEN |
| Uploads are time-bounded sessions that can expire or arrive incomplete | `EXPIRED`, `INCOMPLETE` | PROVEN |
| Size is verified end-to-end | `SIZE_MISMATCH` | PROVEN |
| The upload target is validated at commit — an upload cannot be committed to a different destination | `TARGET_CHANGED` | PROVEN |
| Image validation is separate from MIME validation | `NOT_AN_IMAGE` vs `UNSUPPORTED_TYPE` | PROVEN |
| Reads distinguish in-store / not-in-store / no-storage-at-all | `GrokBotAttachmentReadOutcome` | PROVEN |
| The mode is a *recorded outcome*, so the client reports which path it took | `REFUSED` is a mode value | INFERRED |

## 9.4 `sand-media:` in the pipeline
```js
// recon/beautified/main-core.beauty.js:21592-21596, verbatim
function Xne(e) { return async (t) => (Ym(t.url) ? await e(t) : await Kne(t)); }
function DL(e) { (eA.protocol.handle(No, Xne(e)), eA.protocol.handle(fc, qne)); }
// recon/beautified/main-core.beauty.js:40661 — the injected handler
      DL(async (h) => (await _o.serveAttachmentImage?.(h)) ?? new Response(null, { status: 503 })),
```
| Fact | Evidence | Tag |
|---|---|---|
| Matching `sand-media` requests go to the injected handler; everything else falls through to `Kne` | `Xne` | PROVEN |
| The handler is `serveAttachmentImage(url)`; a missing implementation yields **503**, not 404 | `40662` | PROVEN |
| Attachments are **pre-captioned** with their own outcome enum | `GrokBotImagePrecaptionOutcome :: CAPTIONED, ALREADY_CAPTIONED, NOT_NEEDED, SKIPPED, FAILED, SKIPPED_FOR_AGENT`; `createPrecaption: V1e(Mt)` and `preuploads: f.preuploads` at `108604-108620` | PROVEN |
| Pre-captioning can be skipped specifically *for an agent* | `SKIPPED_FOR_AGENT` | PROVEN |
| Provider rejections are surfaced with provider-specific copy | `B61yen` = `"The image provider rejected this description. Try rewording it."`; `EmajJ3` = the content-policy variant naming trademarked characters/brands/real people | PROVEN |
| Attachments are queued before upload and progress is emitted as `"attachment-commit-progress"` | `onCommitProgress` at `108612` | PROVEN |
| Attachment failures have their own telemetry class and named operations | `onEdgeFailure` at `108611`; ops `sand.attachment.commit`, `sand.attachment.read`, `sand.image.edge_failed` at `70180-70182` | PROVEN |
| Commit telemetry carries a level and metadata from `TVe(H)` | `108613-108616` | PROVEN |
| **UNKNOWN:** the remote upload target. No pre-signed URL construction, S3/GCS key pattern, `putObject` or `presign` call was isolated; `SINGLE_PUT`/`MULTIPART` strongly implies pre-signed object storage, but vendor and bucket addressing are undetermined. Nearby base URLs are `api2.cursor.sh` (`FINDINGS.md:31`) and `api.cursor.com` (`main-app.beauty.js:365`), neither tied to attachment upload in the evidence gathered | — | **UNKNOWN** |

---

# 10. Limitations

## 10.1 What could not be resolved

| # | Limitation | Impact |
|---|---|---|
| L1 | **`main-app.cjs` was never fully analysed by REA** — `"Maximum call stack size exceeded"` (`projection-summary.json`, limitations[12]); coverage **partial** | REA-derived IPC/contextBridge counts undercount. All conclusions here come from direct reading of the beautified bundles, not REA |
| L2 | REA's **primitive-string budget was exceeded** (1 MiB) | REA string-level findings are truncated; not relied upon here |
| L3 | **No source maps** (`FINDINGS.md:43`) | Original TS names unrecoverable except via the error registry (Appendix B) |
| L4 | **No MCP client SDK identified** (§5.1) | Which library, hence which protocol revisions, is UNKNOWN |
| L5 | **`@anysphere/voice-call-harness` not found** despite the brief naming it | The `backend` vs `package` distinction is INFERRED, not proven |
| L6 | `eg` and `Bne` (preview size bounds) not resolved to literals | Max preview size UNKNOWN |
| L7 | **No tray item schema** — coordinator reply type is only `record` | Tray contents UNKNOWN |
| L8 | **Whether the coordinator loopback port authenticates** — no token in `claim`; the registry names only `"coordinator port sinks in electron-main/main.cts"` | Local-process threat model cannot be completed |
| L9 | **Whether the MCP App host validates `bridgeKey` on inbound `postMessage`** is not visible at the protocol-handler layer | The isolation boundary's last hop is UNKNOWN |
| L10 | Attachment storage vendor / bucket addressing | UNKNOWN |
| L11 | Listener transport (webhook, poller, broker subscription) | UNKNOWN |
| L12 | Whether 1Password enforces its own user-presence prompt in addition to Grok Bot's approval | Effective strength of that path UNKNOWN |
| L13 | **`resolve-media`** not isolated; not a registered scheme; channel vs function unresolved | UNKNOWN |
| L14 | The four `.node` addons were not inspected as binaries; REA notes native member names "are not verified binary exports" (`projection-summary.json`, limitations[6]) | Native behaviour is second-hand |
| L15 | **`sand-webauthn-signer` and `sand-op-launcher` were not disassembled.** Proven to exist, to be spawned, and (for the signer) to speak a documented newline-delimited JSON protocol; their internal CTAP2 correctness is **UNVERIFIED** | Passkey security claims rest on the *caller's* code, not the signer's |
| L16 | **Only macOS was inspected.** `Info.plist`, TCC URLs and Finder automation are darwin-specific; Windows/Linux paths exist in code but are unverified | Platform claims are macOS-only unless stated |
| L17 | **Gate defaults were read from client `fallbackValues`**, overridden by the server | A gate showing `default: !1` may be enabled in production |
| L18 | **No runtime verification.** Nothing here was executed; every claim is static (caveat C2) | — |

## 10.2 Claims deliberately *not* made

- Grok Bot does **not** use CDP to script pages — the only CDP-shaped code is a `node:inspector` wrapper (§1.1).
- Grok Bot does **not** ship a browser engine beyond Electron; box browsing reaches the user as **images over noVNC**, not a live DOM.
- The vault does **not** appear to store full card numbers — only `brand`/`last4`/`exp_month`/`exp_year` (§2.2).
- `sand-media:` does **not** appear to enforce per-request authorization (§4.3).
- The `sand-canvas:` sandbox does **not** include `allow-same-origin`; it **does** include `allow-popups-to-escape-sandbox` (§4.4).
- MCP Apps are **not** enabled by default in the client fallback (§5.4).

## 10.3 Recommended next steps

1. **Disassemble `sand-webauthn-signer`** — the trust anchor for every passkey and spend approval (§2.4, §2.7). Confirm CTAP2 conformance, that no PIN is written to disk, and that retry counting matches the authenticator rather than the host.
2. **Disassemble `sand-op-launcher`** — verify that the `launcherVerification: "anysphere"` identity check is enforced by the parent and cannot be bypassed by replacing the binary.
3. **Test whether the coordinator loopback port authenticates** (L8).
4. **Locate the MCP App host-side `message` listener** and confirm `bridgeKey` and `event.source` validation (L9).
5. **Resolve remote attachment storage** from a live session trace (L10).
6. **Establish listener semantics** by observing `getListenerConnectUrl` per platform (L11).
7. **Determine effective gate values** for `sand_mcp_apps`, `sand_import_chrome_cookies`, `sand_box_egress_tunnel`, `sand_new_1pass`, `agent_prompted_cookie_sync` (L17).

---

# Appendix A — Protobuf enum inventory (verbatim values)

Extracted from `L(n, $, "Name", [[0,"UNSPECIFIED"],…], 1)` protobuf enum constructors. **Enum names are
real** — they survive minification as string literals; the minified constructor binding is not.

**Automation, box and device**
| Enum | Values |
|---|---|
| `GrokBotAgentHarnessKind` | BOX, TEMPORAL |
| `SandCredentialDecisionHarness` | BOX, TEMPORAL |
| `GrokBotTemporalHarnessMode` | OFF, SHADOW, LIVE, BOX |
| `GrokBotSessionBoxPodState` | ABSENT, REACHABLE, HIBERNATED, STARTING, UNKNOWN |
| `GrokBotSessionBoxCredentialState` | ABSENT, PRESENT, REVOKED |
| `GrokBotBoxIntent` | APP_FOREGROUND, APP_BACKGROUND, CHAT_OPEN, COMPOSER_FOCUS, TYPING, UPLOAD_START, FILE_OPEN, COMPUTER_OPEN |
| `GrokBotBoxIntentAction` | NONE, IN_FLIGHT, PRETHAW, REFUSED |
| `GrokBotBoxDiskPressureLevel` | NONE, SOFT, HARD |
| `GrokBotBoxHandBackTrigger` | BUTTON, VIEWER_CLOSED, DISMISSED |
| `GrokBotBoxHarnessMigrationPassState` | DISABLED, DONE, PENDING |
| `SandBoxRunState` | ABSENT, HIBERNATED, RUNNING, STARTING |
| `SandBoxMigrationPhase` | BACKING_UP, CREATING, MOVING, CLEANING_UP, WIPING, DONE, FAILED |
| `SandBoxUpgradeScheduleState` | SCHEDULED, CLAIMED, RUNNING, WAITING_FOR_IMAGE, COMPLETED, MISSED, FAILED, CANCELLED |
| `SandBoxStoreManifestCommitStatus` | COMMITTED, RETRY, FENCED |
| `SandBoxStoreMultipartOperationFailureCode` | PRECONDITION_FAILED, UPLOAD_NOT_FOUND, INVALID_PARTS, CHECKSUM_MISMATCH, TRANSIENT, INTERNAL, RESTART_REQUIRED |
| `BulkTeamMemberSandBoxAction` | KILL, RECREATE, PERMANENT_DELETE |
| `BulkTeamMemberSandBoxItemState` | QUEUED, RUNNING, SUCCEEDED, SKIPPED, FAILED |
| `BulkTeamMemberSandBoxOperationState` | RUNNING, SUCCEEDED, PARTIALLY_SUCCEEDED, FAILED |
| `AdminRefreshSandBoxEgressStatus` | PUSHED, NO_BOX, ERROR |
| `AdminRefreshSandBoxEgressTrigger` | SINGLE, BULK |
| `AdminRefreshSandBoxEgressLabelOutcome` | REFRESHED, SKIPPED, UNSUPPORTED_HOST, FAILED |
| `GrokBotUserComputerMessagesConsentVerdict` | STANDING, ASK, REFUSED |

**Identity, credentials and approvals**
| Enum | Values |
|---|---|
| `GrokBotVaultItemKind` | LOGIN, CARD, CONTACT |
| `CredentialTargetRuleKind` | EXACT_HOST_PORT, REGISTRABLE_DOMAIN |
| `CredentialExpirationMode` | DISABLED, WARN, ENFORCE |
| `CredentialLifecycleState` | ACTIVE, EXPIRING, GRACE, EXPIRED, PROVIDER_REJECTED |
| `GrokBotCredentialRequestResolution` | APPROVED, DENIED |
| `OnePasswordConnectionKind` | SERVICE_ACCOUNT, OAUTH_BROKER |
| `OnePasswordBrokerConnectionState` | PAIRING, CONNECTED, RECONNECT_REQUIRED |
| `OnePasswordSyncTrigger` | MANUAL, APP_FOCUS |
| `PasskeyCeremonyKind` | REGISTER, APPROVE, APPROVE_WITH_REGISTRATION |
| `PasskeyCeremonyStatus` | PENDING, COMPLETED, FAILED, EXPIRED |
| `SpendApprovalCeremonyMode` | ASSERT, REGISTER |
| `GrokBotVirtualCardRaiseOutcome` | RAISED, ALREADY_PENDING |
| `GrokBotVirtualCardResolution` | APPROVED, DENIED |
| `GrokBotVirtualCardOutcome` | APPROVED, DENIED, NEEDS_AUTH, FAILED, NEEDS_PASSKEY |
| `GrokBotStripeLinkPaymentMethodKind` | CARD, BANK_ACCOUNT |
| `GrokBotStripeLinkPaymentMethodsOutcome` | OK, NEEDS_AUTH, UNAVAILABLE |
| `GrokBotConnectorType` | USER, TEAM |
| `GrokBotConnectorGrantResolution` | ALLOWED, SKIPPED, ALWAYS_THIS_BOT, ALWAYS_ALL_TEAM_BOTS, ALLOW_IN_CHANNEL |
| `GrokBotToolPermission` | ALWAYS_ALLOW, NEEDS_APPROVAL, BLOCKED |
| `GrokBotLocalToolPermissionCardResolution` | ALLOW_ONCE, DENY, ALWAYS, NEVER |
| `GrokBotAutoReviewApprovalResolution` | APPROVED, DENIED, ALWAYS |

**Channels, email, attachments, voice**
| Enum | Values |
|---|---|
| `GrokBotAgentSessionKind` | MAIN, SLACK_DM, SLACK_THREAD, DM, GROUP, TEAMS_DM, TEAMS_THREAD, TEAMS_GROUP_CHAT |
| `GrokBotSlackInstallStatus` | NOT_CONNECTED, APP_CREATED, CONNECTED, UNSUPPORTED_HARNESS |
| `GrokBotSlackInstallOutcome` | 12 values — §7.3 |
| `GrokBotSlackReinstallOutcome` | 11 values — §7.3 |
| `GrokBotSlackUninstallOutcome` | REMOVED, NOT_CONNECTED, MANAGER_REAUTH_REQUIRED, RATELIMITED, SLACK_REJECTED, UNSUPPORTED_HARNESS |
| `GrokBotSlackConnectOutcome` | STARTED, UNSUPPORTED_HARNESS, NOT_PUBLISHED |
| `GrokBotSlackConnectFailureKind` | CANCELLED, ORG_INSTALL, WRONG_CURSOR_ACCOUNT, INCOMPLETE |
| `GrokBotTeamsInstallState` | NOT_CONNECTED, CONNECTED, APP_CREATED, PENDING_ADMIN_APPROVAL, INSTALLED, UPDATE_PENDING, REMOVED_IN_TEAMS, REMOVED, UNSUPPORTED_HARNESS, NOT_PUBLISHED, UNAVAILABLE |
| `GrokBotEmailProvider` | GOOGLE, MICROSOFT |
| `GrokBotEmailDirection` | INBOUND, OUTBOUND |
| `GrokBotEmailSearchMode` | HYBRID, KEYWORD, SEMANTIC |
| `GrokBotEmailBodyStatus` | AVAILABLE, NOT_INDEXED, PURGED, REJECTED |
| `GrokBotEmailAddressAvailability` | AVAILABLE, YOURS, TAKEN, INVALID, RESERVED, NOT_CONFIGURED |
| `GrokBotEmailSuppressionReason` | PERMANENT_BOUNCE, COMPLAINT, UNSUBSCRIBE_REQUEST, MANUAL |
| `GrokBotAttachmentUploadMode` | USE_BOX, SINGLE_PUT, MULTIPART, REFUSED |
| `GrokBotAttachmentUploadRefusal` | TOO_LARGE, AGENT_FULL, EXPIRED, INCOMPLETE, SIZE_MISMATCH, NOT_AN_IMAGE, TARGET_CHANGED, UNSUPPORTED_TYPE |
| `GrokBotAttachmentReadOutcome` | STORE, NOT_IN_STORE, NO_STORAGE |
| `GrokBotImagePrecaptionOutcome` | CAPTIONED, ALREADY_CAPTIONED, NOT_NEEDED, SKIPPED, FAILED, SKIPPED_FOR_AGENT |
| `VoiceCallHarnessToolOutcomeKind` | SERVED, UNKNOWN_TOOL, INVALID_INPUT |

**Other enums are out of scope for this section.** The registry also defines platform, account, roster,
task, template, marketplace, changelog, feedback and turn-failure enums (for example
`GrokBotClientSurface :: DESKTOP, MOBILE, GLASS`, `GrokBotNotificationPlatform :: MACOS, WINDOWS, LINUX, IOS, ANDROID`,
`GrokBotTaskState :: WORKING, NEEDS_INPUT, DONE`, `GrokBotTurnFailureCode :: INTERNAL, TIMEOUT, USAGE_LIMIT,
RATE_LIMIT, TEAM_POLICY_UNAVAILABLE, UNPAID_INVOICE, PROVIDER_CONTENT_BLOCKED`). They belong to the
product-surface and agent-runtime sections of this dossier, not to web automation and device integration.

All tables in this appendix omit the leading `UNSPECIFIED` (value 0) for brevity; it is present in every enum.

---

# Appendix B — Original module names recovered from the error registry

The bundles contain a **named error-code registry** whose entries carry a `seededFrom:` provenance string.
Those strings frequently cite the **original TypeScript source file**, otherwise unrecoverable (no source
maps — L3). This is the highest-value structural artifact found: it restores module boundaries that
minification erased. **103** distinct entries exist across the four main bundles.
```js
// shape, e.g. recon/beautified/main-core.beauty.js:26459
    seededFrom: "sandErrorTags emit-boundary validation in registry.ts",
```
Modules directly relevant to this section:
| Original module | Cited for |
|---|---|
| `cookie-origin-approval-executor.ts` | `CookieOriginApprovalNoWindowError` branches; `collectCookiesForGrants` catch; `listCookieAllowItems` catch; `matchCookieOriginApprovalItems` empty branch |
| `cookie-origin-approval-bridge.ts` | `askTtl` expiry in `request`; `selectProvider` live-resolve miss |
| `cookie-origin-approval-service.ts` | `inject` catch |
| `chrome-cookie-import-service.ts` | `isEnabled()` false branch in `inject` |
| `main-edge.ts` | `importChromeCookies` catch |
| `webauthn-proxy-bridge.ts` | `requestCeremony` `DeadlineExceededError` and `provider.send` throw; `selectProvider` empty registry / live-resolve miss; unattributed error settlement |
| `node-agent-coordinator/webauthn/provider.ts` | consent decline branch; signer error frames |
| `mcp-auth-watch-lifecycle.ts` | `authenticateServer` refusal branches; `checkAuthStatus` throw; `pollPendingAuthWatch` expiry |
| `mcp-oauth-loopback.ts` | loopback `handleRequest` failure branches |
| `onepassword-connection-service.ts` | `detectMint` not-ready readiness states; `startMint` failure mapping (`mintError`) |
| `box-vnc-liveness.ts` | `createVncLivenessDetector` emission (`main-core.beauty.js:27119`) |
| `forever-box-service.ts` | `DeadlineExceededError` branch; image-check catch fallback |
| `local-exec-bridge.ts` | `requireProvider` for `providers.size === 0`, live-resolve miss, missing/unknown `computerId`, messages-op capability branch |
| `local-exec-native.ts` | `spawnLocalExecDaemon` error observer |
| `gateway-reachability.ts` | `classifyGatewayFetchFailure` (`refused`, `timeout`, `dns`, `network`); `classifyGatewayHttpResponse` (`http_5xx`, `pod_hibernated`, `access_denied`); `SandGatewayFailureMetadata` `no-storage` |
| `gateway-client.ts` | `stallWatchdog` downReason `stall-timeout` |
| `cursor-auth.ts` | `runRefreshAccessToken` (`fetch` throw, non-ok `/oauth/token`, unreadable body/empty `access_token`, `shouldLogout` sign-out, MDM policy verdict); `storeAuthentication` → `noteSecretsUnavailableSession` |
| `transcript-mirror.ts` | `commitCheckpoint`, `prepareCheckpoint`, `recover`, `initialize` rebuild branch |
| `electron-renderer/client/sand-client.ts` | `restore` catch; restore stuck deadline |
| `client/send/send-journal.ts` | `NONCE_DIGEST_MISMATCH`, `SAND_SOURCE_CAPABILITY_UNAVAILABLE`, `markAckTimedOut`, `retireCanceled`, rejected acceptance status in `resolveRecord` |
| `client/persistence.ts` | `PersistenceRegistry` port-operation catch; `isQuotaFailure` branch of `reportThrown`; `parseEnvelope` corrupt + `noteValueRejected` |
| `agent-identity-service.ts` | `SandAgentIdentityService` reconcile/push/delete failure legs |
| `agent-db.ts` | `SandCheckpointPublicationError` latestRootBlobId publish gate |
| `turn-runtime.ts` | `classifyAgentError` fallback; `isProviderCapacityError` + `serverRetryAfterMsFromError`; `isRetryableProviderError` true/false + `findBackendConnectError` |
| `transient-stream-error.ts` | `isBackendUnreachableError`, `isContextOverflowDeadEnd`, `isFirstTokenStallError`, `isProviderCapacityError`, `isStreamIdleError`, `isTransientStreamError` |
| `conversation-size-limits.ts` | `SandConversationTooLargeError` turn gate |
| `electron-main/main.cts` | `app.whenReady` bootstrap catch; coordinator port sinks — note the **`.cts`** extension, i.e. CommonJS TypeScript |
| `host/ports/telemetry.ts` | `SAND_BOX_BOOT_STAGES` |
| `host-lifecycle-progress.ts` | `HostLifecycleProgress` watchdog and `.fail` |
| `coordinator-account-runtime.ts` | `stop()` deadline |
| `sand-update-service.ts` | `checkForUpdates` abort closure; `onSquirrelError` while ready with a requested apply |
| `update-telemetry.ts`, `update-gate.ts`, `apply-marker.ts` | update classification, disabled-reason and apply-settlement branches |
| `structured-log-transport.ts`, `desktop-structured-log-telemetry.ts`, `structured-log-telemetry.ts` | `isDeadlineExpiry` in `shipLogs`; `policyStopped` rows |
| `desktop-startup-telemetry.ts` | stuck watchdog |
| `registry.ts` | `sandErrorTags` emit-boundary validation |
| `entrypoint.ts` | bundle entrypoint naming (`"entrypoint.ts"` literal in `main-core.beauty.js`) |

**INFERRED layout.** The monorepo is roughly `electron-main/` (main process, `.cts`),
`electron-renderer/client/` (renderer RPC client with a send-journal and a persistence registry),
`node-agent-coordinator/` (with a `webauthn/` subpackage), `host/ports/` (a ports-and-adapters layer, per
`host/ports/telemetry.ts`), plus feature modules named `*-service.ts` / `*-bridge.ts` / `*-executor.ts` /
`*-lifecycle.ts` / `*-watcher.ts`. The `bridge → service → executor` split recurs for **both** cookie
approval and WebAuthn, which suggests a deliberate three-layer pattern.

---

# Appendix C — Renderer chunk inventory (feature map)

`recon/grokbot-0.71.2/dist/renderer/assets/` holds **588** files named either
`chunk-<feature>-<hash>.js` or `<feature>-<hash>.js`; the `<feature>` segment is a real source-derived name.
Abridged to feature-bearing chunks (the ~120 language/syntax-highlight chunks are omitted):
| Group | Chunks |
|---|---|
| **Box / device / computer** | `box-desktop-modal`, `computer-screen-preview`, `provider-computer-use`, `desktop-mount-panel` (+ `.css`), `demo-computer-wallpaper-BO7Ye4dV.jpg` |
| **Teach / routines** | `teach-recording-controls`, `automation-detail-panel`, `sand-auto-review-instructions` |
| **MCP / plugins / connectors** | `grok-bot-team-custom-mcp`, `team-bot-custom-plugins`, `team-bot-carry-over-plugin-selection`, `plugin-detail-view`, `plugins-rows`, `native-plugin-detail`, `native-plugin-state`, `native-connector-card`, `connector-auth-telemetry`, `grok-bot-slack-dialog-live` |
| **Approvals / policy** | `auto-review-approval`, `auto-review-rule-notice`, `auto-review-selector`, `provider-local-tool-permission`, `provider-team-policy`, `provider-credentials`, `provider-listener-integrations`, `provider-computer-use` |
| **Identity / secrets** | `grok-bot-secrets`, `grok-bot-secret-problem-text`, `agent-avatar-editor`, `team-setup-new-secret-dialog`, `team-bot-service-accounts`, `-dialog`, `-shown`, `-tiles` |
| **Channels / listener** | `channel`, `listener-integrations`, `messages`, `draft-composer-bubble`, `draft-send-error`, `group-chat-connect-waiting`, `new-chat-bar` |
| **Canvas / artifacts / documents** | `document-page`, `fullscreen-file-viewer-body` (+ `.css`), `file-stage`, `file-markdown` (+ `.worker`, `-hast`), `markdown-table-card`, `transcript-markdown`, `pdf` (+ `pdf.worker.min.mjs`), `xlsx`, `code-body`, `diff` |
| **Team bots** | `team-bot-details-dialog`, `-details-pane`, `-details-rows`, `-overview-panel`, `-overview-section`, `-setup-grid`, `-teammate-intro`, `-line-render`, `-context-dialog`, `team-agent-rows`, `use-team-bot-access` |
| **Bots / templates / marketplace** | `bot-template-details-dialog`, `-details-focus`, `-share-card-frame`, `template-editor-dialog`, `marketplace-browse-model`, `cloud-agent-card-elevated`, `cloud-agent-artifact-open-telemetry` |
| **Voice / media** | `voice-memo-bubble`, `tmp-1-open-blip.wav` … `tmp-5-chime-b.wav`, `gallery-loop-B8hAOxyN.mp3`, `interaction-scope`, `scale-layer` |
| **Diagnostics** | `network-debugger-dialog`, `dune-render-trace-hook`, `sentry-sdk`, `connect`, `session` |
| **Diagram / render engine** | `mermaid.core` + ~30 `*Diagram-*.js` (c4, class, er, gantt, gitGraph, mindmap, quadrant, requirement, sankey, sequence, state, timeline, venn, wardley, xychart, ishikawa, kanban, block, packet/architecture), `cytoscape.esm`, `dagre`, `cose-bilkent`, `katex`, `markdown-math-katex` |
| **Vendor logos (connector corroboration)** | `salesforce.svg`, `workday.svg`, `mailchimp.svg`, `canva.svg`, `calendly.svg`, `linear.svg`, `link.svg`, `rippling.png`, `snowflake.png`, `quickbooks.png`, `databricks.png`, `tableau.png`, `clay.png`, `zoominfo.png`, `nooks.png`, `ashby.png`, `apollo.png` |

**INFERRED:** that `desktop-mount-panel`, `computer-screen-preview`, `provider-computer-use`,
`box-desktop-modal` and `teach-recording-controls` are **lazy chunks** rather than part of the main bundle
is consistent with the device-integration surfaces being feature-gated and loaded only when their gate is on.

---

*End of section 04.*
