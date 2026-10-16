# 03 — Execution and permissions: the `local-exec` daemon

How Grok Bot runs things on the user's own machine, and what stops it. Covers
`dist/local-exec-daemon/main.cjs` (3,548,655 bytes), the main-process code that
spawns and supervises it, the permission/approval model that gates its tools,
the sandbox machinery it carries, its process and filesystem handling, its use
of tree-sitter, and the macOS Messages bridge
(`dist/local-exec-daemon/messages-worker.cjs`).

## Scope & method

**Target.** Grok Bot desktop 0.71.2, `com.anysphere.sand`, built 2026-10-14.

All line citations are against the **regenerated** beautified artifacts in
`recon/beautified/` — the ones produced after the extractor's 2-byte
asar-header alignment bug was fixed (`recon/FINDINGS.md` §E1). Line numbers in
the earlier `docs/re/` dossiers were taken from the pre-fix files and may be
one line off. **Every line number below was re-read against the file on disk
before being written down.**

| Artifact | Role here |
|---|---|
| `recon/beautified/local-exec-daemon.beauty.js` (5.0 MB) | the daemon: tools, policies, sandbox plumbing, Messages host |
| `recon/beautified/main-core.beauty.js` (1.2 MB) | spawn / identity / terminate primitives, daemon state files, no-follow file I/O |
| `recon/beautified/main-app.beauty.js` (3.7 MB) | desktop-edge executors, coordinator bootstrap, quit path, feature flags |
| `recon/beautified/node-agent-coordinator.beauty.js` (1.2 MB) | **the supervisor** — refresh loop, credential minting, respawn accounting |
| `recon/beautified/messages-worker.beauty.js` (70 KB) | the Messages bridge |
| `recon/grokbot-0.71.2/dist/deps/runtime-deps-manifest.json` | which native addons actually ship |
| `recon/rea/projection-boundaries.json` | independent confirmation of the native-addon set |

**Method.** Static reading only. Nothing was executed from the bundles; no
network traffic was captured. Short literal quotes appear as evidence; no
implementation code is reproduced.

**Confidence convention.** Every non-obvious claim is marked **PROVEN** (the
behaviour is directly readable in the cited literal), **INFERRED** (the literal
is cited but the conclusion needs a stated reasoning step), or **UNKNOWN** (not
determinable from these artifacts, with the reason given).

**A note on names.** Every bundle is minified production output with no source
maps. Identifiers such as `qQ`, `Zse`, `B4` are **minifier names, not API
names**. Where this document writes a symbol name it is either a runtime string
that survives minification (a class `name` field, an error `name`, a filename,
an env var) or is explicitly flagged as a paraphrase.

---

## 0. Summary

Grok Bot runs a **separate, long-lived Node process** — the `local-exec`
daemon — that receives work over an **outbound SSE stream plus a POST
endpoint** on the vendor's gateway and executes it with **no OS-level sandbox**
on the packaged macOS build, because the sandbox helper binary is not shipped
and its path is never configured. The daemon does not decide whether a command
is allowed; it executes what the authenticated caller asks for, subject to (a)
an administrator **command denylist** that is fail-closed, and (b) whatever
**sandbox policy the caller requests** — which, when it is anything other than
`insecure_none`, is refused outright on this build rather than run unsandboxed.
Approval is a **separate, higher layer** that gates file transfer, Messages and
computer use through an `always`/`ask`/`never` ladder capped by a `ceiling`,
plus the denylist that no user approval can override.

---

## 1. Topology

| Process | Bundle | Started by | Talks to |
|---|---|---|---|
| Electron main | `main.cjs` → `main-core.cjs` → `main-app.cjs` | Electron | renderer (IPC), coordinator (MessagePort) |
| Coordinator | `dist/node-agent-coordinator/main.cjs` | `utilityProcess.fork` from main | main (MessagePort), gateway (HTTPS/SSE) |
| **local-exec daemon** | `dist/local-exec-daemon/main.cjs` | **the coordinator, via an RPC back to main** | gateway (SSE in, POST out) |
| Messages worker | `dist/local-exec-daemon/messages-worker.cjs` | the daemon, as a `worker_threads` `Worker` | the daemon (postMessage) |
| local-cua sidecar | `<Cursor Computer Use.app>/Contents/MacOS/CUCursorService` (**not in the asar**) | the daemon, `spawn` detached | the daemon (Unix socket) |

**PROVEN** for all five rows. The sidecar path literal is
`local-exec-daemon.beauty.js:104247`; the bundle name `"Cursor Computer Use"`
is at `:104360`. That bundle is absent from `recon/grokbot-0.71.2/`.

**The daemon is not reachable from the local machine.** Across the 5 MB
bundle: zero `.listen(`, zero `WebSocketServer`; the only `createServer` hit is
the substring in the identifier `createServerClient`
(`local-exec-daemon.beauty.js:136675`). The only socket *client* is the
local-cua Unix socket (`createConnection({ path: e })`, `:104292`).
**PROVEN, with a negative-result caveat**: absence of a literal is evidence
about this artifact, not proof about another build of the same source.

So the daemon is a **pure outbound client**: `GET {baseUrl}/local-exec/requests`
with `Accept: text/event-stream` (`:111759`; path literal `:83659`) and results
to `{baseUrl}/local-exec/responses` (`:83660`). Its startup line says so:

> `[sand-local-exec-daemon] started (pid ${process.pid}); serving local exec over the gateway`
> — `local-exec-daemon.beauty.js:143312`

This is a materially different internet-exposure posture from a loopback
socket: no local port to attack, but also **no local authentication boundary**.
The only thing between the public internet and the user's shell is the daemon's
gateway credential.

---

## 2. Daemon lifecycle

### 2.1 Entry point

`n7r` (`local-exec-daemon.beauty.js:143250`–`:143320`) does, in order:
install an invariant reporter (`Xwe`, `:143274`); initialise Sentry for the
scope literal `"sand-local-exec-daemon"` (`:143284`); await the file-key /
machine-id handoff (`:143286`); construct the backend client and executor and
enter the request loop (`await Bet({…})`, `:143299`); log the started line and
install `SIGTERM`/`SIGINT` handlers with a 2 s shutdown deadline
(`Zpt = nc({name: "local-exec-daemon-shutdown", timeoutMs: 2e3})`, `:143272`).
**PROVEN.** A missing machine id throws
`"local-exec daemon bootstrap is missing its machine id"` (`:143288`) and exits 1.

### 2.2 The supervisor lives in the **coordinator**

`main-core.cjs` holds the *primitives* — `spawnLocalExecDaemon`,
`isLocalExecDaemonAlive`, `killLocalExecDaemon`, `isLocalExecDaemonSpawn`,
`terminateProcess` — but **no supervisor loop**. The supervisor is a state
machine `MG(r)` inside `dist/node-agent-coordinator/main.cjs`
(`node-agent-coordinator.beauty.js:39020`–`:39490`), driven by a periodic
refresh (`PG()` → `an({ name: "local-exec-daemon-refresh", intervalMs: vG })`,
`:38980`–`:38982`). **PROVEN.**

It drives main over an RPC edge declared in `main-app.cjs` as
`Ko("coordinator-control", { methods: {…} })` (`main-app.beauty.js:84453`):
`spawnLocalExecDaemon` (`:84485`), `terminateProcess`, `isProcessAlive`,
`getMachineId`, `mintLocalExecDaemonCredential` (`:84464`),
`sealLocalExecFile`, `reportLocalExecSupervisorFailed` (`:84503`). **PROVEN.**

**Consequence:** if the coordinator dies, the daemon loses its supervisor and
exits on its own (§2.10); if main dies, the coordinator goes with it. The
daemon's lifetime is a function of the coordinator's, except for the quit-time
kill, which *is* driven from main.

### 2.3 Two spawn paths

`main-core.beauty.js:30061`–`:30091` is the whole decision.

**(A) `utilityProcess.fork`** — `main-core.beauty.js:30004`:

```js
let t = e.fork(e.entryPath, { env: e.env, stdio: "pipe", serviceName: IR });
```

`IR = "sand-local-exec-daemon"` (`main-core.beauty.js:29843`). This is the
Electron **utility-process service name** — what labels the process in
`app.getAppMetrics()` and crash reports. It is not a system service. **PROVEN.**

The fork is taken only when a fork hook was injected **and** no explicit entry
argv was supplied (`i != null && a == null`, `main-core.beauty.js:30084`, where
`i = t?.utilityFork` and `a = t?.daemonEntryArgv`). The desktop supplies the
hook: `main-app.beauty.js:91571` passes
`utilityFork: (L, B) => Ig.utilityProcess.fork(L, [], B)` into the executor
bundle, and the `spawnLocalExecDaemon` executor forwards it
(`main-app.beauty.js:83058`–`:83061`).

**So on the packaged desktop, path A is the live path. INFERRED** — the
inference is that `utilityFork` is non-null at that call site because the same
object literal defines it. The RPC surface itself
(`spawnLocalExecDaemon: I().args(qrn)`,
`qrn = {env, logPath, deadDaemonRecord}`, `main-app.beauty.js:84428`) carries no
entry argv, so `a` cannot be set over the wire.

**(B) Detached `spawn`** — `main-core.beauty.js:30025`–`:30046`:

```js
let n = oB(process.execPath, [...e.entryArgv],
  { detached: !0, stdio: ["ignore", t, t, "ipc"], env: e.env });
```

`t` is an `openSync(logPath, "a")` descriptor, so **stdout and stderr both go
to the daemon's log file**. `"ipc"` gives the child a Node IPC channel; the
parent immediately sends the file-key handoff (`n.send(e.handoff)`, `:30036`),
then **unrefs the channel** (`n.channel?.unref()`, `:30040`) and the child
(`n.unref()`, `:30045`) so the daemon does not keep the parent alive. **PROVEN.**

`oB` (`main-core.beauty.js:30056`) is not plain `spawn`: it scans
`/proc/self/fd` for inherited, non-`FD_CLOEXEC` descriptors above the stdio
range, passes them through as `/dev/null` slots, and records the mapping in the
child env as `SAND_LOCAL_EXEC_INHERITED_FDS` (`L1`, `main-core.beauty.js:28773`).
The daemon parses and immediately deletes that variable
(`local-exec-daemon.beauty.js:143259`–`:143264`). Purpose **INFERRED** as "do not
leak open descriptors into a detached child while keeping fd numbering stable";
the code does not say.

### 2.4 The child environment

`main-core.beauty.js:29844`:

```js
function Zse(e, t) {
  let n = { ...process.env, ...e.env, [w1]: String(t), [wg]: "1" };
  return (delete n.ELECTRON_RUN_AS_NODE, n);
}
```

| Var | Value | Why (evidence) |
|---|---|---|
| `SAND_LOCAL_EXEC_GENERATION` (`w1`, `main-core.beauty.js:28772`) | account-generation counter as a decimal string | daemon reads it (`Number(t[g6e])`, `local-exec-daemon.beauty.js:143265`), validates it as a non-negative integer, republishes it in its discovery record |
| `NODE_USE_SYSTEM_CA` (`wg`, `main-core.beauty.js:28774`) | `"1"` | root Node's TLS trust in the OS store; the daemon **deletes it from its own env** after startup (`delete t[_6e]`, `local-exec-daemon.beauty.js:143262`) |
| `ELECTRON_RUN_AS_NODE` | **deleted** | otherwise an Electron helper spawned from this env boots the Electron shell instead of Node |

**PROVEN**; matches `recon/FINDINGS.md` §E2 item 5. `FINDINGS.md` phrased it as
"the exec-daemon child environment"; the code is in `main-core`, which is where
the child env is built.

The supervisor adds only two vars over the RPC
(`node-agent-coordinator.beauty.js:39200`–`:39206`): `SAND_PACKAGED`
(`"1"`/`"0"`) and, when a system proxy is in force, `SAND_NODE_PROXY_ENV` with
the raw proxy JSON. Separately, main injects `NODE_USE_SYSTEM_CA=1` when it
forks the **coordinator** (`main-app.beauty.js:91563`). **PROVEN.**

### 2.5 Identity verification — two checks, not one

**Loose check — "is this pid a local-exec daemon at all?"**
`main-core.beauty.js:29948`:

