# 01 - Grok Bot Desktop: Architecture, Process Topology, Bootstrap, IPC and Renderer Composition

Target: **Grok Bot** macOS desktop app, bundle id `com.anysphere.sand`, `CFBundleShortVersionString` `0.71.2`,
`package.json` name `sand`, `sandTrack` `stable`, `sandBuiltAt` `2026-10-14T17:38:40.722Z`.
Internal codename throughout the codebase is **sand** / **dune**; the product name is **Grok Bot**.

This document is one section of a reverse-engineering dossier. It is written to enable a clean-room
reimplementation of the *interfaces and behaviours* described here. It deliberately does not reproduce the
proprietary implementation wholesale; short literal quotes are used only where the exact literal is the
evidence.

---

## Scope & method

### What this document covers

1. Process and bundle topology (every JS process family, every Electron helper, every native helper).
2. Bootstrap and module loading (`main.cjs` and its custom CJS loader with V8 code cache).
3. Electron security posture for all BrowserWindows, webviews, CSP and custom protocol schemes.
4. The `contextBridge` surface: the exposed globals and their members.
5. The `sand:` IPC channel layer and the structured-RPC layer that carries most traffic.
6. Renderer composition derived from the shipped chunk inventory.
7. Native dependencies.
8. Explicit limitations of this analysis.

### Evidence base

| Artifact | What it is | How it was used |
|---|---|---|
| `recon/grokbot-0.71.2/` | The app payload extracted byte-for-byte from `Contents/Resources/app.asar` | Primary ground truth for file contents, sizes and paths |
| `recon/beautified/*.beauty.js` | Prettier-formatted versions of the minified bundles | Line-number citation target for reading logic |
| `recon/rea/js-application.json` | REA sealed static-analysis evidence, 150 MB, `evidence_id` `ev_77595523d6453848862a9e158ce74e1140c03a4fd25af7736a669c94f723e810` | Cross-check, and the source of every "REA reported X" statement |
| `recon/rea/projection-boundaries.json`, `recon/rea/projection-summary.json` | Pre-extracted REA projections | Cross-check of the Electron boundary counts |
| `recon/rea/coordinator-methods.json` | Extracted coordinator RPC method list | Referenced, not re-derived here (see the coordinator section of the dossier) |
| `/Applications/Grok Bot.app/Contents/Info.plist` | Shipping bundle metadata | URL schemes, ATS, helper bundles, asar integrity hash |
| `plutil -p` on the CUA helper's plist | The separate Computer Use helper app | Native helper inventory |

### Citation conventions

* Paths beginning `dist/...` are relative to `recon/grokbot-0.71.2/`, i.e. the root of the asar payload.
* `recon/beautified/<file>.beauty.js:<line>` cites the **beautified** rendering. The shipped files are
  minified onto a handful of very long lines, so beautified line numbers are stable and readable but are
  **not** line numbers in the shipped artifact. When a shipped-file line/column is needed, the REA form
  `dist/electron-main/main-core.cjs:141` (REA records `start.line`) is used instead, and the two are
  distinguished explicitly.
* `recon/rea/js-application.json -> <json pointer>` cites a projection path inside the sealed evidence.

### Claim markers

Every non-obvious claim carries one of:

* **PROVEN** - a literal or AST observation exists in the artifacts listed above.
* **INFERRED** - reasoned from proven evidence; the reasoning is stated inline.
* **UNKNOWN** - could not be determined from the available evidence; the failed search is described.

Two further conventions matter for honesty about the bundles:

* All bundle symbols are **minifier names**. `t`, `e`, `_i`, `ku`, `Fe`, `Ce`, `ce` and friends are
  single-letter or short identifiers produced by the bundler/minifier. They carry no meaning and must not be
  treated as API names. Where a minifier name is unavoidable for explaining control flow it is written as
  `t.createKey(...)` with the surrounding literal, and the *literal* is the real evidence.
* Nothing in this document was produced by executing the app. Every statement derives from the shipped bytes
  read as text, plus the macOS bundle metadata. Behaviour at runtime is unproven unless a literal proves it.

### A note on the shipped bundles

Two build artifacts are worth recording up front because they affect how the files must be read.

**PROVEN** - every shipped JS/HTML file begins with a stray leading byte (sometimes two) followed by a
newline, before the real content. Examples, read with `node -e` over the raw bytes:

| File | First bytes (hex) | Rendered |
|---|---|---|
| `dist/electron-main/main.cjs` | `38 0a 22 75 73 65` | `8` LF `"use` |
| `dist/renderer/index.html` | `60 82 3c 21 64 6f` | `` ` `` `0x82` `<!do` |
| `dist/renderer/assets/chunk-agents-B0QmPY-S.js` | `63 0a 21 66 75 6e` | `c` LF `!fun` |
| `dist/renderer/assets/chunk-DefaultCode-BmFCSgZD.js` | `3e 0a 21 66 75 6e` | `>` LF `!fun` |

A census of the first line across all 534 `.js` files under `dist/renderer/assets/` yields 16 distinct
single-character values (`0`-`9`, `a`-`f`, counts 23 to 44, total 530), plus two files beginning with `}`,
one with `>`, and one file with no prefix at all. `dist/grokbot-0.71.2/dist/renderer/index.html` is recorded
by REA with `text_status: "invalid-utf8"` (`recon/rea/js-application.json -> graph.nodes[kind=artifact,
path=dist/renderer/index.html]`), consistent with the `0x82` byte.

The extraction tool `recon/extract-asar.mjs` performs a plain byte-range copy out of the asar, so the stray
bytes are **in the shipped archive**, not an extraction artifact. They are harmless to parsing because a
line terminator precedes the real token (`8` LF `"use strict"`, `c` LF `!function...`), and JS automatic
semicolon insertion turns the leading `c` into the statement `c;`. Consequence for a reimplementation:
when reading these files as text, strip everything up to and including the first newline, and do not assume
byte-exact hashes of file contents match a canonical build output.

**UNKNOWN** - what produces this prefix. It is uniform across ~594 files, including HTML, and is present in
the packaged asar. No build banner, comment, or metadata in the payload explains it. It is *not* a shebang,
not a BOM, and not valid JSON. A plausible class of explanations is an off-by-N write in the bundler's file
emitter, but no evidence in the payload confirms that.

---

## 0. At-a-glance

```
                       +-----------------------------------------------------+
                       |  Grok Bot.app/Contents/MacOS/Grok Bot  (Electron)   |
                       +-----------------------------------------------------+
                                                  |
              argv: dist/electron-main/main.cjs   (package.json "main")
                                                  v
   +--------------------------------------------------------------------------+
   | MAIN PROCESS (Chromium browser process, "node" side)                     |
   |                                                                          |
   |   main.cjs           9,227 B   bootstrap + custom CJS loader + V8 cache   |
   |      |  runBundle("main-core")                                            |
   |      v                                                                    |
   |   main-core.cjs    865,085 B   windows, protocols, IPC plumbing,          |
   |      |                         boot gates, settings, theme, proxy         |
   |      |  await exports.remainderDue                                        |
   |      v                                                                    |
   |   main-app.cjs   2,626,453 B   product logic, coordinator supervision,    |
   |                                exec-daemon supervision, canvas, 1Password |
   |                                                                          |
   |   proto.cjs      1,234,480 B   lazily required protobuf descriptors       |
   |   chrome-import-worker.cjs 11,549 B   utilityProcess worker               |
   |   onepassword-connection-service.cjs 104,147 B  (unpacked, dynamic import)|
   +--------------------------------------------------------------------------+
        |                      |                        |
        | utilityProcess.fork  | utilityProcess.fork    | child_process.spawn
        v                      v                        v
  +-----------------+   +----------------------+   +------------------------+
  | node-agent-     |   | local-exec-daemon    |   | (fallback path, and    |
  | coordinator     |   | main.cjs 3,548,655 B |   |  sand-op-launcher /    |
  | main.cjs        |   |  + messages-worker   |   |  sand-webauthn-signer) |
  | 893,328 B       |   |    .cjs 50,767 B     |   +------------------------+
  +-----------------+   +----------------------+
        ^                      ^
        |  MessagePorts        |  Node IPC / MessagePort
        |                      |
   +----+----------------------+---------------------------------------------+
   | RENDERER (Chromium renderer, sandboxed)                                 |
   |   dist/renderer/index.html  -> 534 JS chunks, 275 distinct base names   |
   |   preload: dist/electron-preload/preload.cjs  (108,151 B)               |
   +-------------------------------------------------------------------------+
        ^                              ^
        | webview (partition faas.instance)          | desktop-mount panel window
        |  preload-vnc.cjs / preload-webview.cjs     |  preload-desktop-mount-panel.cjs
