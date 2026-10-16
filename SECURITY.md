# Security policy

This software runs an AI model with your permissions on your machine. It holds
credentials, executes commands, and is reachable from your phone. Treat a bug in
it as a security bug by default.

## Reporting

Open a **private** security advisory on the repository rather than a public
issue, or email the maintainers listed in `package.json`. Please include:

- what you did, what happened, and what you expected;
- the host version and platform;
- whether a model was involved, and if so, whether the trigger was content the
  model read (a prompt-injection path is the most interesting class of bug here).

We will acknowledge within a few days. There is no bug bounty.

## Threat model

Two adversaries, and only two, are in scope:

**1. Content the model reads.** A web page, an email, a file, an MCP server's
tool description. Any of these can carry instructions. The model will sometimes
follow them. The design therefore assumes the model *will* be hijacked, and asks
instead: what is the worst thing a hijacked model can do?

**2. A stolen paired device.** A phone with a valid device token falls into the
wrong hands. The design assumes the attacker has the token and the network
position, and asks what they can reach.

Out of scope: an attacker who already has code execution as your user (they can
read the master key directly), and an attacker who controls the model provider.

## Invariants

These are the properties the project promises. Each has a test; if you can break
one, that is a vulnerability.

| Invariant | Where it is enforced | Test |
|---|---|---|
| A `background` device cannot call a `person` method | `Host.dispatch`, one place | `host.test.ts` |
| A device that redeems a pairing code becomes `background`, even if it asks for `person` | `Host.claimPairing` | `host.test.ts`, `bootstrap.test.ts` |
| A pairing code is single-use, expires, and is rate-limited | `Store.claimPairing` | `host.test.ts` |
| Only a hash of a pairing code is stored | `Host.beginPairing` | `host.test.ts` |
| An unauthenticated socket may call exactly three methods | `HostServer.handleRequest` | `server.test.ts` |
| A secret value never appears in a protocol response | No `secrets.get` exists | `host.test.ts` |
| A secret value is never stored in the clear | `crypto.ts`, AES-256-GCM | `host.test.ts` |
| A model-supplied path cannot escape the working directory, including through a symlink | `resolveInside` | `loop.test.ts`, `end-to-end.test.ts` |
| A command runs without a shell, so metacharacters stay literal | `run_command` via `execFile` | `loop.test.ts` |
| A child process does not inherit secret-looking environment variables | `sanitizeEnv` | `loop.test.ts` |
| Egress is denied unless a host is explicitly allowed | `http_fetch` | `loop.test.ts` |
| A capability cannot shadow a core method | `buildRegistry` | `bootstrap.test.ts` |
| A run that needs a decision parks instead of guessing | `RunContext.requestApproval` | `host.test.ts`, `end-to-end.test.ts` |
| An approval past its deadline resolves to `expired`, never `granted` | `Store.resolveApproval` | `host.test.ts` |

## Design decisions that are deliberately restrictive

If you are here to loosen one of these, please open an issue first.

- **There is no `secrets.get` RPC method.** Secret values are reachable only from
  inside a tool execution. Adding a read path would make the whole sealing effort
  pointless.
- **A remote device cannot promote itself to `person`.** `claimPairing`
  downgrades rather than honours the request. The only ways to become `person`
  are to run code on the host or to be handed a code by a device that already is.
- **Loopback is the default bind.** `--lan` is opt-in and prints a warning.
- **Egress defaults to deny-all.** Empty allow list means no network at all. An
  agent that can fetch any URL can exfiltrate anything it can read.
- **MCP over stdio requires an explicit `allowStdio` opt-in.** Registering a
  stdio server is arbitrary code execution configured by whoever supplies the
  command.
- **`mcp.add` and `secrets.put` are `person`-class**, deviating from the shape
  observed in the reference product, where `storeSecret` was background-safe. A
  device that can write a credential can also overwrite one and lock you out of a
  service. We chose the stricter classification and documented the deviation.

## Known limitations

Honest gaps, not vulnerabilities, but you should know them:

- **Tool approval is per-tool, not per-argument.** `run_command` requires
  approval for every invocation, which is safe but blunt. `read_file` requires
  none, so a hijacked model can read any file inside the working directory
  without asking. Per-argument policy is the obvious next step.
- **The working directory is one jail for all agents.** Multiple agents with
  different trust levels sharing a host share a jail.
- **Transcript content is stored unencrypted.** Secrets are sealed; conversation
  content is not. Someone with the data directory can read your transcripts.
- **The renderer holds a `person` token in memory.** A compromise of the Electron
  renderer gets person-class access for the life of the process. The window is
  hardened (`contextIsolation`, `sandbox`, no `nodeIntegration`, a CSP with no
  inline or remote script) precisely because that token is there.
- **Denial of service is not addressed.** A model loop that burns tokens is
  capped by turn and tool-call limits, but there is no cost budget or rate limit
  per agent.

## Dependency policy

Install-time scripts are arbitrary code execution, so `pnpm-workspace.yaml`
allow-lists exactly two packages that need them (`esbuild`, `electron`) and
denies every other postinstall script by default. Adding a package to that list
is a reviewable decision, not a routine one.
