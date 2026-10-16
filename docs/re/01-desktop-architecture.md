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