```

Five JS process families ship in the asar: `electron-main`, `electron-preload`, `renderer`,
`node-agent-coordinator` and `local-exec-daemon` (which itself contains `messages-worker.cjs`). Electron
additionally starts its own helper processes from `Contents/Frameworks/`, and the app ships one separate
native helper **application bundle**, `Grok Bot Computer Use.app`.

---

## 1. Process and bundle topology

### 1.1 Bundle inventory

All sizes are exact byte counts read from the extracted payload.

| Bundle | Bytes | Process | Role | Entry evidence |
|---|---|---|---|---|
| `dist/electron-main/main.cjs` | 9,227 | Electron main | Bootstrap. Installs a custom CJS loader with a V8 code cache, loads `main-core` then `main-app`, and wires their startup contract. | `package.json` `"main": "dist/electron-main/main.cjs"` (line 12); entire file read |
| `dist/electron-main/main-core.cjs` | 865,085 | Electron main | Core platform layer: main `BrowserWindow`, protocol registration and handlers, `sand:` IPC plumbing, boot gates, settings/theme/language controllers, system proxy, attachment HTTP range server, tray, auto-update surface, Sentry IPC namespace. | **PROVEN** exported contract `remainderDue` + `noteStartupFailed`; loaded by `main.cjs` |
| `dist/electron-main/main-app.cjs` | 2,626,453 | Electron main | Product logic: coordinator supervision, exec-daemon supervision, canvas frame serving, 1Password connection service, Chrome cookie import, webviews, MCP, and the `desktop-mount` panel window. | **PROVEN** exports `reportMainCodeCache`; loaded by `main.cjs` after `remainderDue` |
| `dist/electron-main/proto.cjs` | 1,234,480 | Electron main | Protobuf descriptor module, loaded lazily on first use. | `recon/beautified/main-app.beauty.js:7187` `LMt = () => (NMt ??= DMt(BMt.join(__dirname, "proto.cjs")))` |
| `dist/electron-main/chrome-import-worker.cjs` | 11,549 | utilityProcess (worker) | Chrome cookie/profile import worker spawned as a `utilityProcess`. | `recon/beautified/main-app.beauty.js:67992` `join(dirname(fileURLToPath(__import_meta_url)), "chrome-import-worker.cjs")` |
| `dist/electron-main/onepassword-connection-service.cjs` | 104,147 | Electron main (module) | 1Password connection service, loaded with a **dynamic `import()`**, and shipped **unpacked**. | `recon/beautified/main-app.beauty.js:101728` `import("./onepassword-connection-service.cjs").then(({ createDefaultOnePasswordConnectionService: c }) => ...)` |
| `dist/electron-main/locales/<lang>/messages.cjs` | (35 locales) | Electron main (module) | Main-process i18n message catalogues. 35 locale directories. | `ls dist/electron-main/locales` |
| `dist/electron-preload/preload.cjs` | 108,151 | Preload (main window) | The main `contextBridge` surface and the renderer side of the `main` RPC edge. | selected by `Ig({isPackaged, devCapability})`; see 3.1 |
| `dist/electron-preload/preload-desktop-mount-panel.cjs` | 12,501 | Preload (desktop-mount panel) | Exposes `desktopMount` for the floating composer panel window. | `recon/beautified/main-app.beauty.js:85780` `Pon = "preload-desktop-mount-panel.cjs"` |
| `dist/electron-preload/preload-vnc.cjs` | 44,992 | Preload (webview, `faas.instance` partition) | Remote-desktop / VNC webview preload; bridges viewer state to the host via `sendToHost`. | `recon/beautified/main-app.beauty.js:107944` `r = join(e.preloadDistDir, "preload-vnc.cjs")` |
| `dist/electron-preload/preload-webview.cjs` | 6,523 | Preload (webview, other partitions) | Browser-webview preload; same `sendToHost` protocol as the VNC preload. | `recon/beautified/main-app.beauty.js:107943` `n = join(e.preloadDistDir, "preload-webview.cjs")` |
| `dist/electron-preload/preload-avatar-source.cjs` | 5,568 | Preload (`WebContentsView`) | Offscreen avatar-source preload used to decode/prepare avatar images through a transferred `MessagePort`. | `recon/beautified/main-app.beauty.js:98465` `var gMn = "preload-avatar-source.cjs"` |
| `dist/node-agent-coordinator/main.cjs` | 893,328 | utilityProcess | The agent-runtime RPC server. Owns the gateway transport, transcript delivery, exec supervision and the 172-method RPC surface. | `recon/beautified/main-app.beauty.js:85104-85106` |
| `dist/local-exec-daemon/main.cjs` | 3,548,655 | utilityProcess or detached child | Sandboxed local execution daemon: shell/exec policy, VNC/computer-use tool surface, credential brokering, Messages integration. | `recon/beautified/main-core.beauty.js:29894-29895` |
| `dist/local-exec-daemon/messages-worker.cjs` | 50,767 | `node:worker_threads` Worker inside the exec daemon | macOS Messages (`chat.db`) reader. | `recon/beautified/exec-daemon.beauty.js:110800` `workerEntryPath: join(dirname(fileURLToPath(import.meta.url)), "messages-worker.cjs")` |
| `dist/renderer/index.html` | 1,714 | Renderer | Renderer entry document with the CSP meta tag and the modulepreload graph. | read directly |
| `dist/renderer/assets/*` | 588 files, 32 MiB | Renderer | Code-split chunks, fonts, images, audio, CSS. | `ls`, `du -sh` |
| `dist/renderer/src/electron-renderer/desktop-mount/panel/panel.html` | 3,104 | Renderer (second document) | The desktop-mount panel's own HTML document; loaded by the panel window. | read directly |

**Correction to the working notes.** `recon/FINDINGS.md` records "preloads (4 of them)". The payload ships
**five** preload `.cjs` files. The count of four is correct only if restricted to the preloads attached to a
`BrowserWindow` (`preload.cjs`, `preload-desktop-mount-panel.cjs`) plus the two attached to a `<webview>`
(`preload-vnc.cjs`, `preload-webview.cjs`); `preload-avatar-source.cjs` is attached to a headless
`WebContentsView` instead. `recon/beautified/` only beautifies three of the five.

### 1.2 Electron and Chromium helper processes

These are Electron's own, not app code. **PROVEN** from the bundle layout.

| Bundle | Kind | Notes |
|---|---|---|
| `Contents/Frameworks/Grok Bot Helper.app` | Chromium child-process host | The generic helper executable Electron re-execs for its process types |
| `Contents/Frameworks/Grok Bot Helper (GPU).app` | GPU process | `--type=gpu-process` |
| `Contents/Frameworks/Grok Bot Helper (Plugin).app` | Utility/plugin process | `--type=utility`; hosts the app's `utilityProcess.fork` children in packaged builds |
| `Contents/Frameworks/Grok Bot Helper (Renderer).app` | Renderer process | `--type=renderer`; one per renderer, plus one per out-of-process `<webview>` in this configuration |
| `Contents/Frameworks/Electron Framework.framework` | Chromium + Node | runtime |
| `Contents/Frameworks/Squirrel.framework` | Auto-update | Electron's Squirrel.Mac, used by `electron-updater`-style flows |
| `Contents/Frameworks/Mantle.framework`, `ReactiveObjC.framework` | Squirrel dependencies | Objective-C support libraries |
| `Contents/MacOS/Grok Bot` | Main executable | 53,040 bytes, `CFBundleExecutable` |

`Contents/Resources/app.asar` is 43,877,938 bytes and its integrity hash is pinned in `Info.plist`:

```
ElectronAsarIntegrity => { "Resources/app.asar" => { "algorithm" => "SHA256",
  "hash" => "88c570ca443a0b43486399ea0e285aabd4c51be991e8940a4e4c389d412ffd4c" } }
```

**PROVEN.** This is Electron's fuse-level asar integrity check; a reimplementation should expect the
asar hash to be verified at startup when the relevant fuse is enabled.

`LSEnvironment => { "MallocNanoZone" => "0" }` and `NSRequiresAquaSystemAppearance => false` are also set.

### 1.3 Native helpers

Two **unpacked** Mach-O helpers plus one separate helper **application bundle**.

| Path | Bytes | Kind | Purpose | Evidence |
|---|---|---|---|---|
| `Contents/Resources/app.asar.unpacked/dist/native/sand-op-launcher` | 136,368 | Mach-O executable | 1Password CLI/app launcher. The path is chosen per packaging state. | `recon/beautified/main-app.beauty.js:108644-108645` |
| `Contents/Resources/app.asar.unpacked/dist/native/sand-webauthn-signer` | 5,024,896 | Mach-O executable | WebAuthn/passkey assertion signer used for the platform-authenticator ceremony. | referenced by the WebAuthn proxy executors (`recon/beautified/main-app.beauty.js:108987` `webAuthnExecutors: EYe(Ne.BrowserWindow)`) |
| `Contents/Helpers/Grok Bot Computer Use.app` | bundle | LSApplicationCategoryType none, `LSUIElement: true` | Screen-reading and input-synthesis helper for computer-use agents. Executable `CUGrokBotService`, bundle id `co.anysphere.grok-bot-computer-use`, version 1.0.0. | `Contents/Helpers/` listing and its `Info.plist` |

The exact launcher path selection, **PROVEN** literal:

```js
? Wd.default.join(process.resourcesPath, "app.asar.unpacked", "dist", "native", "sand-op-launcher")
: Wd.default.join(__dirname, "..", "native", "sand-op-launcher"),
```

(`recon/beautified/main-app.beauty.js:108644-108645`)

The CUA helper's `Info.plist` declares four usage strings, which define its permission surface verbatim:

```
NSAccessibilityUsageDescription  => "Grok Bot Computer Use reads and controls on-screen apps so Grok Bot agents can operate your Mac on your behalf."
NSAppleEventsUsageDescription    => "Grok Bot Computer Use sends events to apps so Grok Bot agents can operate them on your behalf."
NSContactsUsageDescription       => "Grok Bot Computer Use reads your Contacts so Grok Bot agents can find the people you ask them to text by name."
NSScreenCaptureUsageDescription  => "Grok Bot Computer Use captures your screen so Grok Bot agents can see the apps they are operating."
```

Main-app permission plumbing that corresponds to this helper is visible as the `main` RPC methods
`readComputerUsePermissions`, `openComputerUsePermissionSettings`, `listComputerUseAllowedApps`,
`revokeComputerUseAllowedApp` (`recon/beautified/preload.beauty.js:3927-3930`), and as main-core UI state
`computerUseHelperName` in the boot snapshot (`recon/beautified/main-core.beauty.js:19448`).

### 1.4 The coordinator process

**PROVEN.** `dist/node-agent-coordinator/main.cjs` is forked as an Electron **utility process**.

Fork call, with the three transferred `MessagePort`s and the bootstrap payload
(`recon/beautified/main-app.beauty.js:85108-85206`):

```js
var Aon = "sand-node-agent-coordinator";
function yJe(e) {
  let t = e.fork(e.artifactPath, { serviceName: Aon }),
    n = e.createChannel(),
    r = e.createChannel(),
    o = e.createChannel(),
    ...
    t.postMessage({ bootstrap: { processConfig: e.processConfig } }, [n.port1, r.port1, o.port1]);
```

and the concrete `fork` implementation injected at the call site
(`recon/beautified/main-app.beauty.js:91561-91567`):

```js
fork: (L, B) =>
  Ig.utilityProcess.fork(L, [], {
    serviceName: B.serviceName,
    env: { ...process.env, [E8e.NODE_USE_SYSTEM_CA_ENV]: "1", ...u() },
  }),
```

Artifact path resolution (`recon/beautified/main-app.beauty.js:85104-85106`):

```js
function _Je() {
  let e = (0, TV.dirname)((0, SJe.fileURLToPath)(__import_meta_url));
  return (0, TV.join)(e, "..", "node-agent-coordinator", "main.cjs");
}
```

| Aspect | Value | Citation |
|---|---|---|
| `serviceName` | `"sand-node-agent-coordinator"` | `main-app.beauty.js:85060` |
| Channels | 3 `MessageChannelMain`s: **control** (`n`), **renderer data** (`r`), **main data** (`o`) | `main-app.beauty.js:85108-85122` |
| Handshake | `postMessage({ bootstrap: { processConfig } }, [port1 x3])` | `main-app.beauty.js:85122` |
| Env | inherits `process.env`, adds `NODE_USE_SYSTEM_CA=1`, plus the system-proxy child env | `main-app.beauty.js:91562-91566` |
| Renderer port handoff | main posts the renderer data port to the renderer on `sand:coordinator-port` | `main-app.beauty.js:85244` `o.postMessage(bJe, null, [i])` |
| Generation guard | event adapter drops out-of-order generations | `main-app.beauty.js:85111-85121` |
| Relaunch | exponential-ish backoff via `e.relaunchBackoff.schedule(s)`, with `onLifecycle` events `exited` / `relaunched` | `main-app.beauty.js:85190-85210` |
| Restart trigger | `sand:coordinator-port-request` handler calls `requestRendererPort` | `main-app.beauty.js:85237` `e.ipcMain.handle(EJe, (r) => {...})` |

Coordinator-side bootstrap, **PROVEN** (`recon/beautified/coordinator.beauty.js:34989-35030`, `39785-39799`):

```js
var $U = "--bootstrap=";
function XK(r) { if ("parentPort" in r) return r.parentPort; }
function QK(r) {
  let e = r.find((u) => u.startsWith($U));
  if (e == null) return { adopted: !1, rejection: { detail: "missing --bootstrap argument" } };
  ...
```

so the coordinator accepts **two** launch shapes:

1. **Port/`parentPort` mode**: it reads the first message off the control port and adopts the transferred
   ports. `KU()` returns `Promise.resolve(QK(process.argv))` (argv mode) when no control port exists
   (`coordinator.beauty.js:35103-35112`).
2. **argv mode**: `--bootstrap=<JSON>` on the command line, parsed and validated by `Tw(...)`.

Bootstrap validation, **PROVEN** (`coordinator.beauty.js:34967-34977`):

| Field | Constraint | Rejection detail |
|---|---|---|
| `bootstrap.processConfig` | must be an object | `"bootstrap.processConfig must be an object"` |
| `.appVersion` | non-empty string | `"bootstrap.processConfig.appVersion must be a non-empty string"` |
| `.isPackaged` | boolean | `"bootstrap.processConfig.isPackaged must be a boolean"` |
| `.dataDir` | non-empty string | `"bootstrap.processConfig.dataDir must be a non-empty string"` |

Exit codes, **PROVEN** (`coordinator.beauty.js:34687`): `{ settledClean: 0, fault: 1, bootstrapRejected: 2 }`.
On a rejected bootstrap the process writes `node-agent-coordinator: <detail>` to stderr and exits with 2
(`coordinator.beauty.js:39786-39788`).

Internal channel names, **PROVEN**: `var iA = "coordinator-control"` and
`var lA = "coordinator-main-data"` (`coordinator.beauty.js:34981`, `34985`). These are the `channel` tags on
the fork-IPC envelope when the coordinator falls back to `process.send` framing
(`coordinator.beauty.js:35021-35028`).

Loopback allowlist, **PROVEN** (`coordinator.beauty.js:33803`):

```js
var f$ = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
```

The same literal set appears in the exec daemon (`exec-daemon.beauty.js:68004`
`var M1t = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])`), so both non-renderer processes gate
"local" on the same four hosts.

`recon/FINDINGS.md` attributes this set to "the coordinator"; that is correct but incomplete - it is present
in **both** the coordinator and the exec daemon.

### 1.5 The local exec daemon and the messages worker

**PROVEN.** `dist/local-exec-daemon/main.cjs` has two spawn paths selected at runtime.

Service name and entry resolver (`recon/beautified/main-core.beauty.js:29844`, `29894-29895`):

```js
var IR = "sand-local-exec-daemon";
...
function OR() {
  let e = (0, Vc.dirname)((0, DB.fileURLToPath)(__import_meta_url));
  return (0, Vc.join)(e, "..", "local-exec-daemon", "main.cjs");
}
```

**Path A - Electron `utilityProcess.fork`** (`main-core.beauty.js:30018-30035`, `30087-30091`):

```js
function dce(e) {
  let t = e.fork(e.entryPath, { env: e.env, stdio: "pipe", serviceName: IR });
  nce(t, e.logPath);
  ...
    t.postMessage(e.handoff);
```

Selected when `t.utilityFork != null && t.daemonEntryArgv == null` (`main-core.beauty.js:30085-30089`).

**Path B - detached `child_process.spawn` with a Node IPC channel**
(`main-core.beauty.js:30021-30048`):

```js
function lce(e) {
  let t = (0, Ji.openSync)(e.logPath, "a"),
    n = oB(process.execPath, [...e.entryArgv], { detached: !0, stdio: ["ignore", t, t, "ipc"], env: e.env }),
```

The child is `unref()`ed, its stdio is redirected to a log file, and the handoff payload is delivered with
`n.send(e.handoff)`; `n.channel?.unref()` follows immediately. `entryArgv` defaults to `[OR()]`.

Environment construction (**PROVEN**, `main-core.beauty.js:29846-29850`):

```js
function Zse(e, t) {
  let n = { ...process.env, ...e.env, [w1]: String(t), [wg]: "1" };
  return (delete n.ELECTRON_RUN_AS_NODE, n);
}
```

with (and this **corrects** `recon/FINDINGS.md`, which lists only `SAND_LOCAL_EXEC_GENERATION`):

| Env var | Literal | Line |
|---|---|---|
| `w1` | `"SAND_LOCAL_EXEC_GENERATION"` | `main-core.beauty.js:28773` |
| `wg` | `"NODE_USE_SYSTEM_CA"` | `main-core.beauty.js:28775` |

The daemon-side reads the same names: `exec-daemon.beauty.js:67940-67941` declares
`g6e = "SAND_LOCAL_EXEC_GENERATION"` and `N9 = "SAND_LOCAL_EXEC_INHERITED_FDS"`. Additional daemon env
names observed in the daemon bundle: `SAND_LOCAL_EXEC_ROOT`, `SAND_AGENT_PROJECT_DIR`
(`exec-daemon.beauty.js:110653`) and `SAND_LOCAL_EXEC_FILE_KEY` (`exec-daemon.beauty.js:143204`).

Note the deliberate `delete n.ELECTRON_RUN_AS_NODE`. **INFERRED**: the desktop app can itself be launched in
`ELECTRON_RUN_AS_NODE` mode in some deployment shapes (CLI wrappers, box images); removing the variable
guarantees the spawned process starts as a real Electron process rather than inheriting a Node-only
personality. No literal in the payload states this rationale.

Daemon identity verification, **PROVEN** (`main-core.beauty.js:29929-29980`): the supervisor reads
`/proc/<pid>/cmdline` (Linux) or runs `ps -p <pid> -o command=` (macOS) with a 2 s timeout, and on Windows
uses `powershell.exe -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = <pid>').CommandLine"`
with a 5 s timeout. Acceptance test (`main-core.beauty.js:29949-29951`):

```js
function NB(e) {
  let t = e.trim();
  return t.includes("local-exec-daemon") || t.includes(IR) ? !0 : t === IR.slice(0, oce);
}
```

with `var oce = 15`, i.e. the 15-character prefix `sand-local-exec` is also accepted. A stricter check
compares the full `${process.execPath} ${entryPath}` pair (`main-core.beauty.js:29985-29987`).

Pre-spawn guards, **PROVEN**:

* an **account retire marker** file must not exist, otherwise the spawn throws
  `SandLocalExecSpawnRetiredError` with the message
  `"local-exec daemon spawn refused: the account retire marker stands"`
  (`main-core.beauty.js:29876-29878`, `30069`, `30078`);
* a monotonic **account generation** counter `CR` is re-checked inside the serialized spawn section
  (`main-core.beauty.js:30066-30080`);
* directory creation for the log path, plus `getOrCreateLocalExecFileKey()` and `getOrCreateMachineId()`
  are awaited before spawning (`main-core.beauty.js:30072-30080`).

Daemon state files, **PROVEN** literals in main-core:

| Literal | Line |
|---|---|
| `"local-exec-daemon.json"` | `main-core.beauty.js:26287`, `28767` |
| `"local-exec-daemon-connection.json"` | `main-core.beauty.js:28766` |
| `"local-exec-daemon-credential.json"` | `main-core.beauty.js:28768` |

plus the daemon-side route literal `"/sand-box/local-exec-daemon-credential"` (`main-app.beauty.js:78085`).

Stdio log pipelining, **PROVEN**: stdout/stderr are piped into an append-mode write stream, and lines are
parsed as JSON frames (`main-core.beauty.js:29856-29874`), with a bounded carry buffer of 8,192 characters
(`var Qse = 8192`) that is dropped when a single line exceeds it.

The Messages worker, **PROVEN**: resolved inside the daemon as a sibling file and run as a
`node:worker_threads` worker (`exec-daemon.beauty.js:110800`). The daemon bundle reads macOS Messages
internals (`chat.db`, `sqlite`, `guid`, `handle`, `attachment`) as recorded in `recon/FINDINGS.md`; the
worker's own bundle is `messages-worker.cjs`.

### 1.6 Processes REA could see, and what it could not

REA's own Electron summary (`recon/rea/js-application.json -> normalized_result.summary`):

```json
"browser_windows": 4,
"explicit_web_preferences": 11,
"preload_entrypoints": 0,
"context_bridge_apis": 6,
"exposed_api_members": 6,
"utility_processes": 2,
"resolved_utility_entrypoints": 0,
"native_addon_bindings": 2,
"resolved_native_addon_bindings": 2
```

Reading this carefully:

* `utility_processes: 2` matches the two `utilityProcess.fork` call sites found by this analysis (the
  coordinator, and the exec daemon's Path A). **PROVEN** agreement.
* `resolved_utility_entrypoints: 0` means REA could **not** resolve either entry path. The REA nodes are
  `recon/rea/js-application.json -> graph.nodes[kind=electron-utility]`, both with
  `module_path: null`, `module_expression: "L"`, `service_name: null`, observed at
  `dist/electron-main/main-app.cjs:570`. This analysis resolved them by reading the surrounding module
  rather than the call site: `main-app.beauty.js:85104-85106` (coordinator) and
  `main-core.beauty.js:29894-29895` (exec daemon). Note that the exec daemon's two spawn paths mean the
  `utilityProcess.fork` count of 2 is a *call-site* count, not a *process* count: only one daemon runs, via
  one of the two paths.
* `preload_entrypoints: 0` means REA could not resolve any preload path. Section 3 resolves all five by
  reading `main-core.beauty.js:28643-28644`, `main-app.beauty.js:85780`, `98465`, `107943-107944`.

Worker threads found by REA (`graph.nodes[kind=worker]`, 8 total) resolve to seven distinct call sites in
shipped coordinates:

| Expression (verbatim from REA) | Shipped location |
|---|---|
| `new Hft.Worker(new URL(\`data:application/javascript;base64,${fEr}\`),{workerData:s,execArgv:[],env:{...process.env,NODE_OPTIONS:void 0}})` | `dist/local-exec-daemon/main.cjs:786` |
| `new sZe.Worker(t,{workerData:s})` | `dist/local-exec-daemon/main.cjs:757` |
| `new k5.Worker(new URL(\`data:application/javascript;base64,${YNe}\`),{workerData:a,execArgv:[],env:{...process.env,NODE_OPTIONS:void 0}})` | `dist/electron-main/main-core.cjs:162` |
| `new sG.Worker(Ace,{eval:!0,execArgv:Zg()})` | `dist/electron-main/main-core.cjs:143` |
| `new dAe.Worker(e,{workerData:t,execArgv:(0,uAe.workerExecArgvWithoutInspectorFlags)()})` | `dist/electron-main/main-app.cjs:159` |
| `new Worker(t,{type:"module"})` | `dist/renderer/assets/chunk-pdf-CyhaVadp.js:4` (pdf.js worker) |
| `new Worker(ASe,{type:"module",name:"file-markdown"})` | `dist/renderer/assets/index.eager-app-DSuGVQNC.js:117` |
| `new Worker(ii)` | `dist/electron-preload/preload.cjs:32` |

Two of these are **inline base64 workers** constructed from `data:application/javascript;base64,` URLs, and
both explicitly clear `NODE_OPTIONS` for the child. The exec daemon additionally has the
`workerExecArgvWithoutInspectorFlags()` helper named in `recon/FINDINGS.md`, and the coordinator/daemon pair
share the same technique.

## 2. Bootstrap and module loading

### 2.1 `main.cjs` anatomy

`dist/electron-main/main.cjs` is 9,227 bytes on 6 lines (5 newlines, at byte offsets 1, 399, 1974, 7610,
9179). Citations below use the form `dist/electron-main/main.cjs:<line> @<byte-offset>`.

| Line | Byte range | Contents |
|---|---|---|
| 1 | 0 | the single byte `8` |
| 2 | 2-398 | Sentry debug-id stamping IIFE, writing `_sentryDebugIds[...]` and `_sentryDebugIdIdentifier = "sentry-dbid-d90a08e3-aeb6-4105-b60b-564e783b78f4"` |
| 3 | 400-1973 | `node:path` import, `Error` cause-chain code extractor, user-data-dir resolution, `SandInvariantViolation` + `invariant` / `fail` |
| 4 | 1975-7609 | atomic no-follow file writer, V8 code-cache path and eviction logic, `runBundle`, the CJS wrapper template |
| 5 | 7611-9178 | boot contract (`boot`), `runBundle` invocation with `buildId` |
| 6 | 9180-9226 | `//# debugId=d90a08e3-aeb6-4105-b60b-564e783b78f4` |

### 2.2 User-data-dir resolution

**PROVEN** (`dist/electron-main/main.cjs:3 @1146`):

```js
var pe="SAND_USER_DATA_DIR",fe="sand-data",M="--user-data-dir",F="/home/box",
    ut=`${F}/${fe}`,dt=`${F}/agent-data`;
```

| Literal | Meaning |
|---|---|
| `SAND_USER_DATA_DIR` | environment override |
| `sand-data` | default directory name (inside `/home/box` in box images) |
| `--user-data-dir` | also honoured from argv, both `--user-data-dir <value>` and `--user-data-dir=<value>` forms |
| `/home/box` | box home |
| `/home/box/sand-data` | box data root |
| `/home/box/agent-data` | box agent data root |

The resolver `b(argv, env, cwd)` returns `null` when unset, passes absolute paths through, and otherwise
resolves relative to `process.cwd()`. The code-cache directory is then
`join(resolvedUserDataDir ?? app.getPath("userData"), "v8-code-cache")`
(`dist/electron-main/main.cjs:4 @6550`, `:5`).

### 2.3 Invariant handling

**PROVEN** (`dist/electron-main/main.cjs:3 @1626`):

```js
var P=class extends Error{constructor(t){super(t),this.name="SandInvariantViolation"}},
    k=null;
var Se="Invariant violation (message stripped in packaged builds; the stack identifies the site)";
function Ee(){return !0}
```

* `invariant(cond, msgThunk)` (`E`) and `fail` (`Re`) both funnel into `new SandInvariantViolation(...)` and
  then `throw`.
* `Ee()` is hardcoded to return `true`, so the message **always** becomes the stripped literal
  `Se`. The original message text is discarded in this build. The site is identified only by the
  `Error.captureStackTrace` frame, and only if a frame observer `k` is registered; `k` is initialised to
  `null` and this file never assigns it, so in practice the frame is captured but not reported.
* **INFERRED**: the intent is a production-hardened assertion channel whose messages do not leak internal
  detail into crash reports; the stack frame is the debugging handle. The `Ws` -> `false` variant exists in
  source but was compiled out.

`SandInvariantViolation` is the class used for the two boot-contract assertions described in 2.6.

### 2.4 Atomic, symlink-refusing file writes

**PROVEN** (`dist/electron-main/main.cjs:4 @2850`). The loader owns a small hardened writer used for cache
persistence:

* Refusals are typed: `NoFollowRefusedError` with `reason` in
  `{"target-link", "parent-link", "not-a-file"}` and human strings
  `"a symbolic link at the target path"`, `"a symbolic link at the parent path"`,
  `"a non-regular file at the target path"`.
* Writes go to a temp sibling named `` `${target}.${randomInt(2**32)}` `` then `rename` over the target;
  open flags are `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` with a `0o666` (438) default mode and `0o600`
  (384) in the no-follow branch.
* `fchmod` failures are swallowed only for `ENOSYS`, or `EINVAL`/`EPERM` when not running as root.
* Writes are `fsync`ed before the rename, and the temp file is removed on any failure.
* A per-path promise queue serialises concurrent writers to the same target.
* On Linux the no-follow parent walk uses `/proc/self/fd/<fd>/<name>`; on other platforms it walks with
  `lstatSync` and rejects any symlinked parent.
* `open`/`readdir` are obtained via `process.getBuiltinModule("node:fs")` when available, falling back to a
  `require("node:fs")` namespace object.

**INFERRED** rationale: `userData` lives in a user-writable directory, so the loader defends its own
executable-code cache against a symlink attack that would let another local process influence what gets
read back as V8 cached data. The `O_NOFOLLOW` + realpath + temp-and-rename combination is the standard
recipe for that threat.

### 2.5 The V8 code cache

**PROVEN** (`dist/electron-main/main.cjs:4 @6550`):

| Item | Value |
|---|---|
| Cache directory | `<userDataDir>/v8-code-cache` |
| File naming | `path.format({ dir: cacheDir, name: \`${bundleName}-${buildId}\`, ext: ".v8" })` |
| `bundleName` | `path.basename(bundlePath, path.extname(bundlePath))`, i.e. `main-core` / `main-app` |
| Versioned form | files matching `/^(.+)\.\d{1,10}$/` are recognised as `` `${base}.<randomInt>` `` temp siblings and treated as belonging to `base` |
| Cache-miss classification | `"hit"` / `"rejected"` (`cachedDataRejected === true`) / `"absent"` (ENOENT) / `"unreadable"` with `errorClass` |
| Retention | keep the newest `2` files per bundle prefix (`$e = 2`), sorted by mtime |
| Age-based sweep | delete versioned siblings older than `3600 * 1000` ms (`Ke`) |

`buildId` for this build, **PROVEN** (`dist/electron-main/main.cjs:5 @9137`):

```
ffcda8af-8cbf-49a2-b000-103a5e37f6c9
```

**INFERRED**: the `buildId` in the filename is the cache-invalidation key. A new build ships a new
`buildId`, so it reads a different `.v8` file and never consumes stale bytecode from a previous build. The
temp-file suffix (`<name>.<random>`) exists because `createCachedData()` output is only known after the
script runs, so it is written after the fact and renamed into place.

### 2.6 The loader: `runBundle`

**PROVEN** (`dist/electron-main/main.cjs:4 @6858`). Simplified to its interfaces:

```
runBundle({ bundlePath, cacheDir, buildId }) -> { exports, codeCache }
```

Steps, in order:

1. `bundleName = basename(bundlePath, extname(bundlePath))`.
2. Read `<cacheDir>/<bundleName>-<buildId>.v8` with `readFileSync` inside a try/catch; on failure pass
   `cachedData: undefined` and remember the classified miss reason.
3. `new vm.Script(wrap(readFileSync(bundlePath, "utf8")), { filename: bundlePath, cachedData,
   importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })`.
4. `new Module(bundlePath)` (`node:module`), then `module.filename = bundlePath`.
5. `const fn = script.runInThisContext()`.
6. Assert `typeof fn === "function"`, with the literal
   `"The CommonJS wrapper did not evaluate to a function."` (`:4 @7257`).
7. `fn.call(module.exports, module.exports, createRequire(bundlePath), module, bundlePath, dirname(bundlePath))`.
8. `module.loaded = true`.
9. Return `{ exports, codeCache: { read: <classification>, persist: (dir) => byteLength } }`.

The wrapper template, **PROVEN verbatim** (`dist/electron-main/main.cjs:4 @7522`):

```js
function qe(e) {
  return `(function (exports, require, module, __filename, __dirname) { ${e}
});`;
}
```

Two details are load-bearing:

* **`runInThisContext` on a hand-written wrapper, not `Module._compile`.** The bundle gets a real
  `require` from `createRequire(bundlePath)`, so third-party `require` semantics (including
  `node_modules` resolution and `.node` native addon loading) work exactly as in Node, while the top-level
  code is executed in the main context and can therefore be given `cachedData`.
* **`importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`.** Without this, a dynamic
  `import()` inside the bundle would fail; with it, dynamic ESM imports resolve through the main context's
  default loader. This is exactly what the `import("./onepassword-connection-service.cjs")` site in
  `main-app` needs (`recon/beautified/main-app.beauty.js:101728`).

**INFERRED** on `persist`: it calls `script.createCachedData()` **after** execution, writes the bytes through
the hardened writer of 2.4, then runs the eviction sweep, and returns `byteLength`.

### 2.7 The boot contract between the three main bundles

**PROVEN** (`dist/electron-main/main.cjs:5 @8428`). Three structural assertions define the contract:

```js
function Ze(e) {
  return typeof e === "object" && e !== null &&
    "remainderDue" in e && e.remainderDue instanceof Promise &&
    "noteStartupFailed" in e && typeof e.noteStartupFailed === "function";
}
function Z(e) {
  return typeof e === "object" && e !== null &&
    "reportMainCodeCache" in e && typeof e.reportMainCodeCache === "function";
}
function te({ runBundle: e }) {
  let t = e("main-core");
  E(Ze(t.exports), "main-core.cjs does not export remainderDue and noteStartupFailed.");
  let { remainderDue: r, noteStartupFailed: n } = t.exports;
  return r
    .then(() => {
      let o = e("main-app");
      E(Z(o.exports), "main-app.cjs does not export reportMainCodeCache.");
      o.exports.reportMainCodeCache(t.codeCache);
      o.exports.reportMainCodeCache(o.codeCache);
    })
    .catch((o) => n(o));
}
```

Consequences:

* `main-core.cjs` **must** export `remainderDue` (a `Promise`) and `noteStartupFailed` (a function).
* `main-app.cjs` **must** export `reportMainCodeCache` (a function).
* `main-app` is only loaded **after** `main-core`'s `remainderDue` resolves.
* Both bundles receive the other's `codeCache` handle via `reportMainCodeCache`.

Verified against the bundles:

| Export | Evidence |
|---|---|
| `main-core` `remainderDue` | `recon/beautified/main-core.beauty.js:14757` `on(vwe, { noteStartupFailed: () => MC, remainderDue: () => xwe })`; `:40709` `0 && (module.exports = { noteStartupFailed, remainderDue })` |
| `main-core` `noteStartupFailed` | same; the sink is `function MC(e) { hn.noteFailed(e); uJ(); }` (`:40517`) |
| `main-app` `reportMainCodeCache` | `recon/beautified/main-app.beauty.js:67631` `at(A0n, { reportMainCodeCache: () => g0n })`; `:109414` `0 && (module.exports = { reportMainCodeCache })`; implementation at `:108550` |

`remainderDue` construction, **PROVEN** (`recon/beautified/main-core.beauty.js:40569-40570`):

```js
var mJ = Promise.withResolvers(),
  xwe = mJ.promise;
```

and the resolve site is the tail of main-core's `app.whenReady()` chain
(`recon/beautified/main-core.beauty.js:40699-40700`):

```js
      (await g) !== "quitting" && mJ.resolve());
  })
  .catch(MC);
```

Two things follow, both **INFERRED** from those literals plus the surrounding flow:

* `remainderDue` is not "app ready". It is "main-core's own deferred remainder finished, or the app is
  already quitting". The `'quitting'` short-circuit prevents deadlock when the user quits during startup.
* Because the chain ends in `.catch(MC)` and `MC` is exactly `noteStartupFailed`, a **main-core** startup
  failure resolves the boot sequence's failure branch rather than loading `main-app`. `main-app` therefore
  never loads when `main-core` fails. This is the meaning of the `E(Ze(...))` assertion: it is the guard
  that makes the `await` safe.

### 2.8 Boot ordering, and why it exists

Combining 2.5-2.7, the observed order is:

```
1. main.cjs line 2       Sentry debug-id stamping
2. main.cjs line 3-4     helper definitions only; no Electron API touched except `require("electron")`
3. main.cjs line 5       userDataDir = SAND_USER_DATA_DIR | --user-data-dir | app.getPath("userData")
                         cacheDir    = <userDataDir>/v8-code-cache
4. main.cjs line 5       runBundle("main-core")   <-- first bundle executed
5. main-core             registers privileged schemes, handlers, IPC, then app.whenReady() chain
6. main.cjs              await main-core.exports.remainderDue
7. main.cjs              runBundle("main-app")    <-- second bundle executed
8. main.cjs              main-app.reportMainCodeCache(main-core.codeCache)
9. main.cjs              main-app.reportMainCodeCache(main-app.codeCache)
   failure at 4/6        -> main-core.noteStartupFailed(err)
```

Why this shape, **INFERRED** from the code (no literal states the motivation):

1. **`require` in `main.cjs` is limited to `node:*` and `electron`.** Nothing from the app is imported at
   module scope. That means the loader can run before any app state exists, and the bundle's own top-level
   code is the first app code that executes.
2. **`registerSchemesAsPrivileged` must run before `app` is ready.** Splitting `main-core` out of the entry
   file lets the scheme registration happen inside the first bundle, immediately, without the second
   bundle's 2.6 MB of product logic loading first. Section 3.5 shows the scheme registration is the first
   significant thing the core does.
3. **The `remainderDue` gate exists so `main-app` never executes against a half-built core.** The core's
   `whenReady` chain performs move-detection, language resolution, stuck-watchdog arming, settings-store
   wiring, telemetry sink setup and window creation (`main-core.beauty.js:40572-40700`). `main-app` needs
   the resulting handoff object (`wF = DF("sand.main-core.handoff")`, published by `LF(e)` at
   `main-core.beauty.js:28232` and read by `MF()`), so it must wait.
4. **Code-cache reporting is a feedback loop, not bookkeeping.** `main-app` receives both handles, which
   means the *second* bundle's writer is handed the *first* bundle's cache. **INFERRED**: the product layer
   is where the app knows its own build identity and telemetry, so it is the natural place to decide whether
   to keep or drop cached bytecode; the loader deliberately has no policy about it.
5. **Dynamic `import()` support is required**, not optional, because `main-app` lazily `import()`s
   `onepassword-connection-service.cjs`. Without `USE_MAIN_CONTEXT_DEFAULT_LOADER` the 1Password
   integration could not load under this loader.

### 2.9 `v8CacheOptions` on the window

**PROVEN** literally, in the main window's `webPreferences`
(`recon/beautified/main-core.beauty.js:28648`): `v8CacheOptions: m1(o)` where `o` is the `linuxInstall`
argument threaded into `T1(...)`. So the *renderer's* V8 cache policy is computed at window-creation time as
a function of the Linux install shape. The exact decision table inside `m1` was not read and is **UNKNOWN**;
what is proven is that the value is not a literal in the window options.

---
## 3. Electron security posture

### 3.1 Every window and every webPreferences

Six `BrowserWindow` construction sites and one `WebContentsView` site were identified by reading the
bundles. REA independently reported **4** `browser-window` nodes; the reconciliation is at the end of this
subsection.

#### (a) Main application window - `dist/electron-main/main-core.cjs`

**PROVEN byte-exact.** The shipped literal, read directly from
`dist/electron-main/main-app... main-core.cjs` line 141 columns 12105-12604 (this is the exact range REA
recorded for its `browser-window` node, and it is the single most important security artifact in the app):

```js
new ar.BrowserWindow({...l.windowOptions,
  title:ar.app.getName(),
  icon:i1({platform:process.platform,isPackaged:ar.app.isPackaged,resourcesPath:process.resourcesPath,devIconPath:t}),
  backgroundColor:e,
  ...zF({isMac:c,isWindows:process.platform==="win32",backgroundColor:e}),
  webPreferences:{
    additionalArguments:[...d.additionalArguments],
    contextIsolation:!0,
    nodeIntegration:!1,
    preload:Ng.default.join(JA,Ig({isPackaged:ar.app.isPackaged,devCapability:n})),
    sandbox:!0,
    v8CacheOptions:m1(o),
    webviewTag:!0}})
```

Corresponding beautified reading: `recon/beautified/main-core.beauty.js:28631-28656`.

| `webPreferences` key | Shipped value | Decoded setting |
|---|---|---|
| `additionalArguments` | `[...d.additionalArguments]` | dynamic; from `yP({version: app.getVersion(), track: renderTrace.track})` (`main-core.beauty.js:28627`) |
| `contextIsolation` | `!0` | **`true`** |
| `nodeIntegration` | `!1` | **`false`** |
| `preload` | `Ng.default.join(JA,Ig({isPackaged:ar.app.isPackaged,devCapability:n}))` | resolved below |
| `sandbox` | `!0` | **`true`** |
| `v8CacheOptions` | `m1(o)` | dynamic; a function of the Linux-install descriptor |
| `webviewTag` | `!0` | **`true`** (the app deliberately enables `<webview>`) |

**`preload` resolution, PROVEN** (`recon/beautified/main-core.beauty.js:28604`, `:28238-28241`):

```js
var JA = Ng.default.join(__dirname, "..", "electron-preload");   // main-core.beauty.js:28604
...
var KA = "preload-sand-dev.cjs", Oie = "preload.cjs";
function Ig({ isPackaged: e, devCapability: t }) { return !e && t ? KA : Oie; }
```

So in a packaged build the main window preload is
`<app>/dist/electron-preload/preload.cjs`. In an unpackaged build with a *dev capability* present it is
`preload-sand-dev.cjs` - **a file that does not exist in the shipped payload** (`ls dist/electron-preload/`
lists exactly five `.cjs` files; `preload-sand-dev.cjs` is absent). **INFERRED**: `preload-sand-dev.cjs` is
a development-only artifact injected by the dev harness, and `devCapability` is false in any normal launch.

#### (b) Desktop-mount panel window - `dist/electron-main/main-app.cjs`

**PROVEN byte-exact**, shipped line 558 columns 59777-59800:

```js
new lT.BrowserWindow(o)
```

where `o = Non(e.placement)` (`recon/beautified/main-app.beauty.js:85830-85865`):

```js
function Non(e) {
  return {
    width: m_.width, height: m_.height, x: e.x, y: e.y,
    type: "panel", frame: !1, transparent: !0, hasShadow: !1,
    resizable: !1, minimizable: !1, maximizable: !1, fullscreenable: !1,
    skipTaskbar: !0, alwaysOnTop: !0, show: !1,
    webPreferences: {
      contextIsolation: !0,
      nodeIntegration: !1,
      sandbox: !0,
      preload: xte.default.join(ZJe.PRELOAD_DIST_DIR, Pon),
    },
  };
}
```

with `Pon = "preload-desktop-mount-panel.cjs"` (`main-app.beauty.js:85780`). After construction
(`main-app.beauty.js:85867-85882`): `setAlwaysOnTop(true, "floating")`,
`setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true, skipTransformProcessType: true})`, and
`showInactive()` on `ready-to-show`. It loads `Oon` (a file URL) or the dev server URL.

This is the "bot pinned to the desktop" surface: a frameless, transparent, always-on-top, non-activating
panel whose own document is `dist/renderer/src/electron-renderer/desktop-mount/panel/panel.html`.

#### (c) WebAuthn consent window - `dist/electron-main/main-app.cjs`

**PROVEN** (`recon/beautified/main-app.beauty.js:83401-83412`):

```js
async function vYe(e, t) {
  ote();
  let n = (0, AYe.randomUUID)(),
    r = new t({
      width: 420, height: 300,
      resizable: !1, minimizable: !1, maximizable: !1,
      alwaysOnTop: !0,
      title: Xn.i18n._({ id: "fjHsol" }),
      webPreferences: { nodeIntegration: !1, contextIsolation: !0 },
    });
```

| Key | Value |
|---|---|
| `nodeIntegration` | `!1` -> `false` |
| `contextIsolation` | `!0` -> `true` |
| `sandbox` | **absent from the literal** |
| `preload` | **absent** |

The window is loaded with a `data:text/html;charset=utf-8,` URL containing a self-contained consent page
(`main-app.beauty.js:83429`), and communication happens through
`webContents.executeJavaScript("window.__sandConsent", !0)` and
`executeJavaScript("window.__sandRequestPin?.(...)", !0)` (`main-app.beauty.js:83419-83435`). The injected
constructor is supplied by the caller as `e.BrowserWindow ?? o_.BrowserWindow`
(`main-app.beauty.js:83026`).

Because `sandbox` is omitted: **UNKNOWN by literal.** Electron's documented default since v20 is that the
renderer is sandboxed unless `nodeIntegration` is enabled, and `nodeIntegration` is explicitly `false` here,
so the effective posture is *sandboxed*. But that is an Electron version default, not a literal in this
payload, and **REA's own limitation list forbids reading omission as a default**:

> "Only explicitly present webPreferences are reported; omitted properties are not interpreted as Electron
> defaults." (`recon/rea/js-application.json -> graph.nodes[kind=browser-window].observations[].evidence.limitations[1]`)

So this document reports the omission and does not claim enforcement.

#### (d) 1Password OAuth window - `dist/electron-main/main-app.cjs`

**PROVEN byte-exact**, shipped line 580 columns 40446-40678:

```js
new Cft.BrowserWindow({width:520,height:720,
  parent:(()=>{let n=e();return n===void 0||n.isDestroyed()?void 0:n})(),
  autoHideMenuBar:!0,
  webPreferences:{contextIsolation:!0,nodeIntegration:!1,sandbox:!0,partition:"onepassword-oauth"}})
```

Beautified: `recon/beautified/main-app.beauty.js:101801-101809`. This is the only window in the app with a
**named `partition`**, which puts it in a separate Chromium storage partition from the main window. Note it
has **no preload** and the navigation handlers attached to it are observation-only
(`will-navigate` / `will-redirect` / `did-navigate` / `did-navigate-in-page` -> a callback,
`main-app.beauty.js:101812-101822`).

#### (e), (f) Hidden dialog-parent windows - `dist/electron-main/main-app.cjs`

**PROVEN byte-exact**, shipped line 159 columns 120727-120758:

```js
new gp.BrowserWindow({show:!1})
```

Beautified `recon/beautified/main-app.beauty.js:73058`, inside a default parameter:

```js
showSaveDialog: s = (j, J) => gp.dialog.showSaveDialog(j ?? new gp.BrowserWindow({ show: !1 }), J),
```

The same pattern appears a second time at `recon/beautified/main-app.beauty.js:98549`:

```js
return r.dialog.showOpenDialog(t() ?? new r.BrowserWindow({ show: !1 }), {
  title: Zp.i18n._({ id: "Bvll0Q" }),
  properties: ["openFile"],
  filters: [{ name: Zp.i18n._({ id: "an5hVd" }), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
});
```

with `r = e.electron ?? { BrowserWindow: K$.BrowserWindow, dialog: K$.dialog }`
(`main-app.beauty.js:98531`). These carry **no `webPreferences` at all**: they exist only so
`dialog.showSaveDialog` / `dialog.showOpenDialog` have a parent window, and they are never shown. They load
no URL.

#### (g) Avatar-source `WebContentsView` (not a BrowserWindow)

**PROVEN** (`recon/beautified/main-app.beauty.js:98459-98466`):

```js
let t = new z$.WebContentsView({
  webPreferences: {
    contextIsolation: !0,
    nodeIntegration: !1,
    sandbox: !0,
    preload: Kut.default.join(Yut.PRELOAD_DIST_DIR, gMn),   // gMn = "preload-avatar-source.cjs"
  },
});
```

then `webContents.loadURL("about:blank")` and a `new MessageChannelMain()` whose `port2` is transferred to
the view (`main-app.beauty.js:98468-98486`). REA records `about:blank` at `dist/electron-main/main-app.cjs:579`
as an `electron-renderer` node with `resolution_status: "external"`. This view is **offscreen**: it is used
to render/decode avatar images to a data URL, and it is never attached to a window in the code read here.

### 3.2 The four REA `browser-window` nodes, reconciled

REA's nodes, with the shipped literal recovered byte-exact from each recorded range:

| REA node key | Shipped literal at that range | Maps to |
|---|---|---|
| `dist/electron-main/main-core.cjs` `141:12105-141:12604` | `new ar.BrowserWindow({...l.windowOptions,...})` | site (a), main window |
| `dist/electron-main/main-app.cjs` `580:40446-580:40678` | `new Cft.BrowserWindow({width:520,height:720,...partition:"onepassword-oauth"}})` | site (d) |
| `dist/electron-main/main-app.cjs` `558:59777-558:59800` | `new lT.BrowserWindow(o)` | site (b), options dynamic |
| `dist/electron-main/main-app.cjs` `159:120727-159:120758` | `new gp.BrowserWindow({show:!1})` | one of site (e)/(f) |

REA's per-node `properties.web_preferences` for the main window are reproduced verbatim
(`recon/rea/js-application.json -> graph.nodes[kind=browser-window, key="141:12105-141:12604"]`):

```json
[{"name":"additionalArguments","value":{"status":"dynamic","value":null,"expression":"[...d.additionalArguments]"}},
 {"name":"contextIsolation","value":{"status":"dynamic","value":null,"expression":"!0"}},
 {"name":"nodeIntegration","value":{"status":"dynamic","value":null,"expression":"!1"}},
 {"name":"preload","value":{"status":"dynamic","value":null,"expression":"Ng.default.join(JA,Ig({isPackaged:ar.app.isPackaged,devCapability:n}))"}},
 {"name":"sandbox","value":{"status":"dynamic","value":null,"expression":"!0"}},
 {"name":"v8CacheOptions","value":{"status":"dynamic","value":null,"expression":"m1(o)"}},
 {"name":"webviewTag","value":{"status":"dynamic","value":null,"expression":"!0"}}]
```

and `"preload_path": null, "preload_resolution_context": null, "absence_means_default": false`.

**This is the crux of "PROVEN vs unresolved", and it must be read precisely:**

* REA's `{"status":"dynamic","value":null}` on `contextIsolation`, `nodeIntegration`, `sandbox` and
  `webviewTag` is a **value-model limitation, not real uncertainty**. The `expression` field carries the
  exact source text `!0` or `!1`. In minified JavaScript produced by this toolchain, `!0` is `true` and
  `!1` is `false` (unary logical-not applied to the numeric literals). The reading in this document
  therefore treats all four as **PROVEN** booleans, and says so explicitly rather than inheriting REA's
  `dynamic` label.
* REA's `{"status":"dynamic"}` on `additionalArguments`, `preload` and `v8CacheOptions` **is** genuine
  non-resolution. `preload` in particular: `preload_path` is `null` and REA's summary reports
  `"preload_entrypoints": 0`. This document resolves the preload by reading `main-core.beauty.js:28604`
  and `:28238-28241`, and states the result as a provenance chain (dir constant -> filename selector ->
  filename literal), not as an REA fact.
* `absence_means_default: false` is REA telling us it will not infer Electron defaults from omission. This
  document honours that for `sandbox` on the WebAuthn window in 3.1(c).

Where REA found **4** windows and this analysis finds **6**, the difference is explained and is not a
contradiction:

* The WebAuthn consent window (site c) is constructed as `new t({...})` where `t` is a **parameter**. REA's
  Electron-API identity resolution follows "proven lexical module aliases and structurally verified
  module-namespace interop" and explicitly refuses dynamic selections
  (`recon/rea/js-application.json -> normalized_result.limitations[2]`).
* The second `{show:!1}` dialog parent is not reported. **INFERRED**: `dist/electron-main/main-app.cjs`
  has REA `parse_status: "partial"` (see section 8), so omissions in that file are expected.

### 3.3 What is NOT set anywhere

**PROVEN ABSENT.** A search across all eight beautified bundles
(`grep -rn "webSecurity\|allowRunningInsecureContent\|experimentalFeatures\|enableBlinkFeatures\|disableBlinkFeatures" recon/beautified/*.beauty.js`)
returns **no matches**. Consequences:

| Property | Status | Reading |
|---|---|---|
| `webSecurity` | **never set** | Electron default (`true`) applies. Cross-origin restrictions are on. |
| `allowRunningInsecureContent` | **never set** | default (`false`) |
| `experimentalFeatures` | **never set** | default |
| `enableBlinkFeatures` / `disableBlinkFeatures` | **never set** | default |
| `nodeIntegrationInWorker`, `nodeIntegrationInSubFrames` | **never set** | default |
| `enableRemoteModule` | **never set** (and removed from modern Electron) | n/a |
| `webviewTag` | **set to `true` on the main window only** | the only window-level escape hatch enabled by flag |

`webviewTag: !0` on the main window is the security-relevant one: it is what makes the `<webview>` hardening
in 3.4 reachable at all. **INFERRED**: because `webviewTag` is enabled deliberately, the app compensates
with a mandatory `will-attach-webview` rewrite rather than relying on defaults.

### 3.4 Webview hardening

**PROVEN** (`recon/beautified/main-app.beauty.js:108051-108065`):

```js
function D(P) {
  P.on("will-attach-webview", (U, G, z) => {
    ((G.nodeIntegration = !1), (G.contextIsolation = !0), (G.sandbox = !0));
    let ee = z.partition === iz;
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

Decoded, on every `<webview>` attach:

| Action | Detail |
|---|---|
| Force `nodeIntegration = false` | unconditional |
| Force `contextIsolation = true` | unconditional |
| Force `sandbox = true` | unconditional |
| Choose preload | `preload-vnc.cjs` (`r`) when `partition === "faas.instance"` (`iz`), otherwise `preload-webview.cjs` (`n`) |
| Register origin | for the VNC partition only, the `src` origin is added to an allowlist set `o` |
| Strip `src` | any `src` whose protocol is not `http:`, `https:` or `about:` is **deleted** |

**PROVEN** partition literal (`recon/beautified/main-core.beauty.js:8612`): `iz = "faas.instance"`.

Request-header rewriting per partition, **PROVEN** (`main-app.beauty.js:108037-108049`): a
`webRequest.onBeforeSendHeaders` handler on `session.fromPartition(iz)` injects a header whose name and value
come from a per-host map `s` (`ee.header` / `ee.value`), plus additional headers from `A(U)`.
`onCompleted` feeds status codes to a failure reporter `R`. The literal header names were not extracted and
are **UNKNOWN**.

Webview sub-surface hardening, **PROVEN** (`main-app.beauty.js:108019-108032`):

```js
let U = () => { P.isDestroyed() || (P.setVisualZoomLevelLimits(1, 1), P.setZoomFactor(1)); };
(P.setZoomFactor(1),
 P.on("dom-ready", U),
 P.on("did-finish-load", U),
 P.on("before-input-event", (G, z) => { e.routeHostInput(z) && G.preventDefault(); }));
```

i.e. zoom is pinned to 1x on every load, and `before-input-event` can be swallowed by a host-side input
router. Registration is scoped to `web-contents-created` where `getType() === "webview"` and the session is
the VNC partition (`main-app.beauty.js:108031-108033`).

### 3.5 Custom protocol schemes

**PROVEN.** All six `sand-*` schemes plus `file` are registered privileged in one call
(`recon/beautified/main-core.beauty.js:21331-21340`):

```js
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

Scheme constant definitions, **PROVEN** (each a literal `var` in `main-core`):

| Constant | Literal | Defined at | Privileges | Handler | What it serves |
|---|---|---|---|---|---|
| `No` | `"sand-media"` | `main-core.beauty.js:20573` | `standard`, `secure`, `supportFetchAPI`, `stream` | `Xne(e)` via `DL` (`:21597`) | Attachment and store media bytes. URL shape `${No}://image/${32-hex-id}` with optional `?r=<rev>` (`:20579-20587`); the `stream` + `supportFetchAPI` privileges are what make `<video>`/`<audio>` seeking and `fetch()` work. Guard: `Ym(url)` requires protocol `sand-media:` and host exactly `image` (`:20595-20599`). |
| `zl` | `"sand-canvas"` | `main-core.beauty.js:21331` | `standard`, `secure` | **handled in main-app**: `wKe.protocol.handle(RKe.SAND_CANVAS_SCHEME, qnn(...))` (`main-app.beauty.js:82193`) | Canvas documents. Cached content lookup, theme-aware rendering, typeface injection; errors reported as `reportDesktopEdgeFailure("canvas-frame", ...)` (`main-app.beauty.js:82180-82194`). |
| `fc` | `"sand-html-preview"` | `main-core.beauty.js:20336` | `standard`, `secure` | `qne` via `DL` (`:21597`) | Sandboxed HTML attachments. Rejects non-HTML (`Ec(n) !== "html"` -> `Po()`), goes through an account gate `kL(Xl?.accountGate, (r) => r.admitPreview(e.signal), ...)`, caps size at `eg`, responds `content-type: text/html; charset=utf-8` (`mc`) with `cache-control: no-cache` (`:21559-21590`). |
| `Dl` | `"sand-avatar"` | `main-core.beauty.js:17731` | `standard`, `secure` | `c.serve` (`:40661`) | Agent and account avatar images. |
| `Ml` | `"sand-favicon"` | `main-core.beauty.js:18477` | `standard`, `secure` | `_o.serveLinkFavicon` with a 503 fallback (`:40663`) | Link-preview favicons. |
| `gc` | `"sand-mcp-app"` | `main-core.beauty.js:20338` | `standard`, `secure` | `Iw(S)` -> `Rw.protocol.handle(gc, (t) => nne(t, e.isEnabled))` (`:20377`, registered at `:40666`) | MCP App HTML frames. URL shape `sand-mcp-app://app/<uuid>` (`bw = "app"`, `:20339`, `:20351`). |
| `file` | `"file"` | n/a | `standard`, `codeCache` | Electron default | Loading `dist/renderer/index.html` and the panel document. The `codeCache` privilege is what allows V8 code caching for file-URL resources. |

MCP App frame mechanics, **PROVEN** (`main-core.beauty.js:20341-20373`):

```js
var gc = "sand-mcp-app", bw = "app", Kl = new Map(), tne = 32;
function xw(e) {
  let t = (0, LT.randomUUID)(), n = (0, LT.randomUUID)();
  for (Kl.set(t, { html: Aw(e.html, e.csp, n), csp: wT(e.csp) }); Kl.size > tne;) { ... Kl.delete(r.value); }
  return { frameUrl: `${gc}://${bw}/${t}`, bridgeKey: n };
}
function nne(e, t) {
  if (!t()) return new Response(null, { status: 404 });
  ...
  return o === void 0 ? new Response(null, { status: 404 })
    : new Response(o.html, { status: 200,
        headers: { "content-type": mc, "content-security-policy": o.csp, "cache-control": "no-store" } });
}
```

Points of interest:

* Frame identity is a random UUID; the map is capped at **32** entries and evicts in insertion order.
* The served HTML is wrapped by `Aw(html, csp, bridgeKey)` (`:20330-20334`) which prepends
  `<meta http-equiv="Content-Security-Policy" content="<per-frame CSP>">` and strips a leading BOM from the
  caller's HTML. A per-frame CSP is therefore supplied by the MCP app author and enforced by the response
  header, on top of the frame's own scheme privileges.
* Access is feature-gated: `Cw(e)` returns `e()?.checkFeatureGate("sand_mcp_apps", { disableExposureLog: !0 }) ?? !1`
  (`:20383-20385`). When the gate is off, the handler returns 404 for every URL.
* Origin checks: `MT(e)` requires protocol `sand-mcp-app:` **and** host `app`; `vw(e,t)` requires the *frame*
  URL to be a `sand-mcp-app:` URL that is not the target itself - used for navigations
  (`main-core.beauty.js:20375-20381`).

Default-protocol-client registration, **PROVEN** (`main-core.beauty.js:15605-15609`): on `whenReady`, the app
calls `setAsDefaultProtocolClient(d)` for each scheme in a configured scheme list. `CFBundleURLTypes` in
`Info.plist` (PROVEN) declares exactly two URL schemes for the bundle:

```
CFBundleURLSchemes => [ "grokbot", "sand" ]
```

**INFERRED**: the runtime scheme list passed to `setAsDefaultProtocolClient` and the bundle's declared
schemes are the same two (`grokbot`, `sand`); deep links arrive through `open-url` and `second-instance`
(`main-core.beauty.js:15589-15624`).

**Corrections to `recon/FINDINGS.md`.** That file lists `slack-canvas`, `active-user-store-canvas` and
`resolve-media` as protocol-scheme strings alongside the six real schemes. Direct reading shows:

* `"canvas"` and `"active-user-store-canvas"` are **resource-locator kind tags**, not schemes:
  `y({ kind: p("canvas"), storeId: g, canvasId: oi })` and
  `y({ kind: p("active-user-store-canvas"), canvasId: oi })` (`recon/beautified/preload.beauty.js:3485-3487`).
  They discriminate a `sand-media`/store locator union.
* `"slack-canvas"` is a **provider id** in a locator construction, not a scheme:
  `{ provider: "slack-canvas", id: \`${n}/${r}\`, url: \`${e.origin}/docs/${n}/${r}\` }`
  (`main-app.beauty.js:80780`), with `"slack-canvas"` also present as a list element at
  `main-app.beauty.js:80583`.
* `"resolve-media"` is an **error/report leg label**: `d("resolve-media", Ae)` and `d("resolve-media", fe)`
  (`main-app.beauty.js:73484`, `:73490`).

The real custom-scheme set is exactly the six registered in `EL()`, plus `file`.

### 3.6 Navigation, popups and input gating on the main window

**PROVEN** (`recon/beautified/main-core.beauty.js:28684-28705`):

```js
function Dg(e, { openExternalUrl: t }) {
  (e.setWindowOpenHandler(({ url: n }) => (t(n), { action: "deny" })),
    e.on("will-navigate", (n, r) => { A1(r, e.getURL()) || (n.preventDefault(), t(r)); }),
    e.on("will-frame-navigate", (n) => {
      if (!n.isMainFrame) {
        if (vw(n.url, n.frame?.url)) { n.preventDefault(); return; }
        ZT(n.url) || hL(n.url, n.frame?.url) || ...
```

| Behaviour | Detail |
|---|---|
| `setWindowOpenHandler` | **always** `{action: "deny"}`; the URL is handed to `openExternalUrl` |
| `will-navigate` | allowed only when the target **origin and pathname both match** the current URL (`A1` compares `origin` and `pathname` only, so query/hash changes are permitted) |
| `will-frame-navigate`, subframe | `sand-mcp-app:` frames that are not the target itself are blocked; then a chain of further predicates |

External-link admission (`main-core.beauty.js:28667-28683`):

```js
var Hie = 1e3, jie = new Set(["http:", "https:", "mailto:", "tel:"]);
function kg(e, t = ue) {
  e.on("before-mouse-event", (r, o) => { o.type === "mouseUp" && (n = t.monotonicNow()); }),
  e.on("before-input-event", (r, o) => {
    o.type !== "keyDown" || o.isAutoRepeat || o.key === "Escape" || (n = t.monotonicNow());
  }),
  { admit(r) { ... if (a === void 0 || yn(a, t.monotonicNow()) > Hie) return !1;
              let i = URL.parse(r)?.protocol;
              return i !== void 0 && jie.has(i); } }
}
```

**INFERRED**: this is a **user-gesture gate for external navigation**. `admit(url)` only returns true if a
mouse-up or a non-repeat key-down that is not `Escape` occurred within the last 1000 ms (`Hie = 1e3`), and
the URL protocol is one of `http:`, `https:`, `mailto:`, `tel:`. The effect is that a script cannot silently
open an external URL or hand it to the OS handler; a real user interaction must precede it. `mailto:` and
`tel:` are included because those are the OS-handoff schemes that can leak data or launch other apps.

`before-input-event` is also used by the webview path (3.4) through a host-side `routeHostInput` router.

### 3.7 Renderer CSP

**PROVEN verbatim**, the complete `Content-Security-Policy` meta tag from `dist/renderer/index.html`
(the file begins with two stray bytes; the tag itself is byte-exact):

```
default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; font-src 'self' data:; img-src 'self' blob: data: file: https: sand-avatar: sand-favicon: sand-media://image; media-src 'self' blob: sand-media:; connect-src 'self' ws: sand-media: https://grok.com; frame-src sand-html-preview: sand-canvas: sand-mcp-app:;
```

Directive-by-directive analysis:

| Directive | Value | What it allows | Assessment |
|---|---|---|---|
| `default-src` | `'self'` | everything not otherwise listed is same-origin only. This is the **fallback for `object-src`, `base-uri`, `form-action`, `frame-ancestors`, `manifest-src`, `child-src`** | Strong. Because there is no explicit `object-src`, `default-src 'self'` blocks `<object>`/`<embed>` from other origins. There is **no `base-uri 'none'` and no `form-action`**, so an injected `<base>` tag or form post to a same-origin path is not blocked by CSP. |
| `style-src` | `'self' 'unsafe-inline'` | same-origin stylesheets **and arbitrary inline `<style>`/`style=` attributes** | Required by the styling system in use (`@stylexjs/stylex` emits atomic CSS, and the boot shell in `index.html` uses an inline `<style>`). It does mean CSS injection is possible if HTML injection is ever achieved. |
| `script-src` | `'self'` | **only** same-origin script files. No `'unsafe-inline'`, no `'unsafe-eval'`, no nonces, no `'wasm-unsafe-eval'` | The strictest useful setting. **No `'wasm-unsafe-eval'`** is notable: WebAssembly compilation would be blocked unless the Wasm is exempt (the `web-tree-sitter` `.wasm` asset exists in `dist/deps/`, and is loaded from the main process rather than the renderer in this design). `'self'` also blocks `data:` and `blob:` scripts. |
| `worker-src` | `'self' blob:` | same-origin and blob-URL workers | Needed by the pdf.js and `file-markdown` module workers, both constructed as `new Worker(..., {type:"module"})` from bundled URLs. `blob:` is permitted but `data:` is not, so the inline-base64 workers seen in the main-process bundles could not be created in the renderer. |
| `font-src` | `'self' data:` | bundled WOFF2 (22 font files) and data-URL fonts | Consistent with the `<link rel="preload" as="font" href="./assets/cursor-icons-16-gwXtdAvu.woff2">` in `index.html`. |
| `img-src` | `'self' blob: data: file: https: sand-avatar: sand-favicon: sand-media://image` | **any `https:` image**, any `file:` image, blobs, data URLs, plus the three app schemes | The permissive entries are `https:` (any host) and `file:`. `file:` in `img-src` lets a renderer reference local paths; combined with `webSecurity: true` this still cannot be *read* by script, only rendered. `sand-media://image` is host-pinned to `image` in the CSP itself as well as in the handler. |
| `media-src` | `'self' blob: sand-media:` | audio/video from the app scheme | Matches the `stream: true` privilege on `sand-media`. |
| `connect-src` | `'self' ws: sand-media: https://grok.com` | same-origin fetch/XHR/WebSocket, **`ws:` to any host**, `sand-media:`, and `https://grok.com` | Two things stand out. (1) Bare `ws:` is scheme-wide and host-agnostic: a WebSocket to **any** host over plaintext `ws:` is allowed by CSP. (2) `https://grok.com` is the only absolute `https:` origin allowed for `connect-src`, so the renderer's direct network egress is limited to same-origin, `sand-media:`, and `grok.com` over HTTPS. In practice the app talks to `api2.cursor.sh` through the **main process** (the `main` RPC edge), not from the renderer, which is why that host does not appear here. |
| `frame-src` | `sand-html-preview: sand-canvas: sand-mcp-app:` | **only** the three app schemes may be framed | No `'self'`, no `https:`. This is the containment boundary for untrusted content: HTML attachments, canvas documents and MCP app frames are each rendered in a frame on a scheme whose handler performs gating (account gate, feature gate, size cap). |
| `frame-ancestors` | not set | falls back to `default-src 'self'` | Effectively same-origin framing only. |

Observations a reimplementation must carry over:

* `script-src 'self'` with `default-src 'self'` is the whole XSS story. There is no nonce/hash plumbing and
  no `strict-dynamic`.
* The **frame schemes are the untrusted-content sandbox**, and they are enumerated exhaustively in
  `frame-src`. Adding a scheme without adding it here is what would break containment.
* The only cross-origin *read* channel the renderer is granted by CSP is `https://grok.com`, plus any `ws:`.

The inline boot style is **PROVEN** verbatim from `index.html`:

```html
<style>:root:not([data-theme]){background:transparent}
#sand-boot-shell{position:fixed;inset:0;background:transparent}
#root:not(:empty)+#sand-boot-shell{display:none}</style>
```

**INFERRED**: `#sand-boot-shell` is a pre-React paint surface that removes itself as soon as `#root` has
children, so the window does not flash white during hydration. `:root:not([data-theme])` implies the theme is
applied by setting a `data-theme` attribute on the root element, which lines up with the `getThemeState` /
`setThemePreference` RPC methods (`preload.beauty.js:3524-3525`) and the `["system","light","dark"]` theme
preference list (`preload.beauty.js:860`).

### 3.8 Panel document CSP (second, weaker policy)

**PROVEN verbatim** from `dist/renderer/src/electron-renderer/desktop-mount/panel/panel.html`:

```
default-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; script-src 'self'; connect-src 'self' ws:;
```

Differences from the renderer CSP, all tightening:

| Directive | Renderer | Panel | Delta |
|---|---|---|---|
| `img-src` | `'self' blob: data: file: https: sand-avatar: sand-favicon: sand-media://image` | `data:` | **Only data URLs.** The panel renders bot marks from `markSvgDataUrl` / data URLs, which is exactly what the `desktop-mount` edge's `mount` method takes (`preload.beauty.js:748`). |
| `connect-src` | `'self' ws: sand-media: https://grok.com` | `'self' ws:` | No app scheme, no `grok.com`. |
| `media-src`, `font-src`, `worker-src`, `frame-src` | present | **absent** | Fall back to `default-src 'self'`. The panel loads no fonts, no media, no workers, no frames. |

`<title>Sand</title>` in the panel document confirms the internal codename surfaces in UI text that was not
renamed.

### 3.9 macOS App Transport Security

**PROVEN** from `Info.plist`:

```
NSAppTransportSecurity => {
  NSAllowsArbitraryLoads => true
  NSAllowsLocalNetworking => true
  NSExceptionDomains => {
    "127.0.0.1" => { NSIncludesSubdomains => false
                     NSTemporaryExceptionAllowsInsecureHTTPLoads => true
                     NSTemporaryExceptionAllowsInsecureHTTPSLoads => false
                     NSTemporaryExceptionMinimumTLSVersion => "1.0"
                     NSTemporaryExceptionRequiresForwardSecrecy => false }
    "localhost" => { ... same ... } } }
```

`NSAllowsArbitraryLoads: true` disables ATS globally for this bundle. **INFERRED**: the app needs arbitrary
loads because it drives a browser inside the product (webviews to arbitrary customer origins, plus MCP OAuth
loopback listeners and the box gateway), not because it talks to its own backend insecurely. The explicit
`localhost` / `127.0.0.1` exception domains exist for the loopback listeners
(`[sand:mcp] loopback OAuth listener ...`, `main-app.beauty.js:82100+` region) and are declared with
insecure **HTTP** loads allowed but insecure HTTPS loads disallowed.

Other declared permission strings on the main bundle (PROVEN): `NSCameraUsageDescription`,
`NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`, `NSBluetoothAlwaysUsageDescription`,
`NSBluetoothPeripheralUsageDescription`, `NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac => true`.
`LSMinimumSystemVersion => "12.0"`, `NSPrincipalClass => "AtomApplication"` (the standard Electron principal
class), `NSHumanReadableCopyright => "Copyright © 2026 SpaceXAI"`.

---
## 4. The contextBridge surface

### 4.1 The exposed globals

**PROVEN.** `contextBridge.exposeInMainWorld` appears at six call sites in `preload.cjs` and one in
`preload-desktop-mount-panel.cjs`, exposing **six distinct global names**.

| # | Global name | Exposed from | Line | REA node |
|---|---|---|---|---|
| 1 | `desktop` | `preload.cjs` | `recon/beautified/preload.beauty.js:4140` | `context-bridge-api` label `desktop`, members `["boot","environment","local","main"]` |
| 2 | `coordinatorPort` | `preload.cjs` | `:4142` | label `coordinatorPort`, members `["claim"]` |
| 3 | `sandRenderTrace` | `preload.cjs` | `:4143` | label `sandRenderTrace`, members `["postMessage"]` |
| 4 | `desktopMount` | `preload.cjs` | `:4145` | label `desktopMount` (main window), members `[]` with `unknown_members: 1` |
| 5 | `__duneReliability` | `preload.cjs` via `lt(contextBridge, ipcRenderer)` (`:82`, `:289`) | `:82` | **not reported by REA**; REA reports a node with `api_key: null`, `api_key_expression: "ht"`, `unknown_members: 1` at `preload.cjs:3` |
| 6 | `__duneRenderTraceSampleRate` | `preload.cjs` via `qi()` (`:278-283`), key is the variable `ht` | `:284` | this is very likely REA's `api_key_expression: "ht"` node (see below) |
| 4b | `desktopMount` | `preload-desktop-mount-panel.cjs` | `:/** last line */` | label `desktopMount`, members `[]`, `unknown_members: 1`, source `dist/electron-preload/preload-desktop-mount-panel.cjs:3` |

The literal exposure block, **PROVEN verbatim**
(`recon/beautified/preload.beauty.js:4139-4151`):

```js
  xu = gi.bridge;