```js
var oce = 15;
function NB(e) {
  let t = e.trim();
  return t.includes("local-exec-daemon") || t.includes(IR) ? !0 : t === IR.slice(0, oce);
}
```

`IR.slice(0, 15)` is `"sand-local-exec"` (Linux truncates `comm` to 15 chars).
The check accepts a cmdline **or** `comm` that merely *contains*
`local-exec-daemon` / `sand-local-exec-daemon`, or a `comm` equal to
`sand-local-exec`. **PROVEN.** This is deliberately permissive: it is used
before *killing* a stranger, where a false negative would leave an orphan
running. **INFERRED** as to intent.

**Strict check — "is this the daemon *we* spawned?"**
`main-core.beauty.js:29959`:

```js
async function MB(e, t = OR()) {
  return zi.has(e) ? !0 : (await LB(e)) === `${process.execPath} ${t}`;
}
```

An **exact string equality** between the command line and
`"<process.execPath> <entryPath>"`. `zi` is the in-process set of pids this
process spawned (`zi.add` on `"spawn"` `:30014`/`:30029`, `zi.delete` on
`"exit"` `:30022`/`:30043`). **PROVEN.** The short-circuit makes the check
strict only for pids this process did *not* spawn — which is exactly the
orphan case it exists for. `OR()` (`:29892`) resolves to
`join(dirname(fileURLToPath(import.meta.url)), "..", "local-exec-daemon", "main.cjs")`.

**Reading the command line** (`LB`, `main-core.beauty.js:29903`): try
`/proc/<pid>/cmdline`, replace NULs with spaces, else a subprocess —

| Platform | Command | Timeout |
|---|---|---|
| win32 | `powershell.exe -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = <pid>').CommandLine"` | 5000 ms |
| other | `ps -p <pid> -o command=` | **2000 ms** |

`main-core.beauty.js:29918`. `rce` (`:29925`) reads `/proc/<pid>/comm` with the
same fallback (`comm=`). **PROVEN.** The "2 s timeout" in the brief is the `ps`
timeout at `:29918` / `:29940`.

**Liveness with a freshness gate.** `UB` (`main-core.beauty.js:29969`) is
`isLocalExecDaemonAlive`: `pn(pid)` (`process.kill(pid,0)`, `EPERM` = alive,
`:29896`), and when the caller asks for the "serving mark stale" check, `sce`
→ `ice` (`:29963`) requires all of:

1. the discovery record's `servingAt ?? startedAt` is not stale —
   `!(t - e > U1)`, `U1 = 6 * eR = 12000` ms (`main-core.beauty.js:28778`–`:28779`);
2. the loose identity check passes;
3. after a `2 * eR` = **4 s** settle (`await Nu(r, ace)`, `ace` at `:29962`), the
   discovery record is **re-read and deep-equal to what it was**.

**PROVEN.** The 4 s read–wait–read consistency check is worth naming: it is not
a simple poll.

### 2.6 The state files

All are `join(<dataRoot>, <name>)`; the names are string literals duplicated in
both bundles. **PROVEN.**

| File | Literal | main-core | coordinator | daemon |
|---|---|---|---|---|
| discovery | `local-exec-daemon.json` | `:28766` | `:32948` | `:67933` |
| credential | `local-exec-daemon-credential.json` | `:28767` | `:32949` | `:67934` |
| connection | `local-exec-daemon-connection.json` | `:28765` | `:32947` | `:67932` |
| supervisor heartbeat | `local-exec-supervisor.json` | — | `:32951` | `:67935` |
| daemon log | `local-exec-daemon.log` | — | `:32950` | — |
| update lease | `local-exec-update-lease.json` | `:28768` | — | `:67936` |
| account retire marker | `local-exec-account-retire.json` | `:28769` | — | — |
| account generation | `local-exec-account-generation.json` | `:28770` | — | — |
| computer-use gate | `local-computer-use-gate.json` | `:28771` | — | `:67938` |
| backend return | `local-exec-backend-return.json` | — | — | `:67937` |

**Discovery record** (`Lg` validator, `main-core.beauty.js:28785`–`:28827`):
`pid` (positive int, required), `startedAt` (number, required), `servingAt`
(number), `inflightCount` (non-negative int), `filesKeyId` (string, a 16-hex
SHA-256 prefix of the file key — `$1`, `:28865`), `generation` (non-negative
int), `rejectedAccountScopes` (string[], each 1–128 chars), `proxyFingerprint`
(16-hex of the proxy env — `Q1t`, `:68123`). **PROVEN.**

It is written **pretty-printed** (`Pxe` → `Axe(e, t, {pretty: !0})`,
`local-exec-daemon.beauty.js:68824`): the discovery record is plaintext JSON,
deliberately human-inspectable. Credential and connection files are **sealed**
with the account's file key: `vxe` (`:68818`) writes `Axe(r, t, {mode: 384})`
when no key is present, otherwise `Txe(r, Ywe(n, JSON.stringify(t)), 384)`.
`384` is `0o600`. The file key is 32 random bytes (`V1 = 32`,
`main-core.beauty.js:28855`) held in the OS secret store under the literal
`"sand-local-exec-file-key"` (`:28854`, `:29731`) and handed to the daemon in
the fork message as `{key, computerId}` (`local-exec-daemon.beauty.js:143263`,
`:143270`). Sealed files use `aes-256-gcm`, a 12-byte nonce, and the marker
`"sandSealedFile": 1` (`H1`, `main-core.beauty.js:28858`, `:28868`). **PROVEN.**

### 2.7 Credential minting and connection handoff

The credential is **backend-minted**, not a local secret. The coordinator calls
`mintLocalExecDaemonCredential` (`main-app.beauty.js:84464`) → desktop executor
`main-app.beauty.js:83013` → `issueLocalExecDaemonCredential`, which POSTs to
the literal path `/sand-box/local-exec-daemon-credential`
(`main-app.beauty.js:78084`). Two issuance strategies exist (`:78241`, `:78372`),
the second keyed on a `userComputer` mint. **PROVEN** that the endpoint and the
mint flow exist; **UNKNOWN** which is used in the shipped app — the choice
depends on a `skipUserComputerMint` flag the supervisor sets
(`node-agent-coordinator.beauty.js:39170`), which depends on runtime state.

The credential carries an `accountScope` (1–128 chars,
`main-core.beauty.js:28834`) and a **`serverAuthoritative` boolean**
(`:28835`). `serverAuthoritative` is the flag that changes the permission
ladder — see §3.3. **PROVEN.**

To turn the credential into a usable connection the daemon POSTs to
`/sand-box/local-exec-connection` (`Dar`, `local-exec-daemon.beauty.js:136450`,
request at `:136459`) and gets `{baseUrl, token?, networkToken?}`; the network
token travels as `x-anyrun-network-token` (`cxe`, `:68434`). The result is
sealed into the connection file. **PROVEN.**

### 2.8 The account retire marker

`local-exec-account-retire.json` holds `{retiredAt: <epoch ms>}`
(`Y1`, `main-core.beauty.js:28927`). Its **existence**, not its contents, is
what matters.

**The spawner refuses.** `jB` checks twice and throws
`SandLocalExecSpawnRetiredError` (class `name` literal, `main-core.beauty.js:29876`)
with `"local-exec daemon spawn refused: the account retire marker stands"`
(`:30068`, and again inside the critical section at `:30077` — the spawn is a
queued critical section `wB` (`:29882`), and the marker can appear while
waiting). **PROVEN.**

**Account-change retirement** (`KB`, exported as
`retireLocalExecDaemonForAccountChange`, `main-core.beauty.js:30109`–`:30142`)
does, in one serialised section:

1. bump `local-exec-account-generation.json` by one (`:30125`);
2. write the retire marker (`:30127`);
3. terminate the discovered daemon, identity-checked (`:30128`–`:30131`);
4. terminate **every pid in `zi`** that passes the identity check
   (`:30132`–`:30134`);
5. delete discovery, credential and connection files (`:30135`–`:30137`).

Any failure raises
`AggregateError(n, "local-exec daemon account retire incomplete")` (`:30140`).
**PROVEN.** Design intent **INFERRED**: no artifact of account A's execution
state may be observable by account B.

The **supervisor** consumes the marker on its next `start()`
(`node-agent-coordinator.beauty.js:39440`); the daemon process never reads that
file. **PROVEN.**

**Account generation** is a monotonic counter with a strict parser that throws
`TypeError` on anything that is not a non-negative integer (`Qie`,
`main-core.beauty.js:28916`); a damaged file becomes generation `0` plus a
`"account_generation_damaged"` give-up reason
(`node-agent-coordinator.beauty.js:39447`). The value is published as
`SAND_LOCAL_EXEC_GENERATION` and echoed into the discovery record; the
supervisor's replace policy compares it (`DG`, `:38986`) so a daemon with the
wrong generation is `{kind:"replace"}`, not `{kind:"adopt"}` (`Nz`, `:38989`).
**PROVEN.**

### 2.9 The refresh loop

Constants (`node-agent-coordinator.beauty.js:38975`–`:38979`):

| Name | Value | Meaning (INFERRED from use) |
|---|---|---|
| `vG` | `3e4` (30 s) | refresh interval; the timer name is `"local-exec-daemon-refresh"` |
| `bz` | `4 * vG` (2 min) | wider stall bound |
| `eC` | `10` | **respawn / replace attempt limit** |
| `kz` | `5 * 6e4` (5 min) | credential refresh lead time |
| `Oz` | `15e3` (15 s) | shorter bound used in credential scheduling |

Each tick (`le`, `:39377`–`:39440`): if the refresh policy is stopped, return;
if the phase is `absent`, reset counters and spawn; otherwise probe. A
`"stopped"` serving mark increments the counter, and at `>= eC` the phase
becomes `"failed"` with reason `"respawn limit reached"` and give-up reason
**`respawn_limit`** (`:39397`; literal list at `:34687`). A serving daemon whose
`filesKeyId`/`generation` mismatch does the same with
**`files_key_replace_limit`** (`:39414`). `"stale-busy"` is a real state: a
daemon with `inflightCount > 0` and a stale serving mark is deliberately **not**
replaced while busy, for a grace window tracked in `D`. **PROVEN** for the
logic; **UNKNOWN** for the exact grace value (a variable, `jx`, not a literal I
could resolve).

Give-up is reported once via
`reportLocalExecSupervisorFailed: I().args({reason: <one of the two literals>})`
(`main-app.beauty.js:84503`, `Jrn` at `:84458`), landing at
`main-app.beauty.js:83109`.

**Pause policy** (`node-agent-coordinator.beauty.js:38999`–`:39004`):

| Reason | daemon | box credential | refresh |
|---|---|---|---|
| `client-pause` | **retired** | kept | stopped |
| `away-park` | kept | withheld | stopped |
| `present-park` | kept | withheld | describes |
| busy override | kept-while-busy | withheld | stopped |

**PROVEN.** Note the asymmetry: only `client-pause` retires the daemon; both
park reasons keep it running but withhold the credential, so it stays alive and
cannot dial.

### 2.10 Restart, crash, quit, ownership loss

Five independent exit paths.

**(1) SIGTERM / SIGINT** — handled, logged, 2 s graceful shutdown
(`local-exec-daemon.beauty.js:143313`–`:143314`). **PROVEN.**

**(2) Ownership loss.** The daemon polls every `eW = 1e4` ms
(`be = t.ownershipPolicy ?? ru({name: "local-exec-daemon-ownership", intervalMs: eW})`,
`local-exec-daemon.beauty.js:136697`; `eW = 1e4` at `:67942`). Each tick folds
four inputs into `uxe` (`:68440`):

| Input | Source |
|---|---|
| `heartbeat` | `local-exec-supervisor.json` → `{pid, at}` (`iQ`, `:68831`; writer `bG`, coordinator `:38946`) |
| `lease` | `local-exec-update-lease.json` → `{until}` (`kxe`, `:68822`) |
| `inflightCount` | this daemon's own count |
| `supersededForMs` | how long the discovery record has named *another* live pid (`zX`, `:68435`) |