x.contextBridge.exposeInMainWorld("desktop", ku);
vt();
x.contextBridge.exposeInMainWorld("coordinatorPort", xu);
x.contextBridge.exposeInMainWorld("sandRenderTrace", Si(x.ipcRenderer));
Pt();
x.contextBridge.exposeInMainWorld("desktopMount", Fe(ir, fn()));
x.ipcRenderer.on("sand:coordinator-port", (e) => {
  let n = e.ports[0];
  n != null && gi.deliver(ci(n));
});
x.ipcRenderer.on(jt, di);
```

and the two dynamic-key exposures:

```js
function lt(e, n) {                                    // preload.beauty.js:80-85
  let r = { report: (a) => { n.send(ln, a); } };
  e.exposeInMainWorld(dt, r);                          // dt = "__duneReliability"
}
...
function qi() {                                        // preload.beauty.js:280-283
  let e = bt(process.argv);
  e !== null && ee.contextBridge.exposeInMainWorld(ht, e);   // ht = "__duneRenderTraceSampleRate"
}
function vt() { lt(ee.contextBridge, ee.ipcRenderer); }
```

with, **PROVEN** (`preload.beauty.js:73-75`, `:160-171`):

```js
var Hu = { none: 0, equal: 1 / 2, full: 1 };
var dt = "__duneReliability", ln = "dune:reliability-report";
...
var ht = "__duneRenderTraceSampleRate";
var Ct = "--dune-render-trace-sample-rate=";
```

| Global | Shape | Notes |
|---|---|---|
| `__duneReliability` | `{ report(payload) }` -> `ipcRenderer.send("dune:reliability-report", payload)` | Note the channel `dune:reliability-report` is **not** in the `sand:` namespace. |
| `__duneRenderTraceSampleRate` | the parsed value of `--dune-render-trace-sample-rate=<...>` from `process.argv`, or not exposed at all when the flag is absent | The gate is `e !== null`: the global does not exist unless the main window's `additionalArguments` carried the flag. This is why the main window's `additionalArguments: [...d.additionalArguments]` exists at all (`main-core.beauty.js:28643`). |

**On REA's count of six.** REA reports `context_bridge_apis: 6` and `exposed_api_members: 6`, and lists
these six nodes: `sandRenderTrace`, `desktopMount` (main preload), `desktop`, `{api_key_expression: "ht"}`,
`coordinatorPort`, `desktopMount` (panel preload). So REA's six are **the four named globals plus a
duplicate `desktopMount` plus one dynamic-key exposure**. It did not report `__duneReliability`.
**INFERRED**: `lt()` receives the `contextBridge` object as a *parameter*, so the call is
`e.exposeInMainWorld(dt, r)` with a non-namespace callee - exactly the "dynamic selections" case REA's
limitation [2] excludes. The true exposure count is **six distinct global names across seven call sites**.

**On `exposed_api_members: 6`.** That number is not the size of the API. It is the count of members REA could
statically resolve: `boot`, `environment`, `local`, `main` (on `desktop`) + `claim` (on `coordinatorPort`) +
`postMessage` (on `sandRenderTrace`) = 6. The actual surface enumerated below is roughly **330 members**.

### 4.2 `desktop`

**PROVEN verbatim** (`recon/beautified/preload.beauty.js:4115-4137`):

```js
var ku = {
    main: _i,
    boot: hu,
    environment: {
      platform: process.platform,
      isDev: bu,
      usesProductionBackend: Nu(),
      devVoiceHarness: process.env.SAND_VOICE_HARNESS === "backend" ? "backend" : "package",
      hasChromeCookieImport: Ht(process.platform),
    },
    local: {
      getZoomFactor: () => x.webFrame.getZoomFactor(),
      stageAttachmentFile: (e, n) => mi(Cu, e, n),
      noteRendererAlive(e) { x.ipcRenderer.send(qt, e); },
      noteBootGateLanded() { x.ipcRenderer.send(Xt); },
      noteBootGateOpened(e) { x.ipcRenderer.send(zt, e); },
    },
  },
```

with the surrounding bindings (`preload.beauty.js:4091-4114`):

```js
var { mainEdge: Ru, ...hu } = x.ipcRenderer.sendSync("sand:boot-snapshot-sync"),
  fi = ui(pi(Ru, (e) => { x.ipcRenderer.once(Yt, e); }), fn()),
  gi = li({ invokeRequest: () => { fi.invoke("sand:coordinator-port-request", void 0); } }),
  { stageAttachmentPath: Tu, ..._i } = Fe(si, fi),
  Cu = {
    diskPathOf: (e) => (e instanceof File && x.webUtils.getPathForFile(e)) || null,
    stagePath: Tu,
    stageBytes: (e, n) => _i.stageAttachmentBytes({ filename: e, bytes: n }),
  },
  bu = process.env.SAND_RESTART_EXIT_CODE != null && process.env.SAND_RESTART_EXIT_CODE.length > 0,
  Iu = "api2.cursor.sh";
```

#### `desktop.main`

`desktop.main` is `_i`, i.e. the result of building the **`main` RPC edge** and removing
`stageAttachmentPath` from it (that key is re-exposed as `desktop.local.stageAttachmentFile` via `Cu`).

**PROVEN.** The edge is declared at `recon/beautified/preload.beauty.js:3493`:

```js
  si = Ce("main", {
    methods: { openExternal: t().args({ url: s() }), ... },
    events: ce(),
    failureCodes: ce(),
  });