`uxe` returns `"exit"` when: superseded and no inflight work **or** superseded
longer than `S6e = 12e4` ms; **or** the supervisor heartbeat is older than
`t5 = 9e4` ms and none of the tolerances apply (a 30 s post-clock-jump
tolerance `wt`, a live update lease, or inflight work inside the 120 s grace).
On `"exit"` it calls
`t.onOwnershipLost(T === void 0 ? "unsupervised" : "superseded")`
(`:136761`), logging one of exactly two strings (`:143309`–`:143310`):
`"superseded by the daemon the discovery record names"` or
`"desktop ownership lost"`. **PROVEN.** Constants: `t5 = 9e4` (`:67941`),
`S6e = 12e4` (`:67943`), `w0t = 6 * tW = 12e3` (`:67944`),
`y6e = 3 * eW = 3e4` (`:67945`).

**(3) Fatal bootstrap error** — logs `[sand-local-exec-daemon] fatal: <err>`
and exits 1 (`:143316`–`:143320`). **PROVEN.**

**(4) Supervisor kill.** `Xi(pid, check)` sends `SIGTERM`, waits up to 4 s
(`FB`, 40 × 100 ms, `main-core.beauty.js:29977`), then `SIGKILL` (`NR`,
`:30100`), only if the identity check passes. **PROVEN.**

**(5) App quit.** `main-app.beauty.js:109391` calls `killLocalExecDaemon()` in
`before-quit`, i.e. `$B` (`main-core.beauty.js:30096`): read discovery → if
alive **and** identity-checked → `Xi`. **PROVEN.** The one exception: when a
relaunch-for-update is in progress, main writes an update lease instead
(`main-app.beauty.js:109330`; `writeLocalExecUpdateLease` = `X1`,
`main-core.beauty.js:28961`) with a TTL of `M1 = 15 * 6e4` = **15 minutes**
(`:28776`), and the daemon survives the restart because `uxe` treats a live
lease as `"keep"`. **PROVEN.**

**Crash handling.** stdout/stderr are piped to a log file (`nce`,
`main-core.beauty.js:29865`; line-splitting parser `tce`, `:29852`) and each
`"exit"` is reported as a `local-exec` lifecycle event with `phase: "exited"`,
an exit-code *class* (`zero`/`nonzero`/`signal`) and a signal name from a
14-entry allow-list (`vR`, `:29774`; `Xse`, `:29784`). There is **no separate
crash handler and no core-dump inspection**: recovery is entirely the
supervisor's next 30 s tick. **PROVEN — and this is a notable absence.** A
daemon that crashes ten times a second is re-spawned at most once per tick,
capped at 10 attempts.

### 2.11 Transport

Every line reference in this table is `local-exec-daemon.beauty.js`.

| Leg | Direction | Mechanism |
|---|---|---|
| bootstrap handoff | main → daemon | Node IPC `{key, computerId}` on the fork/spawn channel, then disconnect (`local-exec-daemon.beauty.js:143297`–`:143301`) |
| request stream | daemon ← gateway | `GET {baseUrl}/local-exec/requests`, SSE (`:111759`) |
| results | daemon → gateway | `POST {baseUrl}/local-exec/responses` (`:83660`) |
| heartbeats | daemon → gateway | periodic `{kind:"ping", supervised}` frames (`:111870`) |
| cancellation | gateway → daemon | `{kind:"cancel", requestId}` on the stream → `handleCancel` (`:110843`, `:111046`) |
| Messages | daemon ↔ Messages worker | `worker_threads` `postMessage` (`:110753`, `:110778`) |
| computer use | daemon ↔ CUCursorService | newline-delimited JSON over a Unix socket from `service.json` (`:104266`, `:104292`) |

The first frame is a `hello` carrying `localRoot`, `terminalsFolder`,
`computerId`, `label`, `supervised`, `variant` and `capabilities`
(`messagesOp`, `messagesOpGeneration: 2` — `wS`, `:83482`; `aiToolSetup`,
`mobileLocalTools`, `localStandingGrants`, `localToolAppConsent`,
`localToolGrantSeen`) at `:111770`–`:111780`. **PROVEN** — this is where a
reimplementation should look for the negotiated feature set.

---

## 3. The permission model

The shape of the answer, stated bluntly: **there is no ordered allow/deny rule
list that decides whether a tool may run.** There is a fixed decision ladder
(§3.3) plus one genuinely rule-shaped mechanism — an administrator **command
denylist** with glob/prefix/prefix-pair semantics (§3.6) that can only ever
*deny*.

### 3.1 Three gates, and where each lives

| Gate | Lives in | Decides | Evidence |
|---|---|---|---|
| **G1 — command denylist** | the exec daemon | may this *command string* execute at all? | `local-exec-daemon.beauty.js:91444` |
| **G2 — sandbox policy** | the exec daemon, but *chosen by the caller* | how is it confined once allowed? | `:93810`, `:32146` |
| **G3 — local-tool permission + approvals** | the daemon hosts it, the **user** resolves it | may this *tool* touch the user's computer? | `:69310`, `:69331` |

G1 and G2 apply to shell execution; G3 applies to the `local-tool` frame family
(upload/download, Messages, computer use, AI-tool discovery — §5.6). They are
**different systems with different state**. A reviewer who reads only G3 would
wrongly conclude that shell commands are approval-gated.

### 3.2 The action vocabulary

Ten action identifiers (`bxt`, `local-exec-daemon.beauty.js:68884`–`:68893`):
`run-command`, `send-input`, `read-file`, `list-directory`, `write-file`,
`read-ai-tool-setup`, `read-messages`, `send-imessage`, `run-phone-tool`,
`use-app`. **PROVEN.**

Each has a **scope** (`Txt`, `:68896`–`:68907`), returned by `FA(action)`
(`:68908`), which falls back to `"subject"` for anything unrecognised:

| Action | Scope |
|---|---|
| `run-command`, `send-input`, `read-file`, `list-directory`, `write-file`, `read-ai-tool-setup` | `global` |
| `read-messages` | **`setting`** |
| `send-imessage`, `use-app` | **`subject`** |
| `run-phone-tool` | `call` |

**PROVEN.** Note `"call"` is a scope value with **no handler anywhere in the
decision function**: `run-phone-tool` therefore falls through to the
approval-or-ask tail. **UNKNOWN** whether that is a bug or an intentional
"always ask" default; the code does not say.

### 3.3 The decision ladder

`qQ`, `local-exec-daemon.beauty.js:69310`–`:69330`, written as the actual
evaluation order:

| # | Condition | Result |
|---|---|---|
| 1 | `serverAuthoritative === true` **and** `authorization.kind === "approval"` | **allow** |
| 2 | `serverAuthoritative === true` **and** `authorization.kind === "standing"` **and** scope is `global` | **allow** |
| 3 | `serverAuthoritative !== true` **and** `ceiling === "never"` | **refuse** (`tv`) |
| 4 | `serverAuthoritative !== true` **and** `permission === "always"` **and** scope is `global` | **allow** |
| 5 | `serverAuthoritative !== true` **and** `permission === "never"` **and** scope ≠ `global` | **refuse** (`tv`) |
| 6 | scope is `setting` | allow iff `messagesEnabled`, else **refuse** (`uTe`) |
| 7 | scope is `subject` **and** `describes` present **and** a matching **standing grant** exists | **allow** |
| 8 | no `approvalId`, or no `describes` | **ask** (`iv`) |
| 9 | approval found (after retirements), account-scope matches when server-authoritative, and it matches `machineId` + (`action`,`target`) or the resource path | **allow** |
| 10 | otherwise | **ask** (`iv`) |

`i6 = {kind:"allow"}`, `iv = {kind:"ask"}`, `JQ(reason) = {kind:"refused", reason}`
(`local-exec-daemon.beauty.js:69304`–`:69308`). **PROVEN.**

**Precedence, stated plainly:**

1. **A `serverAuthoritative` authorization outranks every local setting.**
   Steps 1–2 run *before* the ceiling check at step 3, and step 3 is in the
   `else` branch. A server-stamped `approval` is therefore allowed even when
   the local `ceiling` is `"never"`. **PROVEN by the branch structure.** This is
   the single most important precedence fact in the subsystem.
2. **The ceiling is a hard cap, not a default.** `$A(t, e)` (`:68921`) is
   `e === undefined || Nxe[t] <= Nxe[e] ? t : e` with
   `Nxe = {never: 0, ask: 1, always: 2}` (`:68920`). So
   `effective = min(permission, ceiling)` in that ordering: a ceiling of `"ask"`
   clamps `"always"` down to `"ask"`; `"never"` clamps everything to `"never"`.
   **PROVEN.** `getLocalToolPermission()` applies it (`:70265`–`:70267`), and so
   does the per-machine override (`:70305`–`:70309`).
3. **Deny beats allow for the two hard controls** — ceiling `never`, and
   `messagesEnabled === false` for the Messages actions. Neither can be
   overridden by a standing grant: the standing-grant check is gated by `Lxe`
   (`:68912`–`:68916`), which returns `false` when
   `ceiling !== undefined && ceiling !== "always"`, or `permission === "never"`,
   or the action is in `Axt = ["read-messages","send-imessage"]` (`:68911`) and
   `messagesEnabled` is false. **PROVEN.**
4. **Allow beats ask only when a grant exists** — standing grants (step 7) are
   checked before the ask tail. **PROVEN.**

**What is NOT proven.** The ladder is a per-request function, not a set of
rules evaluated against a request. There is **no** "first matching rule wins"
or "last matching rule wins" semantics for allow/deny in this subsystem, and I
could not find one. The one ordered list that exists is the command denylist,
where order affects only *which rule name appears in the error message* —
because any match blocks (§3.6).

### 3.4 Standing grants

File: `<dataRoot>/local-tool-standing-grants.v1.json` (`oxe`,
`local-exec-daemon.beauty.js:68404`). Schema `{version: 1, grants: [...]}`
(`Fxe`, `:68986`); version literal `vxt = 1` (`:68924`).

| Scope | Key (JSON-stringified array) | Meaning |
|---|---|---|
| `action` | `[accountScope, "action", action]` | always allow this action for this account |
| `subject` | `[accountScope, "subject", action, recipient]` | always allow this action toward this recipient |

`Bxe`. **PROVEN.** Validation is strict (`kxt`): a grant is dropped unless
`scope ∈ {"subject","action"}`, the action is a known action id, **and**
`FA(action) === "subject"`. So **standing grants exist only for subject-scoped
actions** — in practice `send-imessage` and `use-app`. `global` actions can
never have one; `read-messages` (scope `setting`) cannot either. **PROVEN.**

`recipient` must be non-empty, at most `Rxt = 320` characters (`:68925`), and
must not contain `\n` or `\r` (`Dxe`/`Cxt`, `:68927`–`:68945`); `recipientName`
uses the same check without the newline rule. **PROVEN** — a real
header-injection-shaped guard.

Lookup (`Qbt`, `:69297`–`:69309`): a grant can only allow when the request
carries **no approval id** (`STe(t)` is `approvalId != null && length > 0`),
`accountScope` is present, and `Lxe` passes. Action scope is tried before
subject scope. **PROVEN.**

### 3.5 Approvals and retirements

Files: `<dataRoot>/local-tool-approvals.json` (`ixe`, `:68398`) and
`<dataRoot>/local-tool-retirements.json` (`sxe`, `:68401`). An approval record
is `{id, action, target, resourcePath?, accountScope?}` (`Ybt`, `:69217`–
`:69231`) and is accepted only if `id` is a non-empty string, the action is
known, and `target` is a string. **PROVEN.**

Matching (`dTe`, `:69179`) requires `approval.machineId === describes.machineId`
**and** either exact `(action, target)` equality, or both the approval's
`resourcePath` and the request's `attachToResourcePath` normalising to the same
non-empty path (backslashes → forward slashes, `aTe`, `:69133`). For
`run-command` the request's `resourcePath` becomes the `terminalsFolder`
(`:69327`), so a command approval binds to the machine and to the
terminal-command target, not to a path. **PROVEN.**

Retirement is a tombstone set: `_Te` (`:69256`–`:69270`) adds an id to
`retiredIds` and prunes ids that no longer appear in the approvals file,
deleting the retirements file when the set empties. Lookup is `Zbt` (`:69271`)
= approvals minus retirements. **PROVEN.** The message the model sees when a
retired approval is re-requested is explicit that a later permission change
does not resurrect it:

> "The user was already asked about this exact action on their computer and did
> not approve it, so it will not run and will not be asked again for this task
> — a later permission change does not authorize it. Do not retry it. …"
> — `local-exec-daemon.beauty.js:69131`

### 3.6 The administrator command denylist — rule shape

The only rule-list in the subsystem, and it is **deny-only**.

**Where the rules come from.** Per request, on the wire:
`ShellArgs.admin_command_denylist` (field 22, `local-exec-daemon.beauty.js:74460`),
`BackgroundShellSpawnArgs.admin_command_denylist` (field 14, `:77960`), and
`RequestContext.admin_command_denylist` (field 52, `:77069`/`:77071`). **They
are not read from a local file.** **PROVEN.** On the desktop they come from the
app's feature-gate table — the flat `{client: !0, default: <bool>}` map that
`checkFeatureGate` reads; the app ships `@statsig/js-client`, so Statsig is the
provider, but that attribution is **INFERRED** while the literal keys and
defaults are **PROVEN**. Both default to false:
`admin_command_denylist: {client: !0, default: !1}` and
`admin_command_denylist_enforcement_killswitch: {client: !0, default: !1}`
(`main-app.beauty.js:48795`, `:48797`). **INFERRED**: since the killswitch gate
exists but no code path in the daemon bundle reads it, enforcement is decided
upstream and the daemon obeys whichever list arrives.

Every line reference in this table is `local-exec-daemon.beauty.js`.

| Aspect | Rule | Evidence |
|---|---|---|
| Syntax | `executablePattern` **or** `executablePattern:argsPattern` | `z9`, `:2821` |
| Colon rule | split at the **first** `:`; requires index > 0; executable part must contain no whitespace | `z9`, `:2822` |
| Wildcard | `*` only; `a5` escapes all regex metacharacters, replaces `*` with `.*`, anchors `^…$` | `a5`, `:3241` |
| Non-wildcard match | exact equality **or** prefix-with-space: `e === t \|\| e.startsWith(t + " ")` | `_Mt`, `:91431` |
| Length limit | 512 characters, after whitespace normalisation | `fW`, `:2807` |
| Rejected rules | empty; all-wildcard (`*`, `**`, …); starting with `:`; all-wildcard executable with empty or all-wildcard args | `fW`, `:2804`; `dW`, `:2818` |
| Whitespace normalisation | runs of any whitespace — including `\u00A0`, `\u200B`, `\u200C`, `\u200D`, `\uFEFF` — collapse to one space | `zh` `:2792`, `emt` `:2770` |

**Matched against** (`yMe`, `:91312`): the deduplicated set
`{raw command, …each parsed executable command's fullText}`. The parsed forms
come from tree-sitter (§8). **PROVEN.** Three normalisations are tried per
candidate (`EMe`, `:91419`): raw-trimmed, whitespace-normalised, and
`gMt(cmd)` — a decoder for shell quoting and ANSI-C escapes handling `$'…'`,
`$"…"`, `'…'`, `"…"`, backslash escapes, `\xHH`, `\uHHHH`, `\UHHHHHHHH` and
octal (`gMt`, `:91330`–`:91415`). **PROVEN.** The effect **INFERRED** is that
`r\m -rf /` cannot slip past a rule written for `rm -rf /`.

**Validation is fail-closed in a way that is easy to misread.** `EMe`:

```js
return r.length === 0 ? !1 : fW(r) !== null ? !0 : …some(match…);
```

`fW` returns an **error string** for an invalid rule and `null` for a valid one.
So `fW(r) !== null` → **`true`** → **an invalid rule matches every command**. A
malformed entry in the administrator's list therefore blocks everything, not
nothing. **PROVEN as behaviour**, **INFERRED as intent** (fail-closed). This is
the kind of thing a reimplementation gets backwards if it copies the shape
without reading the polarity.

**Fail-closed on unparsable input.** `_I` (`:91444`–`:91449`):

```js
if (r.length === 0) return;                                    // no rules → no block
if (e.parsingFailed || e.executableCommands.length === 0) return mMt;   // BLOCK
let n = Ece({ matchForms: …, blockedCommands: r });
return n === void 0 ? void 0 : Kg(n);                          // undefined → allow
```

`mMt` (`:91311`):

> "Denied: this command could not be conclusively analyzed against your team's
> administrator command denylist, so it was blocked (fail-closed) and was not
> executed. It cannot be approved from this conversation; only a user can run
> it manually outside the agent. You may continue working on the task."

**PROVEN.** Note the asymmetry: with **no** rules an unparsable command runs;
with **any** rules it is blocked. And `parsingFailed` is exactly the state the
daemon enters when the tree-sitter natives are unavailable (§8) — so on a build
without the natives, **any** non-empty denylist blocks every command. Coherent
fail-closed design, but worth stating explicitly.

The per-rule denial message (`Kg`, `:91442`):

> "Denied: this command was blocked by administrator policy (denylist rule:
> `<rule>`) and was not executed. It cannot be approved from this conversation;
> only a user can run it manually outside the agent. You may continue working
> on the task."

**First match wins, but only for the rule name.** `Ece` (`:91434`) iterates
`blockedCommands` **in order** and returns the first rule matching any match
form. Since the return value only names the rule in the message, order changes
the explanation, not the outcome. **PROVEN.**

**Where it is enforced** — two sites, both *before* any approval gate:
streaming shell at `local-exec-daemon.beauty.js:93814`, background shell spawn
at `:109870`, each returning a rejection. **PROVEN.** An administrator denial
is terminal and, per the message, **cannot be approved from the conversation**.

### 3.7 Where the allow side lives (not in the daemon)

An allow side exists, but not here. `PermissionsAutoRunInstructions
{allow_instructions, block_instructions}` (`local-exec-daemon.beauty.js:76980`)
is a field of `RequestContext` (fields 46–48: `user_permissions_auto_run`,
`project_permissions_auto_run`, `admin_permissions_auto_run`, `:77069`). The
same three-tier structure appears in desktop settings as
`autoReviewInstructions {isEnabled, allowInstructions, blockInstructions}`
(schema `pTt`, `:69624`; accessor `getAutoReviewInstructions`, `:70234`), with
each instruction sanitised to at most 1000 characters and at most 20 entries
(`rTt` `:69348`, `wTe` `:69352`).

**PROVEN** for the shapes and storage. **UNKNOWN** for the matcher: the ordered
matcher `_Mt`/`EMe` I found is reachable only from the denylist path inside the
exec daemon (`grep` for `EMe(`, `Ece(`, `fW(`, `_Mt(` across all four bundles
returns the daemon definitions and no other consumer of an allow-instruction
list). **I therefore cannot state the precedence of `allowInstructions` against
`blockInstructions`, and I will not guess.** An auto-review decision engine
exists somewhere in the renderer (no readable source in this recon) or on the
backend.

### 3.8 The local-tool permission setting

Every line reference in this subsection is `local-exec-daemon.beauty.js`.
Stored in the daemon's own settings file, `settings.json` under the data root
(`Uar`, `:136481`; path helper `us`, `:68387`). Fields in `GTe`
(`:69637`–`:69645`):

| Field | Type | Default | Notes |
|---|---|---|---|
| `localToolPermission` | `"always" \| "ask" \| "never"` | `"ask"` on read (`:70266`) | `UA` |
| `localToolPermissionCeiling` | same enum | `undefined` | clamps the above |
| `localToolPermissionByMachineId` | record<string, enum> | `{}` (`:69679`) | per-remote-machine override, also clamped |

**PROVEN.** The user-facing string for `"never"` names the UI location and the
affected tools (`tv`, `:69122`):

> `Local tools are turned off. The user has set local tool access to "Never", so
> <Shell>, <Read>, and <AwaitShell> with machineId, plus <CopyToBox> and
> <CopyFromBox>, cannot run on their computer. … ask the user to change the
> setting in Settings → Bot → Execution on Local Computer.`

`messagesEnabled` (default `false`, `:69671`) is a separate boolean that gates
`read-messages` and `send-imessage` outright (consumed in `Lxe`, `:68913`).
**PROVEN.**

**Who calls what.** The daemon exposes two hooks to its frame handlers:
`isLocalUseBlocked(...)` → `yTe` (`:69331`) → a **refusal string** or
`undefined`; and `decideLocalUse(...)` → `qQ` (`:69310`) → a **decision
object**. Both are wrapped with a request-local settings snapshot `ie(...)`
(`:136586`–`:136594`):

```js
permission: L.getLocalToolPermission(),
ceiling: L.getLocalToolPermissionCeiling(),
messagesEnabled: L.getMessagesEnabled(),
approvalsPath: N, retirementsPath: k, standingGrantsPath: D,
accountScope: je, serverAuthoritative: et,
```

`et` is owned by the account's `userComputer` descriptor and can be forced true
by the backend. **PROVEN** — this is the mechanism by which a server-stamped
authorization bypasses local settings.

### 3.9 What the exec daemon does **not** gate — and why it matters

`iZe(root, maxFileBytes)` (`local-exec-daemon.beauty.js:110705`) constructs the
executor graph, and its first two locals are the defaults:

```js
let r = new Z8(),   // permissions service
    n = new Y8(),   // ignore service
```

`Z8` (`:110579`–`:110632`) is a **no-op**: `shouldBlockShellCommand` returns
`{kind:"allow", policy: i ?? {type:"insecure_none"}}`;
`shouldEnforceShellInvariantBlocks` returns `{kind:"allow"}`;
`isShellCommandFullyAllowlisted`, `isMcpFullyAllowlisted`,
`isWebFetchFullyAllowlisted` all return `false`; `shouldBlockRead` /
`shouldBlockWrite` return `false`; `addToAllowList` / `addToDenyList` are
no-ops. `Y8` (`:110553`–`:110576`) returns `false` for `isCursorIgnored`,
`isGitIgnored`, `isIgnoredByAny` and `isRepoBlocked`, and `{}` for both ignore
mappings. **PROVEN.**

The daemon never installs a different one: the only other construction site,
`local-exec-daemon.beauty.js:111622`, builds `B4` with `root`, `computerId`,
`computerLabel`, `maxFileBytes`, `messages`, `isLocalUseBlocked`,
`onApprovalRetired`, `onInflightChange`, `aiToolConfigDirs` — **no
`permissionsService`** — and `iZe` hard-codes `new Z8()`. **PROVEN.**

Consequences, stated carefully:

- The **approval gate exists in the code path** but is driven by the *caller's*
  `skipApproval` flag. With `skipApproval` truthy the daemon calls
  `shouldEnforceShellInvariantBlocks` (no-op → allow); with it falsy it calls
  `shouldBlockShellCommand` (no-op → allow, carrying the requested policy
  through). **PROVEN.**
- Therefore, on this build, **a shell command that reaches the daemon and
  carries no `requested_sandbox_policy` executes.** Only the administrator
  denylist, a sandbox policy that cannot be honoured (§4.6), or a
  transport/credential failure upstream can stop it. **PROVEN by construction
  from the literals above.**
- The block-reason vocabulary (`ly`, `:92818`–`:92839`; `Fce`, `:92860`) shows
  what a *configured* build would gate on: `cursorIgnore`, `permissionsConfig`,
  `cursorFiles`, `adminBlock`, `adminCommandDenylist`, `unsafeResolution`,
  `userRejected`, `needsApproval`. Those reasons exist and map to messages; the
  producer is the pluggable `permissionsService` this build sets to no-op.
  **PROVEN for the mapping; UNKNOWN whether any non-desktop variant installs a
  real one** — the box-side build of the same source is not in this asar.

This is the finding I would put in front of a security reviewer first.

---

## 4. Sandboxing

### 4.1 It is a helper binary, not `sandbox-exec`

`grep` over the whole 5 MB bundle for `sandbox-exec`, `seatbelt`, `sandbox_init`,
`libsandbox`, `bwrap`, `bubblewrap`, `unshare`, `nsjail` and `firejail` returns
**zero** executable hits. **PROVEN negative result.**

Instead the sandbox is a **separate binary** invoked as a wrapper
(`iOe`/`iOt`, `local-exec-daemon.beauty.js:32689`, `:32699`–`:32742`):