```

`Ce` is the edge-freeze helper (`preload.beauty.js:446-448`):

```js
function Ce(e, n) {
  return Object.freeze({ kind: "rpc-edge", edge: e, methods: n.methods, hasEvents: n.events != null });
}
```

and `ce()` is `return {}` (`preload.beauty.js:421-423`). Because `{}` is not `null`, `hasEvents` is **true**
for both edges, so both `desktop.main` and `desktopMount` gain a `subscribe` member. That single detail is
what explains REA's `unknown_members: 1` on `desktopMount`.

Member counts, derived by counting the declared methods and applying the two adjustments:

| Edge | Declared methods | Exposed as | Adjustments | Members |
|---|---|---|---|---|
| `main` (`si`) | **308** | `desktop.main = _i` | minus `stageAttachmentPath` (moved to `desktop.local`), plus `subscribe` | **308** |
| `desktop-mount` (`ir`) | **12** | `desktopMount = Fe(ir, fn())` | plus `subscribe` | **13** |
| `desktop-mount` (`We`, in the panel preload) | **12** | `desktopMount = Fe(We, we())` | plus `subscribe` | **13** |

The 308 `main` methods, grouped by purpose. Names are quoted verbatim from
`recon/beautified/preload.beauty.js:3495-3939`; the `@N` markers are the beautified line of the first method
in each run so the list can be re-verified.

**Canvas and documents (16)** @3495:
`openExternal`, `openCanvasLink`, `getCanvasShare`, `setCanvasVisibility`, `getCanvasShareAccess`,
`updateCanvasShareAccess`, `setCanvasPageAddress`, `renameCanvas`, `getDocument`, `getDocumentEditRight`,
`saveDocument`, `resolveLibraryPages`, `listLibraryPages`, `listLibraryDocs`, `setDocumentVisibility`,
`getDocumentAssets`

**Feedback and window chrome (17)** @3511:
`submitFeedback`, `getWindowState`, `minimizeWindow`, `focusWindow`, `toggleMaximizeWindow`, `closeWindow`,
`resizeWindowWidth`, `setTitleBarOverlayTone`, `setViewingAgent`, `setComposingAgent`,
`setComputerViewOpen`, `signalBoxIntent`, `setUnreadFilterMenuChecked`, `getThemeState`,
`setThemePreference`, `getBotColorInChatEnabled`, `setBotColorInChatEnabled`

**Local preferences (16)** @3528:
`getHardwareAcceleration`, `setHardwareAccelerationEnabled`, `getSpellCheckEnabled`, `setSpellCheckEnabled`,
`getDesktopNotificationPreferences`, `setDesktopNotificationPreferences`, `relaunchDesktop`,
`getLanguageState`, `setLanguagePreference`, `getEgressTunnelEnabled`, `setEgressTunnelEnabled`,
`getEgressTunnelStatus`, `claimEgressTunnel`, `getWebauthnProxyEnabled`, `setWebauthnProxyEnabled`,
`runNetworkDiagnostics`

**Updates (5)** @3544:
`getUpdateStatus`, `checkForUpdates`, `setUpdateTrack`, `quitAndInstallUpdate`, `setAutoUpdateWhenIdle`

**Boot, box and onboarding (6)** @3549:
`getBoxMigrationStatus`, `getBoxHostPhase`, `markDeepLinksReady`, `getOnboardingSeen`, `setOnboardingSeen`,
`getTimeZone`

**Time zone override and auto-review (3)** @3555:
`setTimeZoneOverride`, `getAutoReviewInstructions`, `setAutoReviewInstructions`

**Local tool permissions (9)** @3560:
`getLocalToolPermission`, `getMessagesAppIcon`, `getTeamMemberPolicy`, `setLocalToolPermission`,
`recordLocalToolApproval`, `clearLocalToolApprovals`, `recordLocalToolStandingGrant`,
`getLocalToolActionGrant`, `setLocalToolActionGrant`

**Avatars and attachments (16)** @3579:
`pickAvatarFile`, `generateAgentAvatarImage`, `resolveAttachmentMedia`, `readAttachmentText`,
`readAttachmentBytes`, `stageAttachmentBytes`, `stageAttachmentPath`, `downloadAttachment`,
`commitStagedAttachments`, `discardStagedAttachment`, `preuploadStagedAttachment`,
`releaseStagedAttachmentPreupload`, `precaptionStagedAttachment`, `forceRecreateComputer`,
`updateComputer`, `getComputerUpgradeSchedule`

**Computer upgrade (4)** @3609:
`scheduleComputerUpgrade`, `rescheduleComputerUpgrade`, `cancelComputerUpgrade`, `forceReconnectGateway`

**Experiments and feature flags (13)** @3613:
`getExperimentsSnapshot`, `exposeFeatureGate`, `peekUsageWarningAssignment`, `exposeUsageWarningExperiment`,
`logComposerTriggerExperimentExposure`, `logGroupChatDiscouragementExperimentExposure`,
`logInviteTeammatesExperimentExposure`, `logOnboardingJobRoleExperimentExposure`,
`logOnboardingRoleUseCaseBotsExperimentExposure`, `logOnboardingNotificationsAskExperimentExposure`,
`applyFeatureFlagOverride`, `refreshFeatureFlags`, `applyExperimentOverride`

**Diagnostics (2)** @3640:
`startRpcTraceWindow`, `readTranscriptStoreTail`

**Marketplace and templates (2)** @3642:
`getPublicBotTemplate`, `listPublicBotMarketplace`

**Slack integration (9)** @3644:
`getGrokBotSlackInstallState`, `startGrokBotSlackConnect`, `installGrokBotSlackApp`,
`reinstallGrokBotSlackApp`, `uninstallGrokBotSlackApp`, `listGrokBotTeamAgents`,
`listGrokBotAgentSessions`, `setGrokBotAgentVisibility`, `cloneGrokBotAgentToTeam`

**Agent configuration (6)** @3662:
`setGrokBotAgentVoice`, `updateGrokBotAgent`, `publishGrokBotAgent`, `unpublishGrokBotAgent`,
`setGrokBotAgentSidebarHidden`, `addGrokBotRoomPeople`
plus `removeGrokBotRoomPeople`, `listGrokBotAgentManagers`, `addGrokBotAgentManager`,
`removeGrokBotAgentManager`, `listGrokBotAgentMeetings`, `getGrokBotAgentAccess`,
`updateGrokBotAgentAccess`, `getGrokBotAgentLinkAccess` (continuing to @3696)

**Agent plugins, skills, memories and files (15)** @3697:
`getGrokBotAgentPlugins`, `setGrokBotAgentPlugins`, `setGrokBotAgentPluginVariables`,
`addGrokBotAgentSkill`, `updateGrokBotAgentSkill`, `removeGrokBotAgentSkill`,
`listGrokBotUserBotMemories`, `promoteGrokBotMemoriesToTeam`, `listGrokBotVaultCredentials`,
`putGrokBotVaultCredential`, `updateGrokBotVaultCard`, `createGrokBotVaultCard`,
`deleteGrokBotVaultCredential`, `listGrokBotEmailInboxes`, `createGrokBotEmailInbox`

**Secrets (5)** @3738:
`listGrokBotSecrets`, `putGrokBotSecret`, `deleteGrokBotSecret`, `carryUserSecretsToGrokBot`,
`listGrokBotAgentFiles`
plus `uploadGrokBotAgentFile`, `deleteGrokBotAgentFile` (@3743)

**Sidebar and pins (4)** @3745:
`getHostPinnedAgents`, `getServerPinnedAgents`, `setHostPinnedAgents`, `getHostSidebarSections`,
`setHostSidebarSections`

**Voice (2)** @3750: `transcribeAudio`, `synthesizeSpeech`
plus `mintVoiceCallCredential`, `voiceCallHarnessSession`, `voiceCallHarnessTool` (@3795, @3808, @3812)

**Cursor account, auth and login flights (16)** @3752:
`getCursorAuthStatus`, `loginCursor`, `getCursorLoginFlight`, `cancelCursorLoginFlight`, `logoutCursor`,
`listCursorAccounts`, `addCursorAccount`, `switchCursorAccount`, `removeCursorAccount`,
`updateCursorAccountName`, `getCursorAvatar`, `updateCursorProfilePhoto`, `getSandMachines`,
`updateSandMachineLabel`, `removeSandMachine`, `startPasskeyEnrollment`
plus `verifyPasskeyEnrollmentCode`, `beginPasskeyRegistration`, `listPasskeys`, `revokePasskey` (@3768-3771)

**Teams (12)** @3772:
`getCursorSelectedTeam`, `listCursorTeamMemberships`, `listCursorTeamMembers`,
`getCursorTeamInviteEligibility`, `sendCursorTeamInvites`, `getCursorTeamInviteLink`,
`listCursorTeamGroups`, `ackCursorTeamFallback`, `getCursorWeeklyUsage`, `getCursorUsageSummary`,
`getCursorEnterpriseUsage`, `getCursorUsageBreakdown`

**PR, privacy, access and terms (13)** @3786:
`getCursorPrReviewPreferences`, `getCursorOriginPrStatus`, `getCursorPrivacyModeEnabled`,
`getCursorUnifyCta`, `getSandAccess`, `getSandAccessFresh`, `getGrokBotTermsRecord`,
`markGrokBotTermsSeen`, `clearGrokBotConnectorPreferences`, `mintXaiCommerceBearer`,
`getCursorPrepaidSettings`, `setCursorPrepaidHardLimit`, `setCursorPrepaidAutoTopUp`

**Cursor dashboard, spend and SCM (8)** @3822:
`invokeCursorDashboardAction`, `cancelCursorSandTrial`, `prepareCursorScmConnect`,
`completeCursorScmConnect`, `getCursorGithubRepoAccess`, `runPasskeyCeremony`, `cancelPasskeyCeremony`,
`setCursorSpendLimit`

**Client-side telemetry and reliability reports (30)** @3836:
`reportAgentLoad`, `reportAccessBlocked`, `reportAgentsUnreachable`, `reportRecoveryAction`,
`reportRebuildLifecycle`, `reportReconciliation`, `reportBoxVisibility`, `reportSendLatency`,
`reportSendAck`, `reportTurnClientStart`, `reportTurnClientOutcome`, `reportReactionAck`,
`reportRenderTtfr`, `reportRenderStream`, `reportVncSession`, `reportVncLiveness`, `reportOpenComputer`,
`reportUpdatePrompt`, `reportUsageWarning`, `reportSidebarAction`, `reportMarketplaceSearch`,
`reportArtifactEngagement`, `reportCloudAgentArtifact`, `reportSigninGate`, `reportOnboardingStep`,
`reportOnboardingCompleted`, `reportClientFailure`, `reportHeapMetrics`, `noteSentryConversation`,
`openCloudAgent`

**Link preview and MCP documents (2)** @3866: `getLinkMetadata`, `stageMcpAppDocument`

**Client persistence (9)** @3868:
`listSecrets`, `readClientPersistence`, `readManyClientPersistence`, `writeClientPersistence`,
`removeClientPersistence`, `listClientPersistenceKeys`, `hasMigratedClientPersistence`,
`migrateClientPersistence`, `getCredentialsState`

**Credentials and connectors (11)** @3877:
`syncCredentialProvider`, `disconnectCredentialProvider`, `disconnectScmConnection`, `isSlackLinked`,
`getSlackLinkUrl`, `approveCredentialRequest`, `denyCredentialRequest`, `detectCredentialMint`,
`startCredentialMint`, `connectCredentialProviderOAuth`, `cancelCredentialProviderOAuth`

**MCP (28)** @3896:
`getMcpState`, `getGrokBotAgentMcpServers`, `getEffectivePlugins`, `getMcpCatalog`, `refreshMcpCatalog`,
`getMcpTeamPopularity`, `getSharepointSignIn`, `getMcpPluginLogo`, `installEntry`, `updatePluginInstall`,
`removeMcpServer`, `uninstallPlugin`, `reconcileUnpublishedPlugin`, `authenticateMcpServer`,
`renameMcpAccount`, `removeMcpAccount`, `setMcpCustomInstructions`, `listMcpServerTools`,
`toggleMcpToolDisabled`, `setMcpToolPermissions`, `adoptServerMcpToolPermissions`, `getFinanceOverview`,
`deleteFinanceConnection`, `startFinanceLink`, `attachProdBoxStatus`, `checkMessagesPermissions`,
`readComputerUsePermissions`, `openComputerUsePermissionSettings`

**Computer-use and Messages permissions (7)** @3929:
`listComputerUseAllowedApps`, `revokeComputerUseAllowedApp`, `getCurrentMachineMessagesEnabled`,
`updateCurrentMachineMessagesEnabled`, `listMessagesAllowedRecipients`, `revokeMessagesAllowedRecipient`,
`listChromeCookieAllowItems`
plus `importChromeCookies`, `listCookieOriginGrants`, `putCookieOriginGrants`, `leaveMeeting` (@3936-3939)

Group totals sum to the observed 308 declared methods. **PROVEN** by direct extraction over
`preload.beauty.js:3493-3945`; the grouping labels are **INFERRED** from the names and are not present in
the bundle.

#### `desktop.boot`

`hu` is the boot snapshot with the `mainEdge` key removed. The sender is **PROVEN**
(`recon/beautified/main-core.beauty.js:19435-19450`):

```js
function HD(e) {
  e.ipcMain.on("sand:boot-snapshot-sync", (t) => {
    t.returnValue = {
      experiments: e.getExperimentService()?.getRendererSnapshot() ?? null,
      theme: e.themeController.getState(),
      language: e.languageController.getState(),
      isAssistiveTechEnabled: e.readAssistiveTechEnabled(),
      isEgressTunnelEnabled: e.settingsStore.getEgressTunnelEnabled(),
      isWebauthnProxyEnabled: e.settingsStore.getWebauthnProxyEnabled(),
      isBotColorInChatEnabled: e.settingsStore.getBotColorInChatEnabled(),
      egressTunnelStatus: e.egressTunnelController.getStatus(),
      mainEdge: e.readMainEdgeState(),
      rosterPhotos: e.readRosterPhotoAccess(),
      computerUseHelperName: e.computerUseHelperName,
    };
  });
}
```

| `desktop.boot` key | Value source |
|---|---|
| `experiments` | renderer snapshot from the experiment service, or `null` |
| `theme` | theme controller state |
| `language` | language controller state |
| `isAssistiveTechEnabled` | accessibility preference |
| `isEgressTunnelEnabled` | settings store |
| `isWebauthnProxyEnabled` | settings store |
| `isBotColorInChatEnabled` | settings store |
| `egressTunnelStatus` | egress tunnel controller status |
| `rosterPhotos` | roster photo access state |
| `computerUseHelperName` | name of the Computer Use helper (ties back to 1.3) |

`mainEdge` is **not** on `desktop.boot`; it is consumed to gate the RPC client. `readMainEdgeState()` returns
the literal `"served"` or `"pending"` (`main-core.beauty.js:40612`), and it is set to `"served"` by
`markMainEdgeServed` (`uJ`), which also pushes `sand:main-edge-served` to the main window
(`main-core.beauty.js:40508-40512`). The gate:

```js
function pi(e, n) {                                    // preload.beauty.js:4096-4100
  return e === "served" ? Promise.resolve()
    : new Promise((r) => { n(r); });
}
```

So every `desktop.main.*` call awaits a promise that either resolves immediately (the snapshot already said
`served`) or resolves when `sand:main-edge-served` arrives on the preload once-listener. **INFERRED**: this is
how the renderer can call `desktop.main` during its own first paint without racing main-process handler
registration.

#### `desktop.environment`

| Member | Value | Provenance |
|---|---|---|
| `platform` | `process.platform` | literal |
| `isDev` | `process.env.SAND_RESTART_EXIT_CODE != null && ...length > 0` | literal, `preload.beauty.js:4109` |
| `usesProductionBackend` | `Nu()`: true when neither `SAND_BACKEND_URL` nor `CURSOR_API_BASE_URL` is set, otherwise `URL.canParse(e) && new URL(e).host === "api2.cursor.sh"` | literal, `:4111-4114` |
| `devVoiceHarness` | `process.env.SAND_VOICE_HARNESS === "backend" ? "backend" : "package"` | literal |
| `hasChromeCookieImport` | `Ht(process.platform)` | literal |

`Iu = "api2.cursor.sh"` confirms the backend host literal recorded in `recon/FINDINGS.md`, and shows the
override variables are treated as a *deviation detector*, not merely as an override.

#### `desktop.local`

| Member | Behaviour |
|---|---|
| `getZoomFactor()` | `webFrame.getZoomFactor()` |
| `stageAttachmentFile(file, name)` | `mi(Cu, file, name)`: uses `webUtils.getPathForFile(file)` to get a disk path and stage by path, else reads the `File` into bytes and stages by bytes |
| `noteRendererAlive(seq)` | `ipcRenderer.send("sand:renderer-alive", seq)` |
| `noteBootGateLanded()` | `ipcRenderer.send("sand:renderer-boot-gate-landed")` |
| `noteBootGateOpened(seq)` | `ipcRenderer.send("sand:renderer-boot-gate-opened", seq)` |

**PROVEN** `mi` (`preload.beauty.js:4085-4091`):

```js
async function mi(e, n, r) {
  let a = e.diskPathOf(r);
  return a != null ? await e.stagePath({ filename: n, sourcePath: a })
                   : await e.stageBytes(n, new Uint8Array(await r.arrayBuffer()));
}
```

Note the asymmetry: `desktop.local.stageAttachmentFile` has the `File` ergonomics, while
`desktop.main.stageAttachmentBytes` is the raw byte path. `webUtils.getPathForFile` is the
Electron-32-and-later replacement for the removed `File.path` property.

### 4.3 `desktopMount`

Two independent instances of the same edge, one per document.

**Main window** (`preload.beauty.js:4145`): `Fe(ir, fn())` where `ir` is `Ce("desktop-mount", {...})` at
`:741-758`.

**Panel document** (`preload-desktop-mount-panel.cjs`, minified, single line): the same edge under minified
names, followed by the literal

```js
We=V("desktop-mount",{methods:{mount:p().args({agentId:J(),name:Ge,markSvgDataUrl:Bn}),unmount:p().noArgs,
offerChoices:p().args({choices:Vn}),read:p().noArgs,readChoices:p().noArgs,readLayout:p().noArgs,
submitPrompt:p().args({prompt:Ke}),switchTo:p().args({agentId:J()}),unmountSelf:p().noArgs,
reachForMenu:p().args({heightPx:Hn}),movePanel:p().args({dx:$e,dy:$e}),endPanelMove:p().noArgs},
events:A(),failureCodes:A()});var Gn=G(We,we());Ye.contextBridge.exposeInMainWorld("desktopMount",Gn);
```

The 12 methods (`recon/beautified/preload.beauty.js:747-757`), with argument shapes:

| Method | Args |
|---|---|
| `mount` | `{ agentId, name, markSvgDataUrl }` |
| `unmount` | none |
| `offerChoices` | `{ choices }` - at most 640 mount targets (`hn = 640`) |
| `read` | none |
| `readChoices` | none |
| `readLayout` | none |
| `submitPrompt` | `{ prompt }` |
| `switchTo` | `{ agentId }` |
| `unmountSelf` | none |
| `reachForMenu` | `{ heightPx }` - integer 0..640 |
| `movePanel` | `{ dx, dy }` - integers from -16384 to 16384 (`Ke = 16384`) |
| `endPanelMove` | none |

Plus `subscribe` (from `hasEvents`). This is the API that drives the always-on-top desktop panel from 3.1(b):
`read`/`readLayout` for its current state, `offerChoices`/`switchTo` for the bot switcher, `movePanel` /
`endPanelMove` for dragging, `reachForMenu` for the menu geometry, and `submitPrompt` to send a prompt from
the panel.

### 4.4 `coordinatorPort`

**PROVEN verbatim** (`recon/beautified/preload.beauty.js:4015-4036` and `:4061-4075`):

```js
function li(e) {
  let n = null;
  return {
    bridge: {
      claim(r) {
        return n != null ? null
          : ((n = r),
            { request: () => { n === r && e.invokeRequest(); },
              release: () => { n === r && (n = null); } });
      },
    },
    deliver(r) { n?.onPort(r); },
  };
}
...
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

`coordinatorPort` has exactly one member, `claim`. Semantics, all **PROVEN** from the literals:

| Aspect | Behaviour |
|---|---|
| Single claimant | `claim` returns `null` if a claimant already holds the slot; the previous holder is **not** evicted |
| Returns | `{ request(), release() }` |
| `request()` | asks the main process for the coordinator port, but only while this claimant still holds the slot |
| `release()` | clears the slot only if this claimant still holds it |
| Inbound handle | main-side `deliver(port)` calls `claimant.onPort(port)`; the preload wires `deliver` to the MessagePort delivered by `sand:coordinator-port` (`preload.beauty.js:4146-4149`) |
| Port wrapper | `ci(port)` exposes `postMessage`, `close`, `start`, and an `addEventListener` that supports only `"message"` (delivering `{data}`) and treats any other event name as `"close"` (delivering `{}`) |

**INFERRED**: the single-claimant design means "exactly one renderer context owns the coordinator connection
at a time" - a lease. `request()` re-requests on behalf of the current holder, which is what makes it safe
for main to revoke and re-grant the port (the `rendererRequestRevoked` field in the main-side state machine
at `main-app.beauty.js:82517-82533`) without the renderer losing its claim.

### 4.5 `sandRenderTrace`

**PROVEN verbatim** (`recon/beautified/preload.beauty.js:4073-4083`):