```
<sandboxBinary> --policy <policyFile> [--preflight-only] -- <command> <args...>
```

Argument vector at `:32716`; spawn at `:32737`; preflight is
`["--policy", …, "--preflight-only", "--", "/bin/true"]` with a 15 s timeout
(`rOt`, `:32667`; `tOt = 15e3`, `:32825`). **PROVEN.**

**The binary path is never set in this artifact.** `Mae()` (`:32516`) returns
the module-level `Vkt`, and `Vkt` is **declared but never assigned** anywhere in
the file — the only two occurrences are the declaration in the exports list
(`:32800`) and the read at `:32517`; `grep -n "Vkt = \|Vkt="` returns nothing.
**PROVEN.** Consequently `rOe` (`:32603`) reports
`"Sandbox binary path was not configured"` and `nOe` (`:32625`) returns `false`.

**No sandbox helper ships.** `dist/native/` contains exactly `sand-op-launcher`
and `sand-webauthn-signer`; a case-insensitive `find` for `*sandbox*` under
`dist/` returns nothing. `deps/runtime-deps-manifest.json` lists only
`cursor-proclist`, `sand-notification-settings`, `tree-sitter` and
`tree-sitter-bash` as required. The `sandbox_helper` string in
`main-core.beauty.js:14850` is **unrelated** — it is Electron's own
utility-process type list, next to `gpu`, `zygote`, `pepper_plugin`, `network`.
**PROVEN.**

### 4.2 Policy types

`Ic` (`local-exec-daemon.beauty.js:91230`–`:91295`) maps the protobuf enum to
three runtime policy types: **`insecure_none`** (`INSECURE_NONE`,
`UNSPECIFIED`, unknown — no sandbox), **`workspace_readwrite`**, and
**`workspace_readonly`**. **PROVEN.** `Eo(workspace, undefined)` returns
`{policy: {type: "insecure_none"}}` (`:32146`–`:32147`) — so **the default for
a shell command with no requested policy is "no sandbox"**. The daemon does not
choose a safe default; the caller does.

### 4.3 The policy file

`Oae` (`:32483`) writes the policy JSON to a fresh file and returns the path:
directory `$CURSOR_SANDBOX_POLICY_DIR` if set, else `~/.cursor/sandbox-policies`
(`$kt`, `:32452`; `Fkt`, `:32505`); the directory is created mode `0o700` and
re-`chmod`ed if it already existed (`kae`, `:32474`); the file is
`sandbox-policy-<8 random bytes hex>` (`:32486`) written mode `0o600` (`:32487`);
stale files older than `Jkt = 3600 * 1e3` are pruned at most once per
`qkt = 900 * 1e3` (`Gkt`, `:32458`). **PROVEN.**

### 4.4 The policy JSON

Built by `tOe` (`:32560`) with fields at `:32565`–`:32584`: `cwd`,
`readBoundary` (`workspace`/`system`, `Nke` `:31791`), `hardcodedReadPaths`
(`Zkt`, `:32529`), `additionalReadonlyPaths` (normalised and realpath-resolved,
`oOt` `:32756` / `sOe` `:32767`), `additionalReadwritePaths` (from the policy
plus the repo's git-common-dir when the workspace is a worktree — `Eo`,
`:32159`–`:32177`), `additionalReadPaths` (only when
`readBoundary === "workspace"`, `SMe` `:91218`), `networkAccess` (`hd`,
`:32030`), `disableTmpWrite`, `ignoreMapping`. Outside the sandbox object,
`iOt` adds `networkPolicy` and, when `networkPolicyStrict === false`,
`networkPolicyStrict: false` (`:32713`–`:32715`). **PROVEN** for the field names
and provenance; **UNKNOWN** for the contents of `hardcodedReadPaths` — `NS(...)`
is a large platform table I did not resolve, and it is not load-bearing for the
*interface* of a reimplementation.

### 4.5 Network policy

A separate small schema (`x6`, `:73927`–`:73945`):
`{version, default_action: ALLOW|DENY, deny[], allow[], logging}`, JSON form
`{version, default, deny?, allow?, logging?}` (`lMt`, `:91149`). **PROVEN.**

The daemon's *own* policy, used when an internal force-egress feature is on, is
built by `cMt` (`:91105`) and is unusually explicit: `default` is
`CURSOR_FORCED_SHELL_EGRESS_NETWORK_DEFAULT` with **`"deny"` on any invalid
value**; `allow` **always** includes `["127.0.0.0/8", "::1/128", "localhost"]`
plus `CURSOR_FORCED_SHELL_EGRESS_ALLOW_DOMAINS`; `deny` is
`…_DENY_DOMAINS`; `networkPolicyStrict: true`. **PROVEN** (`:91105`–`:91120`).

The feature is off unless `CURSOR_FORCED_SHELL_EGRESS` is set to something
other than empty/`0`/`false`/`off` (`Vg`, `:91039`). When on,
`Wg(command, parsingResult)` (`:91135`–`:91152`) decides whether the command may
keep the permissive policy:

1. start from `cMt()` (deny-by-default);
2. if no dependency regexes are configured (`oMt()` returns `null`), keep it;
3. if parsing failed, there are no executable commands, or the raw command
   contains `$(`, a backtick, `<(` or `>(` (`rMt`, `:91032`), keep it;
4. if any executable command matches the source regexes (`aMt`) or contains
   `;`, `&` or `|` (`nMt`, `:91033`), keep it;
5. **only if every** executable command matches the dependency regexes, switch
   to `uMt()` — `default: "allow"`.

**PROVEN.** The regexes come from
`CURSOR_FORCED_SHELL_EGRESS_DEPENDENCY_REGEX`, `…_EXTRA_DEPENDENCY_REGEX`,
`…_SOURCE_REGEX`, `…_EXTRA_SOURCE_REGEX` (`:91023`–`:91026`), joined with `|`,
and the dependency set is anchored to the start of the executable with an
env-assignment prefix allowance
(`iMt = "(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s]*\\s+)*"`, `:91034`). Invalid regexes
throw at parse (`fMe`, `:91046`). **PROVEN.** This is internal/enterprise
configuration read from the process environment, not a user setting; it is off
in a default install.

### 4.6 Fail-closed: a requested policy that cannot be honoured

`gd` (`:32827`–`:32842`): if the policy type is not `insecure_none` and the
helper is unavailable, it **throws** — it does not silently downgrade:

> `Sandbox policy '<type>' is not supported on this system. Ensure the sandbox
> helper binary is available, or use 'insecure_none'. Reason: <reason>`
> — `local-exec-daemon.beauty.js:32836`

**PROVEN.** The error surfaces as a distinct result case:
`ShellSandboxUnsupported` (`od`, descriptor at `:74684`) and, on the
background-shell path, `BackgroundShellSpawnResult.sandbox_unsupported`
(`:77988`). **PROVEN.**

So on the packaged macOS desktop, where `Vkt` is unset: a caller that requests
`workspace_readwrite` gets a refusal; a caller that requests nothing gets
`insecure_none` and the command runs unconfined. **This is the whole sandboxing
story for this artifact.**

### 4.7 macOS specifics, entitlements, privileges

The only macOS-specific sandbox-adjacent behaviour found is a refusal to
`chmod` a temp directory the daemon does not own: `ekt(t, uid)` requires a
directory owned by the current uid with mode bits `0o022` clear
(`(r.mode & 18) === 0`, `:31513`). **PROVEN.**

`grep` for `codesign`, `SecStaticCode`, `csops`, `entitlement`, `AMFI`,
`task_for_pid` across the daemon bundle returns nothing relevant. **PROVEN
negative result: there is no codesign or entitlement verification inside the
daemon.** It does not verify that *it* is signed and it does not verify
anything it spawns. Should the helper binary ever exist, its own entitlements
are **UNKNOWN** — the binary is not in the asar, so there is nothing to inspect.

---

## 5. Tool surface

### 5.1 How the surface is declared

The daemon registers **executors** against a service-token string, each with an
args message and a result message. The token table is a plain object literal
(`st`, `local-exec-daemon.beauty.js:84446`–`:84520`), e.g.
`computerUseExecutor: "computer-use-executor"` (`:84451`). Registration is
`ot(st.<token>, t => new lt(t, dt("xArgs"), ft("xResult")), …)`
(`ot` at `:84493`; computer use at `:84596`). **PROVEN.** The bundle is minified;
these string literals are the wire identifiers.

**Terminology note.** `computer-use-executor` is the *executor service token*
that routes `ComputerUseArgs`/`ComputerUseResult` frames inside the daemon. The
`computer_use_*` snake_case names are a **different** namespace: the tool names
the daemon passes to the local-cua sidecar, which speaks an MCP-shaped
`tools/call` protocol over a Unix socket (§5.5). Both are real; they are not
the same list.

### 5.2 Executor inventory

From the token table (`:84446`–`:84520`) and the `ExecServerMessage` /
`ExecClientMessage` descriptors (`:83178`, `:83243`). **PROVEN** for every name.

| Token | Frame case | Shape |
|---|---|---|
| `shell-executor` | `shellArgs` / `shellResult` | **stream** (`shellStream`) and one-shot |
| `background-shell-executor` | `backgroundShellSpawnArgs` | one-shot spawn, returns a `shellId` |
| `force-background-shell-executor` | `forceBackgroundShellArgs` | one-shot (`{tool_call_id}` only) |
| `write-shell-stdin-executor` | `writeShellStdinArgs` | one-shot (`{shell_id, chars}`, `:78054`) |
| `read-executor` | `readArgs` | one-shot (`ReadArgs`, `:75544`) |
| `write-executor` | `writeArgs` | one-shot (`WriteArgs`, `:74908`) |
| `delete-executor` | `deleteArgs` | one-shot (`{path, tool_call_id}`, `:75071`) |
| `ls-executor` | `lsArgs` | one-shot (`LsArgs`, `:75730`) |
| `grep-executor` | `grepArgs` | one-shot, shells out to ripgrep (`GrepArgs`, `:75275`) |
| `diagnostics-executor` | `diagnosticsArgs` | one-shot (`{path, tool_call_id}`, `:75969`) |
| `fetch-executor` | `fetchArgs` | one-shot (`{url, tool_call_id}`, `:78143`) |
| `record-screen-executor` | `recordScreenArgs` | one-shot; `RecordingMode` = start/save/discard (`:78259`) |
| **`computer-use-executor`** | `computerUseArgs` | one-shot batch of actions (§5.5) |
| `mcp-executor`, `mcp-state-executor`, `list-mcp-resources-executor`, `read-mcp-resource-executor` | `mcpArgs` (`:77226`) etc. | one-shot |
| `shell-allowlist-precheck-executor` | `shellAllowlistPrecheckArgs` (`:80819`) | one-shot → `{allowlisted: bool}` |
| `mcp-allowlist-precheck-executor` | `mcpAllowlistPrecheckArgs` (`:80871`) | one-shot → `{allowlisted: bool}` |
| `web-fetch-allowlist-precheck-executor` | `webFetchAllowlistPrecheckArgs` (`:80920`) | one-shot → `{allowlisted: bool}` |
| `request-context-executor` | `requestContextArgs` (`:76689`) | one-shot environment/rules snapshot |
| `hook-executor`, `subagent-executor`, `force-background-subagent-executor`, `subagent-await-executor`, `smart-mode-classifier-executor`, `canvas-diagnostics-executor`, `git-diff-executor`, `conversation-search-executor`, `agent-store-conflict-executor`, `agent-store-conflict-notice-executor` | `executeHookArgs` (`:83303`) … | one-shot |
| `pi-read-executor`, `pi-bash-executor`, `pi-edit-executor`, `pi-write-executor`, `pi-grep-executor`, `pi-find-executor`, `pi-ls-executor`, `mini-swe-agent-bash-executor` | `piReadArgs` … `miniSweAgentBashArgs` | one-shot |

**Scope note.** The `pi-*` and `mini-swe-agent-bash` families belong to a
different agent product's tool surface carried in the same bundle. **UNKNOWN**
whether the local-exec daemon ever receives them — nothing in the desktop
wiring I read selects them.

### 5.3 Argument and result shapes

Every line reference in this subsection is `local-exec-daemon.beauty.js`.
`ShellArgs` (`:74460`), field numbers verbatim:

```
1 command, 2 working_directory, 3 timeout, 4 tool_call_id,
5 simple_commands(repeated), 6 has_input_redirect, 7 has_output_redirect,
8 parsing_result, 9 requested_sandbox_policy, 10 file_output_threshold_bytes,
11 is_background, 12 skip_approval, 13 timeout_behavior, 14 hard_timeout,
15 description, 16 classifier_result, 17 close_stdin, 18 output_notification,
19 smart_mode_approval, 20 hook_approval_requirement, 21 conversation_id,
22 admin_command_denylist(repeated), 23 request_id, 24 secret_scope_id
```

**PROVEN.** Points a reimplementation must not miss: `simple_commands` (5) is a
**legacy** flat list; `parsing_result` (8) is the structured tree-sitter result
(§8) and both are on the wire. `skip_approval` (12) is **declared by the
caller** — the daemon trusts it. `hard_timeout` (14) is the hard wall-clock
bound, `timeout` (3) the soft one. `admin_command_denylist` (22) is a repeated
string: the caller ships the policy with every call.

`ShellResult` (`:74489`): `1 success(ShellSuccess)`, `2 failure`,
`3 timeout`, `4 rejected`, `5 spawn_error`, `7 permission_denied`,
`101 sandbox_policy`, `102 is_background`, `103 terminals_folder`, `104 pid`.
`ShellSuccess` (`:74745`) carries `{command, working_directory, exit_code,
signal, stdout, stderr, execution_time, output_location?, shell_id?,
interleaved_output?, pid?, ms_to_wait?, local_execution_time_ms?,
background_reason?, output_head?, output_tail?, elided_chars?}`. **PROVEN.** The
separation of `permission_denied` from `rejected` is deliberate: `Fce`
(`:92860`) maps `permissionsConfig` to `permission_denied` with `is_readonly`,
and everything else to `rejected` with a reason string.

### 5.4 Timeouts and cancellation

`Xme` (`:109716`) with `Cir = 3e4` (`:109715`):

| `timeout` | `is_background` / `timeout_behavior = BACKGROUND` / `hard_timeout > 0` | effective |
|---|---|---|
| non-zero | any | `timeout` (ms) |
| `0` | yes | `0` = **no timeout** |
| `0` | no | **30 000 ms** |

**PROVEN.** `TimeoutBehavior` is `{UNSPECIFIED, CANCEL, BACKGROUND}`
(`:74141`–`:74150`) — on expiry, either abort or background the command.
`ShellBackgroundReason` is `{UNSPECIFIED, TIMEOUT, USER_REQUEST}` (`:74153`), so
a backgrounded command records *why*. `hard_timeout` is armed as a `setTimeout`
that first tries to abort the background shell and otherwise aborts both the
exec and its controller (`:110049`). **PROVEN.**

**Cancellation, two mechanisms.** Frame-level: a `{kind:"cancel", requestId}`
on the stream marks the inflight entry cancelled and calls its `cancel()`
(`:110843`, `handleCancel` `:111046`); for local-tool frames this aborts an
`AbortController` (`:110952`). Process-level: `zs` (`:33087`) attaches an
`abort` listener that signals the child `SIGTERM`, then `SIGKILL` after 1000 ms
if still alive. `yOt({platform, detached})` (`:33052`) chooses
`process_group` vs `process` and `yOe` (`:33055`) sends the signal — so
**detached children are killed by process group** where the platform supports
it. The bash execute path spawns `detached: !0` (`:34018`) precisely so a
cancellation takes the whole tree. **PROVEN.**

Messages `send` ops are additionally serialised per `sendKey` and de-duplicated
by request id with a bounded replay cache of `aZe = 64` entries (`:110783`;
`withSendKey` `:110998`). **PROVEN** — exactly-once-ish delivery for a
side-effecting operation, and a reimplementation of Messages sending needs it.

### 5.5 The `computer_use_*` family

The daemon talks to a **macOS sidecar app** over a Unix socket.

| Property | Value | Evidence |
|---|---|---|
| App support dir | `~/Library/Application Support/cursor-computer-use` | `:104220`, `:104361` |
| Override env | `CUA_APP_SUPPORT_DIR` | `:104362` |
| App bundle | `~/.cursor/cursor-computer-use/Cursor Computer Use.app` | `:104229`, `:104360` |
| Override env | `CUA_SERVICE_APP` / `CUA_DIRECT_LAUNCH` | `:104363`, `:104364` |
| Executable | `<app>/Contents/MacOS/CUCursorService` | `:104247` |
| State file | `<appSupport>/service.json` → `{rpcSocketPath \| appControlSocketPath}` | `:104222`, `:104266`, `:104004` |
| Protocol | newline-delimited JSON; request `{…, id, method, requestID}` | `:104010`, `:104292` |
| Call timeout | 45 000 ms | `:104365` |
| Launch readiness | 8 000 ms, polled every 200 ms | `:104366`–`:104367` |
| Launch | `spawn(exe, [], {detached: true, stdio: "ignore"})` | `:104249` |

**PROVEN.**

Tool names the daemon sends (`:104056`–`:104094`): `screenshot` →
`computer_use_screenshot`; `click` → `computer_use_click`
(`{method:"coordinate", x?, y?, button, count, modifier_keys}`);
`scroll` → `computer_use_scroll`; `move` → `computer_use_mouse_move`;
`mouseButton` → `computer_use_mouse_button`; `drag` → `computer_use_drag`;
`typeText` → `computer_use_typing`; `pressKey` → `computer_use_press_key`
(`{key, hold_duration_ms}`); `checkPermissions` →
`computer_use_check_permissions`. Plus `control/start` (returns a session id)
and `control/release` (`:104102`, `:104120`), and `tools/call` / `tools/list`
for the MCP-shaped envelope (`:105188`, `:59629`). **PROVEN.**

**Frame shape.** `ComputerUseArgs` (`:78471`): `{tool_call_id, actions[],
description?, bind_unmapped_characters?, desktop_lease_actor_id?,
screenshot_settle_ms?, native_x11_driver?}`. `ComputerUseAction` is a `oneof` of
eleven cases (`:78515`): `mouse_move`, `click`, `mouse_down`, `mouse_up`,
`drag`, `scroll`, `type`, `key`, `wait`, `screenshot`, `cursor_position`.
`ComputerUseResult` (`:78767`) is `{success | error}`; success (`:78788`)
carries `{action_count, duration_ms, screenshot?, log?, screenshot_path?,
cursor_position?, settle_ms?, driver?}`. **PROVEN.**

**Permission gating.** A computer-use call is gated as `use-app` with the
target as both target and recipient (`decideAppUse`, `:110966`–`:110976`), and
permissions surface back to the caller through three callbacks —
`onPermissionPending`, `onPermissionGranted`, `onStillQueued` (`:110959`–
`:110961`). **PROVEN.** A permission failure is also classified:
`computer_use_screenshot` errors and any `permission_required` code are treated
as non-retryable and suppress the follow-up error screenshot (`A$e`,
`:104028`). **PROVEN** — a small but real usability rule.

### 5.6 The `local-tool` frame family

Distinct from the exec frames. `handle` (`:110840`) dispatches on
`e.kind ∈ {exec, messages-op, local-tool, upload, download, discover-ai-tool,
retire-approval, cancel}`.

| Kind | Gate |
|---|---|
| `upload`, `download`, `discover-ai-tool` | `isLocalUseBlocked({describes})` → refusal string, else proceed |
| `messages-op` with `op.kind === "send"` and no approval id | `decideLocalUse({describes})` first; a non-`allow` verdict returns `messages-consent-result` |
| `messages-op` otherwise | `isLocalUseBlocked` |
| `local-tool` (computer use) | `decideAppUse` per app |
| `retire-approval` | notifies `onApprovalRetired` |
| `cancel` | cancels inflight work |

**PROVEN** (`:110840`–`:110900`). `describes` per kind (`dsr`, `:111080`):
`upload` → `{action:"write-file", target: path}`; `download` →
`{action:"read-file", target: path, attachToResourcePath: path}`;
`discover-ai-tool` → from `sPe(source)`. **PROVEN.** Messages ops get `CP(e.op)` (`CP` at
`local-exec-daemon.beauty.js:83618`, called at `:110911`) — I did not read
`CP`'s body, so "a read produces `read-messages` and a send produces
`send-imessage`" is **INFERRED** from the action vocabulary, not proven.

Sizes: `maxFileBytes` default `104857600` (100 MiB, `:110811`); a computer-use
reply over `I7` bytes is failed rather than truncated (`:136410`); uploads are
refused before being read into memory (`xPe`, `:83676`).

---

## 6. Process, shell and PTY handling

### 6.1 There is no PTY

**PROVEN negative result.** Over the whole daemon bundle: `node-pty` — zero
occurrences; the standalone word `pty` — zero occurrences; `script(1)`,
`util-linux`, `forkpty`, `openpty`, `conpty` — zero occurrences. Commands run
through `child_process.spawn` with pipes. The strongest positive evidence is
the shell environment (`:33045`):

```js
Gs = { TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", _ZO_DOCTOR: "0" };
```

`TERM=dumb` and `NO_COLOR=1` are exactly what you set when there is no terminal.
**PROVEN.** The one thing that *looks* like terminal handling is not: the daemon
keeps a persistent **bash state snapshot** so `cd`, exported variables, aliases
and functions survive across separate `spawn` calls. That is state
serialisation, not a PTY.

### 6.2 The persistent bash state

| Step | Mechanism | Evidence |
|---|---|---|
| Initial capture | `bash -O extglob -ilc '<init> … printf "<marker>\n"; dump_bash_state'`, collect stdout, strip to the marker | `Jae`, `:33801`–`:33839` |
| Shell selection | the user's `$SHELL` if it is bash, else `which bash` | `:33790` |
| Per-command restore | `snap=$(command cat <&3)` then `builtin eval -- "$snap"` | `:33977` |
| Per-command save | `dump_bash_state >&4`, then `COMMAND_EXIT_CODE=$?; … builtin exit $COMMAND_EXIT_CODE` | `:33977`–`:33980` |
| Command invocation | `builtin eval "$1"` with the command as `$1` after `--` | `:33912`, `:33982` |
| stdin isolation | `< /dev/null` appended unless `pipeStdin` | `:33913` |
| Windows | file-based state transport inside a `mkdtemp` directory | `:33960` |
| PowerShell / zsh / "zsh light" | separate state readers selected by `pI` | `:35168`–`:35195` |