```js
function Si(e, n = () => new MessageChannel()) {
  let r = null;
  return {
    postMessage(a) {
      if (r === null) {
        let i = n();
        (e.postMessage(yi, null, [i.port2]), (r = i.port1));
      }
      r.postMessage(a);
    },
  };
}
```

with `yi = "sand:render-trace-port"` (`:4072`). One member, `postMessage(payload)`.

Behaviour: the first call lazily creates a `MessageChannel`, transfers `port2` to the **main** process as a
MessagePort on `sand:render-trace-port`, caches `port1`, and then posts the payload. Every later call reuses
the cached port. This is a one-way, ordered, high-volume channel - a render-trace stream - and it is
explicitly outside the `ipcRenderer.invoke` RPC path so it does not contend with RPC.

Main-side receiver, **PROVEN** (`recon/beautified/main-core.beauty.js:28245-28251`):

```js
var UF = "sand:render-trace-port";
function FF(e, t) {
  e.ipc.on(UF, (n) => {
    let r = n.senderFrame === e.mainFrame;
    for (let o of n.ports) r ? t(o) : o.close();
  });
}
```

The `senderFrame === mainFrame` check is a **sender-validation** observation: ports arriving from any frame
other than the main frame are closed rather than delivered. REA records
`sender_validation_observations: 2`, with the caveat that these "are observations only; REA does not claim
that they enforce a complete authorization policy"
(`recon/rea/js-application.json -> normalized_result.limitations[8]`).

The render-trace hook is injected into the renderer document before anything else, **PROVEN** from
`dist/renderer/index.html`:

```html
<script src="./assets/dune-render-trace-hook-265eb7be.js"></script>
```

and the same tag appears in the panel document as
`<script src="../../../../assets/dune-render-trace-hook-265eb7be.js"></script>`. The hook reads the sample
rate global (`__duneRenderTraceSampleRate`) and installs the devtools hook `__DUNE_DEVTOOLS_HOOK__`
(`preload.beauty.js:449`, `:453-456`: `Ut(e = globalThis)` looks up `globalThis[Qi]` and validates
`version === 1 && typeof register === "function"`). Note the file is one of REA's four **parse failures**
(`recon/rea/js-application.json -> graph.nodes[kind=javascript-asset, path=dist/renderer/assets/dune-render-trace-hook-265eb7be.js]`,
`parse_status: "failed"`), so REA's view of it is empty.

### 4.6 The RPC edge pattern (how all of `desktop.main` works)

This is the single most important mechanism in the preload, so it is spelled out in full.

**PROVEN** (`recon/beautified/preload.beauty.js:451-484`, `:288-305`, `:4061-4071`).

Channel names are derived, not literal, per edge and method:

| Purpose | Template | Helper |
|---|---|---|
| Unary call | `` `dune-rpc:${edge}:m:${method}` `` | `nd(e, n)` `:472` |
| Event subscription | `` `dune-rpc:${edge}:e:${event}` `` | `Ft(e, n)` `:475` |
| Capability probe | `` `dune-rpc:${edge}:probe` `` | `td(e)` `:478` |
| Reliability report | `"dune:reliability-report"` | `ln` `:74` |

The client is built by `Fe(edge, transport, options)`:

1. Every declared method becomes a function. `schema === null` means "no arguments", so it calls with `{}`:
   `a[N] = V === null ? () => C(N, {}) : (D) => C(N, D)` (`:506`). This is why the declarations use `t().noArgs`
   and `t().args({...})` - `noArgs` compiles to a `null` schema.
2. The call goes through `C`, which optionally records a measure (`{kind: "rpc", edge, method, ok, failureCode}`)
   and then `I`.
3. `I` invokes `transport.invoke("dune-rpc:<edge>:m:<method>", payload)` and unwraps an **envelope**
   (`:485-505`):
   * the reply must be an object with a boolean `ok` (`Vt`), otherwise
     `EdgeCallFailure { code: "edge/handler-failed", detail: "The edge replied outside its envelope." }`;
   * `ok: true` returns `value`;
   * `ok: false` throws `EdgeCallFailure(reply.failure)`.
4. On a transport-level throw, `S` probes the edge: it calls `dune-rpc:<edge>:probe` and, if the probe
   answers `{ok: false, failure: {code: "edge/unknown-method"}}`, rethrows that reason; otherwise it reports
   `{code: "edge/transport-failed"}` with the original error message. So "the caller forgot to define this
   method" is distinguishable from "the transport is down".
5. Failure codes are a closed vocabulary (`:457-459`): `"edge/unknown-method"`,
   `"edge/transport-failed"`, `"edge/handler-failed"`. `EdgeCallFailure` stringifies as `` `${code}: ${detail}` ``
   and carries `.code` and `.detail` (`:461-469`).
6. If the edge has events, `subscribe(handlers)` registers one listener per entry and returns a
   teardown that removes them all (`:508-518`).
7. Every call is also announced to the devtools hook if present:
   `Ut()?.register({ kind: "rpc-edge", role: "bridge", declaration: e, trust: [] })` (`:519`).

The transport is `fn()` (`preload.beauty.js:290-306`):

```js
function wt(e) {
  return {
    invoke: (n, r) => e.invoke(n, r),
    on: (n, r) => {
      let a = (i, S) => { r(S); };
      return (e.on(n, a), () => { e.off(n, a); });
    },
  };
}
function fn(e) { return e != null ? wt(e.ipcRenderer) : wt(ee.ipcRenderer); }
```

so `dune-rpc:*` messages are ordinary `ipcRenderer.invoke` / `ipcRenderer.on` traffic. The **wire protocol is
three string prefixes plus a JSON envelope**, and the whole 308-method surface is carried by it. That is the
key structural fact for a reimplementation: there is no per-method channel, no per-method preload code, and
no code generation at runtime - the edge declaration is data.

### 4.7 Argument validation

**PROVEN**. Edge methods carry schemas built from a small combinator library, so validation happens in the
preload before the IPC hop. Observed constructors and their literals:

| Helper (minified) | Meaning | Evidence |
|---|---|---|
| `t().noArgs` | null schema, no arguments | e.g. `preload.beauty.js:3512` |
| `t().args({...})` | object schema | throughout `:3495-3939` |
| `s()`, `g()`, `u()` | string-ish scalars under different constraints | e.g. `openExternal: t().args({ url: s() })` |
| `m()`, `Ee` | boolean | `setOnboardingSeen: t().args({ seen: m() })` |
| `b()`, `k` | number | `resizeWindowWidth: t().args({ deltaWidth: b() })` |
| `_("...", pred)` | named refinement with a human label | `_("theme preference", hr)`, `_("local tool permission", $s)` |
| `y({...})` | nested object schema | `y({ isEnabled: m(), allowInstructions: E(s()), blockInstructions: E(s()) })` |
| `E(x)` | array of `x` | `E(y({ profileId: g, domain: g, name: g, path: g }))` |
| `M(x)` | nullable/optional | `setViewingAgent: t().args({ agentId: M(c()) })` |
| `d(x)` | optional | `getDocument: t().args({ locator: ve, groupChatId: d(g) })` |
| `h(...)` | union of literals | `intent: h(p("composer_focus"), p("upload_start"), p("file_open"))` |

Concrete bounded refinements recovered verbatim:

| Literal | Constraint | Line |
|---|---|---|
| `` `integer from 0 to ${hn}` `` with `hn = 640` | panel `reachForMenu.heightPx` | `:738`, `:613` |
| `` `integer from -${Ke} to ${Ke}` `` with `Ke = 16384` | panel `movePanel.dx`/`.dy` | `:739`, `:617` |
| `` `at most ${Rn} mount targets` `` with `Rn = 64` | `offerChoices.choices` | `:737`, `:596` |
| `` `non-blank string of at most ${Tn} characters` `` with `Tn = 64` | various ids | `:712`, `:621` |
| `var dr = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i` | UUID (v1-v5/v7) acceptance for agent ids | `:759` |
| `var md = /^\d{6}$/` | six-digit PIN | `:786` |
| `var _r = /^[A-Za-z0-9_-]{21}$/` | share id | `:813` |
| `var Rd = /^[a-z0-9][a-z0-9-]{2,63}$/` | slug | `:814` |
| `var pr = ["image/png", "image/jpeg", "image/webp"]` | accepted image MIME types | `:772` |
| `2 MiB` image cap | `ur(e)`: `"empty"`, `"too-large"` above 2097152 bytes, `"unsupported-type"` | `:776-787` |
| `Ai = 1048576` | a 1 MiB bound used by a node-reliability budget | `:25`, `:49` |
| `Di = 1024 * 1024`, `MS = 256 * 1024`, `Mi = 864e5` | memory/interval bounds | `:110`, `:115`, `:112` |
| `i_ = 100 * 1024 * 1024` | 100 MB bound on stored canvases | `:762` |
| `We = "/cursor/stores"`, `Ye = "canvases"` | store root and canvas collection names; `lr = /cursor/stores/user/canvases` | `:763-765` |

The **probe** mechanism plus these schemas together give a reimplementation a testable contract: invalid
arguments are rejected in the renderer with a named-refinement failure, before any IPC occurs.

---