**PROVEN.** The snapshot deliberately excludes request-scoped state
(`:33317`): the filter drops `_proxy=`, `CURSOR_SANDBOX`, `SUDO_ASKPASS`,
`CURSOR_ASKPASS`, `CURSOR_CONVERSATION_ID`, `CURSOR_REQUEST_ID`,
`CURSOR_AGENT_STORE`, and strips `errexit`/`nounset`/`pipefail`/`posix` from the
replayable `shopt -po` output so a stray `pipefail` does not leak into every
later command (`:33327`, with the in-code comment "a stray pipefail makes a
successful `cmd | head` report exit 141"). It also unsets
`ELECTRON_RUN_AS_NODE` by exact name, with a comment explaining why a line-based
grep was rejected (`:33306`–`:33311`). **PROVEN.** High-quality engineering,
worth copying conceptually.

### 6.3 Environment scrubbing

| Var | Where | Effect |
|---|---|---|
| `ELECTRON_RUN_AS_NODE` | `Cg` (`local-exec-daemon.beauty.js:31300`–`:31303`) | **deleted** from every spawned child env; `gd` applies `Cg` to `r.env` and to `process.env` (`:32836`) |
| `ELECTRON_RUN_AS_NODE` | `Zse` (`main-core.beauty.js:29846`) | **deleted** from the daemon's own env |
| `ELECTRON_RUN_AS_NODE` | bash state init (`local-exec-daemon.beauty.js:33311`), PowerShell (`:33415`), zsh (`:33593`, `:33730`) | unset inside the snapshot so one command cannot bake it in |
| `SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY` | `GP` (`local-exec-daemon.beauty.js:31305`, list `FIt` `:31313`) | **deleted on Linux only**, in the sandboxed spawn path (`:32717`) |
| `NODE_USE_SYSTEM_CA`, `SAND_LOCAL_EXEC_INHERITED_FDS`, `SAND_LOCAL_EXEC_FILE_KEY` | `Q8r` (`local-exec-daemon.beauty.js:143204`) | deleted from the daemon's own env after being consumed |
| `SAND_NODE_PROXY_ENV` | `eSe` (`local-exec-daemon.beauty.js:68235`) | consumed, deleted, then `http.setGlobalProxyFromEnv` |

**PROVEN.** The Linux credential-socket deletions are the interesting ones: they
close the "the sandboxed command inherits my SSH agent" hole. **INFERRED** as to
intent; the code simply deletes them. Sandboxed children also get
`CURSOR_SANDBOX: "native"` (`:32719`) and, when the temp-dir rewrite applies, an
explicit owned-environment list `__CURSOR_SANDBOX_OWNED_ENV` plus a restore
snippet `__CURSOR_SANDBOX_TEMP_RESTORE` (`:32723`–`:32725`). **PROVEN.**

### 6.4 `workerExecArgvWithoutInspectorFlags()`

`main-core.beauty.js:30582`:

```js
function Zg(e = process.execArgv) {
  return e.some((n) => n.startsWith("--inspect") || n.startsWith("--debug")) ? [] : void 0;
}
```

**PROVEN.** If the process was launched with any `--inspect*` / `--debug*` flag,
return `[]`; otherwise `undefined`. `undefined` means "let the `Worker` inherit
the parent's `execArgv`" (the `worker_threads` default); `[]` means "give this
worker no exec args at all".

**What it solves. INFERRED, but the inference is tight:** Node's `Worker`
propagates the parent's `execArgv` to each thread. If the parent was started
with `--inspect=9229`, every worker would try to open the same inspector port —
failing with `EADDRINUSE` or, worse, exposing a second debugger. Returning `[]`
suppresses both, and the helper is only consulted when the process *is* being
inspected.

Two call sites, both **`new Worker()` in main-core/main-app**, not the daemon:
main-core `Rce` (`:30591`–`:30616`) — a `new Worker(eval)` that reads the
**system CA certificates** via `tls.getCACertificates("system")`, documented
in-code as "Sand's Electron ships Node 24, which has both" (`:30602`); and
main-app `m2` (`main-app.beauty.js:68000`), the chrome cookie import worker.
**PROVEN.** The exec daemon bundle contains **zero** occurrences of
`workerExecArgvWithoutInspectorFlags`, so the fragment in
`recon/FINDINGS.md:116` is correctly attributed to main-app/main-core and any
statement that the daemon uses it would be wrong. The daemon's own
`worker_threads` use is limited to the Messages worker
(`new sZe.Worker(t, {workerData: s})`, `:110753`) with no `execArgv` override.

---

## 7. Filesystem and path policy

Unless a line is qualified with a filename, every `:NNNN` reference in this
section is `local-exec-daemon.beauty.js`; the copies in `main-core.beauty.js`
are called out explicitly in §7.6.

### 7.1 The root

`eZe(env)` (`:110651`): `SAND_LOCAL_EXEC_ROOT` or `SAND_AGENT_PROJECT_DIR`, else
`os.homedir()`. **PROVEN.** It is published as `localRoot` in the `hello` frame
(`:111773`), along with `terminalsFolder = join(root, "terminals")`
(`:110807`). A requested working directory is resolved against the root and
falls back to the root if missing, with a stderr notice (`csr`, `:110682`:
`working directory <x> does not exist on this machine; running in <root> instead`).
**PROVEN** (`YYe`, `:110674`).

### 7.2 Containment — `X8`

`local-exec-daemon.beauty.js:110690`:

1. resolve the path (absolute as-is, else against the root);
2. `ZYe(root, resolved)` → relative; if non-empty and starting with `..` or
   absolute → throw
   `SandLocalExecPathError("Path is outside the allowed local-exec root and was refused: <path>")` (`:110692`);
3. `realpath(root)`;
4. `realpath(resolved)` **with a component-by-component fallback** for
   non-existent tails (`exe`, `:68342`);
5. re-run the relative check on the realpath → throw
   `"Path resolves through a symlink to outside the allowed local-exec root and was refused: <path>"` (`:110702`).

**PROVEN.** Step 5 is the symlink-escape guard and it is genuinely present, not
merely implied by step 2. `X8` is called before upload (`:111068`), download
(`:111071`), the AI-tool discovery read (`:110738`) and the grep executor's path
handling (`:110737`). **PROVEN.**

### 7.3 The no-follow write path

`NoFollowRefusedError` exists **in the exec daemon**, with the same reason
vocabulary as main-core (`:68456`–`:68467`):

```js
Gwt = {
  "target-link": "a symbolic link at the target path",
  "parent-link": "a symbolic link at the parent path",
  "not-a-file": "a non-regular file at the target path",
}
uc = class extends Error {
  constructor(e, r) { super(`refused ${Gwt[e]} ${r}`); this.name = "NoFollowRefusedError"; this.reason = e; this.path = r; }
}
```

So the message is `refused a symbolic link at the target path <path>`, the class
`name` is the literal `"NoFollowRefusedError"`, and `reason` is one of the three
literals. **PROVEN.** The main-core copy is at `main-core.beauty.js:1953`–`:1959`
with an identical table and message.

**Two modes** (`D2`, `:68485`): **rooted**, when `noFollow: {root}` is supplied,
walks every parent component with `O_DIRECTORY | O_NOFOLLOW` (on Linux through
`/proc/self/fd/<fd>/<child>`); **legacy**, when `noFollow` is omitted,
`realpath`s the target and `lstat`s it. **PROVEN.** The rooted walk is `YX`
(`:68591`–`:68600`), which **first** rejects any path not strictly below the
root with `RangeError("<path> is not below the no-follow root <root>")`
(`:68596`), then splits the parent chain and opens each component (`ixt`
`:68601`, `sxt` `:68619`) or `lstat`s each component on non-Linux (`oxt`,
`:68627`–`:68634`).

Error mapping (`axt`, `:68642`; `cxt`, `:68646`):

| errno | reason |
|---|---|
| `ELOOP` | `target-link` (read path) / `parent-link` (parent walk) |
| `ENXIO`, `ENODEV`, `EOPNOTSUPP` | `not-a-file` |
| `ENOTDIR` **and** the path is not a non-symlink, non-directory entry | `parent-link` |

**PROVEN.** `Zwt = new Set(["ENXIO","ENODEV","EOPNOTSUPP"])` `:68482`; the
`ENOTDIR` disambiguation is `uxt`, `:68650`.

### 7.4 The atomic write pattern

`lxe` (`:68517`) / `_xe` (`:68536`) and the fd variant `Sxe` (`:68568`):

1. temp path = `<target>.<random uint32>` (`ZX`, `:68673`);
2. `open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode ?? 0o666)`
   (`hxe` `:68477`; `gxe = 438 = 0o666` `:68480`);
3. write; if an explicit mode was given, `fchmod` (failures logged, not fatal);
4. **`fsync`** the descriptor;
5. close;
6. re-check the target is not a symlink (`checkTarget`, `:68570`);
7. `rename(temp, target)`;
8. on any error, `rm(temp, {force:true})`.

**PROVEN.** Concurrent writes to the same resolved path are serialised by an
in-process async mutex keyed on the path (`lxt`, `:68654`). `D2` performs real
writes at `:68783` (the generic durable-file writer), `:69267` (the retirements
file) and **`:111069` (the `upload` local tool)**. **PROVEN.** A file uploaded
through the `local-tool` path is therefore written atomically and cannot be
redirected through a symlink.

### 7.5 Read

`KX` (`:68509`) opens with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (`Wwt`,
`:68478`) and then `fstat`s; a non-regular file throws `not-a-file` (`nxt`,
`:68583`). `O_NONBLOCK` is there so a FIFO open cannot hang. **PROVEN** — a
reimplementation that omits it will hang on a named pipe.

### 7.6 Is the same logic in main-core?

**Yes.** `main-core.beauty.js:1756`–`:1872` is a near-line-for-line copy:
identical reason table (`:1953`–`:1955`), identical class `name` (`:1959`),
identical default modes `VL = 438` / `rre = 384` (`:1975`–`:1976`), identical
errno set `ore` (`:1977`), identical `/proc/self/fd/<fd>/<child>` indirection
(`LL`, `:1819`), identical `RangeError` text (`:1799`). The only structural
difference is variable naming, plus the daemon's additional `O_NONBLOCK` read
path. **PROVEN.** The honest reading is that this is **one shared module
compiled into two bundles**, not two implementations that agree — consistent
with the bridge/service/executor layering recovered in
`recon/FINDINGS.md` §D6.

---

## 8. Tree-sitter

`tree-sitter` is **load-bearing for the security model, and only in the exec
daemon.** Across all four bundles the only requires are
(`local-exec-daemon.beauty.js:85346`–`:85347`):

```js
var qOe = Ue(require("tree-sitter"), 1),
    GOe = Ue(require("tree-sitter-bash"), 1),
```

Zero occurrences in `main-core`, `main-app` or `node-agent-coordinator`.
**PROVEN.** The shipped natives are confirmed both by the dependency manifest
(`tree-sitter-bash/prebuilds/darwin-arm64/tree-sitter-bash.node`,
`tree-sitter/build/Release/tree_sitter_runtime_binding.node`) and independently
by `recon/rea/projection-boundaries.json` → `native-addon` (4 entries, 2 of them
tree-sitter). **PROVEN.** `web-tree-sitter` is listed as *copied* in the
manifest but required by none of the four bundles — **UNKNOWN** what uses it.

### 8.1 The stub path

`Xae = "CURSOR_TREE_SITTER_STUBBED"` (`:85348`). If constructing the parser
throws an error whose `code` is that literal, the daemon logs

> `shell-parser: tree-sitter natives are unavailable in this artifact; shell command analysis degrades to parsingFailed`
> — `local-exec-daemon.beauty.js:85363`

and returns `null` from the lazy getter (`GOt`, `:85352`). A `null` parser
produces `{legacy: {simpleCommands: [], hasInputRedirect: !1,
hasOutputRedirect: !1}, structured: {parsingFailed: !0, executableCommands: [],
hasRedirects: !1, hasCommandSubstitution: !1, redirects: []}}`
(`HOt`, `:85377`). **PROVEN.** The stubbed build is therefore **fail-closed** for
the denylist (§3.6) and **fail-open** for the forced-egress policy decision
(§4.5 step 3 keeps the deny-by-default policy). Both directions are the safe one.

### 8.2 What the parse produces

`HOt` (`:85377`–`:85553`) walks the `tree-sitter-bash` tree and returns two
parallel views.

**`legacy`** — the flat compatibility view, reported on the wire as
`ShellArgs.simple_commands` / `has_input_redirect` / `has_output_redirect`:
`simpleCommands` (every `command_name` node's text plus the head of
`simple_command` nodes), and two regex-derived booleans for input and output
redirection. **PROVEN.**

**`structured`** — the view the denylist uses:

| Field | Meaning |
|---|---|
| `parsingFailed` | set when a `command` node has no `name` child |
| `executableCommands: [{name, args:[{type,value}], fullText}]` | one per `command` node; `fullText` is `name` plus every argument's raw text |
| `hasRedirects` | any redirect node seen |
| `allRedirectsAreDevNull` | present only if there was at least one redirect; true iff **every** redirect resolved to `/dev/null` |
| `hasCommandSubstitution` | a `command_substitution` / `process_substitution` node whose parent is not a `string` |
| `redirects: [{operator, destinationFds, targetNodeType, targetText?}]` | per-redirect detail |

**PROVEN** for the field names and derivations (e.g. `allRedirectsAreDevNull`
is `i && a.allRedirectsAreDevNull = s`, where `s` is the AND-fold of each
redirect's safety, `:85553`). The redirect analyser is more careful than a
denylist needs: it tracks a **per-command file-descriptor table** initialised to
`{0:"original-stdin", 1:"original-stdout", 2:"original-stderr"}`, resolves
`>&N` / `<&N` through it, and marks a descriptor `"unsafe"` when it cannot prove
the target is `/dev/null` (`m`, `T`, `h`). A `heredoc` counts as safe only when
attached directly to a command name and not inside a non-string command
substitution (`A`). **PROVEN.**

### 8.3 Why it matters

Only two consumers read the structured result: **the admin denylist** (`_I` →
`yMe`, §3.6) at `:93814` and `:109870`; and **the forced-egress policy decider**
(`Wg`, §4.5) at `:91135`. **PROVEN.** Both are security decisions whose input is
a parse of an attacker-influenced string — which is precisely why a parse
failure is treated as a denial in the denylist path.

**A caveat worth stating.** `yMe` (`:91312`) matches on the **raw `fullText` of
each command node**, not on a normalised argv. `fullText` is built by
concatenating node text with single spaces, so it can differ from the raw
substring in whitespace and quoting; matching against all three normalisations
(§3.6) compensates. This is heuristic defence-in-depth, not a shell-accurate
canonicalisation. **INFERRED** — the code does not claim otherwise, and the
fail-closed rule exists precisely because the authors did not trust the parse.

---

## 9. The macOS Messages bridge

Two pieces: a **worker thread** that reads the database, and a **sidecar app**
that owns the privileged operations.

### 9.1 Wiring

Spawned by the daemon as a `worker_threads` `Worker` (`:110748`, `:110753`)
with `workerEntryPath = join(dirname(fileURLToPath(import.meta.url)),
"messages-worker.cjs")` (`:110799`) and `installDir = MA` =
`<dataRoot>/computer-use` (`:68395`, `:110801`). The worker is `unref`'d,
restarted lazily when it dies, and **one instance is reused** for all requests
with an incrementing integer request id and a pending-promise map (`:110778`).
On worker `error`/`exit` every pending promise rejects with the literal
`"messages_worker_failed"` / `"messages_worker_exited"`. **PROVEN.** The worker
refuses to run outside a worker thread:
`qe(de !== null, "messages-worker must run as a worker_thread")`
(`messages-worker.beauty.js:2316`).

### 9.2 Operations

| Op | Shape | Notes |
|---|---|---|
| `find-chats` | `{displayName?, handle?, limit?}` → chats | filters in JS over the full chat list |
| `items` | `{chatGuid}` → messages + attachments | |
| `search` | `{query}` → items | lower-cased ASCII needle, then a JS `includes` filter on the decoded body |
| `activity` | `{since, until}` → per-chat counts | pure SQL (`messages-worker.beauty.js:1500`) |
| `send` | `{to \| chatId, text, confirm, service}` | see §9.4 |
| `check-permissions` | `{prompt?}` → `{fullDiskAccess, automation, contacts, prompted, version, verbs}` | |
| `fetch-attachment` | by attachment id | |
| `find-contacts` | `{query, limit}` | |

**PROVEN** (`messages-worker.beauty.js:1823`). Every reply is
`{id, kind:"result"|"error", result?|error?}`. Each request carries an
`expiresAtMs`: `undefined` for `send`, otherwise `now + 30_000` (`Hoe`/`_Pe`,
`local-exec-daemon.beauty.js:83652`–`:83657`), checked in the worker
(`messages-worker.beauty.js:2320`, literal error `"messages_read_expired"`).

### 9.3 Reading: SQLite, on a copy

**The read path is SQLite, not AppleScript. PROVEN.**
`messages-worker.beauty.js:383` — `Ht = require("node:sqlite")`, i.e. **Node's
built-in `node:sqlite`**, not `better-sqlite3`. Opened at `:1458`:

```js
let s = new Ht.DatabaseSync((0, J.join)(r, "chat.db"), { readOnly: !0 });
```

`K(dir, fn)` (`:1453`–`:1466`) copies the directory to a temp dir first unless
it is already under `os.tmpdir()` (`Fe`, `:1468`, comparing `realpathSync` on
both sides), then opens **read-only** and removes the copy afterwards.
**PROVEN.** The worker never opens the live `chat.db`, which avoids WAL
contention with Messages.app — and the daemon never needs a write handle on the
user's Messages database.

Queries use `setReadBigInts(true)` and convert with `Number` (`B`, `:1471`;
`R`, `:1475`) because Apple's timestamps are nanoseconds since 2001-01-01
(`Jt = 978307200`, `:1450`) and overflow a double; `oe` handles the `> 1e12`
nanoseconds-vs-seconds split. **PROVEN.** Message bodies come from
`attributedBody` when present, decoded by a custom typedstream parser
(`nr`, `:1718`, calling `$e`, `:1432`), falling back to the `text` column.
**PROVEN.** The `activity` query excludes reactions and non-message items with
`COALESCE(m.associated_message_type, 0) NOT BETWEEN 2000 AND 3999` and
`COALESCE(m.item_type, 0) = 0` (`:1500`). **PROVEN.**

### 9.4 Sending: through the sidecar

**The send path is not SQLite — it is a privileged helper. PROVEN.**
`sendMessage` (`:2245`) calls helper verb `send-message` with
`{to, service, textFile}` or `{chatId, textFile}`. The text is written to a temp
file mode `0o600` and removed in a `finally` (`dr`, `:1766`). **PROVEN.**

The helper is reached over a **Unix domain socket** found via
`~/Library/Application Support/<appSupportDir>/service.json` → `rpcSocketPath`
(`Ur`, `:2147`–`:2172`); the request is one JSON line
`{…arguments, id:1, method, requestID}` and the response is one line (`kr`,
`:2111`–`:2141`). If the socket is absent or `ECONNREFUSED` the worker launches
the helper with `/usr/bin/open -g <app>` (`Br`, `:2142`) and retries with a
10 s / 4 s deadline split (`:2166`). **PROVEN.**

Helper methods (`$r`, `:2169`): `messages/snapshot`,
`messages/copy-attachment`, `messages/send`, `messages/check-permissions`,
`messages/find-contacts`, `messages/resolve-handles`. The **required** verb set
is checked on every response (`jr`, `:2177`; `Pr`, `:2202`) — a helper missing
`snapshot-messages-db`, `copy-attachment`, `send-message` or
`check-messages-permissions` is rejected with `"helper_missing_messages_verbs"`
(`:2205`).

The helper's error codes are mapped to stable daemon strings (`Fr`, `:2178`),
including `-1743 → messages_automation_denied` and
`-1728 / -1700 → messages_addressing_failed`. **`-1743` is the AppleScript "not
authorized to send Apple events" error**, which is strong evidence that the
helper uses Automation/Apple Events for the send. **INFERRED from the numeric
codes**, which are Apple's, not the app's.

Recipient validation is real and in the worker (`cr`, `:1758`–`:1775`): the
text must be non-empty; `chatId` must match `/^[A-Za-z0-9._@;+-]+$/`; `to` must
match an email or handle shape. **PROVEN.** Service selection (`lr`, `:1788`):
an explicit `service` wins; `"auto"` tries **`iMessage` then `SMS`**; a `chatId`
starting with `SMS;` or `any;` selects `SMS`, otherwise `iMessage`. **PROVEN.**

Delivery verification (`ur`, `:1795`): after sending, the worker snapshots the
database and looks for an outgoing message with the same
emoji-object-replacement-stripped text (`Xt` strips `\uFFFC`, `:1817`) dated at
or after the send. A mismatch is reported as `verified: false`, not as an
error. **PROVEN.**

### 9.5 The grant flow

Four coordinator methods
(`node-agent-coordinator.beauty.js:32775`–`:32778`, declared at `:34201`–`:34204`,
mirrored in `main-app.beauty.js:40958`–`:40964`):

| Method | Authorization class | Args |
|---|---|---|
| `resolveMessagesGrants` | **`person`** | `{requestId}` |
| `requestMessagesGrants` | `background` | `{requestId, grants[]}` |
| `awaitMessagesGrants` | `background` | `{requestId, waitMs}` |
| `cancelMessagesGrants` | `background` | `{requestId}` |

**PROVEN.** The three grant names are the literal array
`["automation", "contacts", "fullDiskAccess"]` (`main-app.beauty.js:37044`),
with a companion helper method literal
`"messages/automation-prompt-unavailable"` on the same line.

**Reading vs sending under the grants:**

| Capability | Requirement |
|---|---|
| read `chat.db` | Full Disk Access for whatever process opens it (the daemon, via the worker) |
| send | Automation permission for Messages (the `-1743` path) |
| resolve handles → names | Contacts |
| everything Messages | the separate `messagesEnabled` setting in the daemon's settings (`:69671`, default `false`) |

**PROVEN** for the three names, the `messagesEnabled` gate and the error-code
mapping; **INFERRED** for the mapping of each grant name to a specific macOS
privacy pane, which follows from the names and from `-1743`. Note the
asymmetry: asking, waiting and cancelling are all `background`, but only
`resolve` is `person`, so **only the resolve step may wake a parked box** (see
`docs/re/00-index.md` and `recon/FINDINGS.md` §C2 for the correction that
`person`/`background` is box-wake authority, not authentication). **PROVEN** for
the class strings.

---

## 10. Limitations and unresolved questions

Ordered by how much a reimplementer would care.

1. **The sandbox helper binary is absent, so its contract is only half-known.**
   Proven: the invocation (`--policy <file> --preflight-only -- cmd args`,
   `local-exec-daemon.beauty.js:32716`, `:32660`), the policy JSON fields
   (§4.4), the exit-code-2 means-unsupported-kernel convention (`:32683`), and
   `CURSOR_SANDBOX=native`.
   **Not** provable: what the binary does with any of it — profiles, syscall
   filtering, path enforcement. A reimplementation needs its own mechanism; the
   reference product's is not in this artifact. **UNKNOWN**, stated rather than
   guessed.
2. **No macOS entitlements or codesign verification were analysable.** The
   helper is not in the asar; `grep` for `codesign`/`entitlement`/`csops`
   inside the daemon returns nothing.
3. **The `allow_instructions` / `block_instructions` matcher is not in any
   readable bundle.** Shapes, storage, the 1000-char/20-entry sanitation and
   the three-tier naming are all proven (`:69348`, `:69352`, `:69624`,
   `:76980`, `:77069`), but the code that *evaluates* an allow instruction
   against a command is not present in the four bundles. **I therefore cannot
   state its precedence against `block_instructions`, and I will not guess.**
   The one ordered rule evaluation I found is the deny-only admin denylist.
4. **`serverAuthoritative`'s provenance is only partly traced.** Proven: it
   arrives in the credential schema (`main-core.beauty.js:28835`), is threaded
   into the decision context (`local-exec-daemon.beauty.js:136593`) and changes
   the ladder. **Not** proven: which backend response sets it, or whether the
   desktop ever observes it as `false` in practice.
5. **REA coverage is partial for exactly these files.** Per
   `recon/FINDINGS.md` §E4, `local-exec-daemon/main.cjs` and
   `node-agent-coordinator/main.cjs` are **partial** parses and the semantic
   graph is truncated at its 40,000-node ceiling. Every claim here comes from
   reading the beautified text directly — but **absence of a finding in REA is
   not evidence of absence**, and my negative results (§1, §6.1, §4.1) are
   negative results about *these bytes*.
6. **`CP(op)` was not resolved.** The function that turns a Messages op into a
   `describes` action (`CP` at `local-exec-daemon.beauty.js:83618`, called at
   `:110911`) — I did not read its body.
7. **`run-phone-tool` maps to a scope (`"call"`) that no branch handles.**
   Deliberate "always ask" or an oversight; the code does not say. **UNKNOWN.**
8. **The daemon's `shouldBlockShellCommand` hook is never installed in this
   build.** The default is a no-op (§3.9) and neither `B4` construction passes
   a service. I cannot rule out that a *different* build — the box-side binary
   distributed via dotslash (`recon/FINDINGS.md:106`) — installs a real one.
   **UNKNOWN**, and the most consequential unknown in this dossier.
9. **`web-tree-sitter` ships but is unused by these bundles.** **UNKNOWN** which
   artifact consumes it; the renderer is the likely answer and was out of scope.
10. **Telemetry and logging of denials were not audited.** The daemon has
    instrumentation families
    (`local_exec.permissions.mcp_allowlist_check.result`,
    `local-exec-daemon.beauty.js:108237`) and the desktop edge reports failures
    under `("local-exec", <stage>)`. Not enumerated, so I cannot say what a
    denial looks like in the vendor's telemetry.
