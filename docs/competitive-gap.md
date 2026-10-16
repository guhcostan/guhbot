# Competitive gap analysis

Written after reading the **source** of the two closest open-source projects, not
their marketing pages. Both are public, so this is source study rather than
reverse engineering.

- **OpenMausBot** (`milind-soni/OpenMausBot`, ~5k stars) — "the open-source Grok Bot alternative".
- **touri** (`touri-ai/touri`) — open-source desktop app for agent bots with isolated VMs, browser and computer use.

The purpose of this document is to answer one question honestly: **what does
"good or better" require, and where do we actually stand?**

## Where we are genuinely ahead

These are real, verified differences, not positioning.

| Property | guhbot | OpenMausBot | touri |
|---|---|---|---|
| Per-method authorization class enforced in the dispatcher | ✅ `person` / `background` | Tool policy and approval modes, but no equivalent two-class rule on the RPC surface | No documented equivalent |
| A paired device cannot promote itself | ✅ by construction, with a test | Pairing lives in a sidecar; a device's ceiling is not stated as an invariant | Not documented |
| No `secrets.get` on the wire | ✅ deliberately absent | — | — |
| Output validated against the method's own schema before it leaves the host | ✅ | — | — |
| Capabilities cannot shadow core methods | ✅ enforced at boot | — | — |
| Self-hosted **and** hosted from one unmodified runtime | ✅ | Hosted path exists separately | — |

The security posture is our differentiator and it is backed by tests. That is
worth leading with.

## Where we are behind — ordered by how much it matters

Sections marked **closed** are kept with their original reasoning, because the
reasoning is what justified the work and the next person should be able to check
whether the fix actually answered it.

### 1. We only have one kind of engine. They have a driver layer. — **closed**

`server/drivers/` in OpenMausBot holds: `acp/` (Agent Client Protocol, which is
how Zed and others drive coding agents), `codex-process.ts`,
`codex-background-text.ts`, `antigravity.ts`, `cline-engine`, `builtIn.ts` and
`native.ts`. Their headline is "bring your own agent": every bot in the sidebar
is Claude Code or Codex running locally under the hood.

We had exactly one engine: our own `AgentLoop` talking to an OpenAI-compatible
endpoint.

**Why this was the biggest gap.** It is an adoption problem, not a feature gap.
Requiring a model API key excludes everyone who already pays for a Claude Code or
Codex subscription — which is most of the audience for this category. They can
start in one click; our users have to go and get a key first.

**What we built.** `packages/engine-cli` is an `Engine` seam — `probe()` decides
whether an engine is usable here, `createExecutor()` produces a `RunExecutor` —
with one driver per installed agent CLI. `--list-engines` reports what a host can
actually drive rather than what the code nominally supports, and `--engine <id>`
selects one; the OpenAI-compatible loop stays the portable, provider-agnostic
default. Verified on this machine:

```
claude-code    ready (2.1.293 (Claude Code))
codex          ready (codex-cli 0.162.1)
opencode       ready (opencode v2.0.25)
```

A Claude Code or Codex subscriber now has a working bot with no API key, which
was the whole point of the section above.

### 2. Our network exposure lives inside the runtime. Theirs does not. — **closed**

The OpenMausBot companion README states the design explicitly: the harness listens
on `127.0.0.1` **and nothing else**, rejects any request whose `Host` is not
loopback (which defeats DNS rebinding), and a **separate sidecar process** in
front of it handles pairing, device tokens, network exposure and response
scrubbing. The phone talks to the sidecar; the sidecar talks to the harness over
loopback.

We put `--lan` into `HostServer`, so the process that runs commands also binds the
network socket.

**Why theirs is better.** The runtime keeps one job and never opens a listening
socket; the network-facing surface is a small, separately auditable process; and
loopback-only plus a `Host` check is a defence we do not currently have. Their
README also notes the failure mode of the alternative: they had patched someone
else's request handler to bind a second socket and it broke when upstream
hardened its loopback gate.

**What "better" would look like.** Split our `HostServer` into a **loopback-only
harness socket** and an optional **companion** process that terminates the
network. Enforce `Host: 127.0.0.1`/`localhost` on the harness even on loopback,
so DNS rebinding cannot reach it through a browser. This is a straight
improvement to our own security story, and it removes `--lan` from the runtime.

### 3. They have an eval harness and we have only tests. (important)

`evals/` holds `golden/`, `live/`, `providers/`, `runners/`, `scorers/` and
`reports/`, with scenarios in JSON. That measures agent quality; our suite
measures code correctness.

**Why it matters.** Test suites tell you the plumbing works. Evals tell you
whether the agent is any *good*, and they are the only way to know if a change to
a prompt, a tool description or the loop made outcomes better or worse. For a
project whose whole claim is "agents do real work", this is the missing
instrument.

### 4. No installers, and no signed builds. (important for adoption)

They ship a signed and notarised `.dmg` for Apple silicon and Intel, a Windows
installer, and `.deb`/AppImage for Ubuntu. We have `pnpm build` and an unlaunched
Electron window.

**Why it matters.** A person who wants to try this will not clone a repo. This is
the difference between a project people star and a project people use. It is also
the one gap that needs a certificate and money, not just code.

### 5. No skills system.

`skills/` holds `create-verification-skill` and `phone-harness`. We have
capabilities, which are code, and no way for a user to package and share a
reusable procedure.

### 6. Project hygiene we are missing.

They have `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `AGENTS.md`, `CLA.md`,
`LICENSING.md`, `NOTICE`, `third_party/` and a `Dockerfile`. We have
`docs/engineering.md`, `SECURITY.md` and a licence, and are missing the rest of
the newcomer-facing set — including the licensing clarity that a company
eventually needs.

### 7. Smaller things worth stealing conceptually

- **`agent-tool-policy.ts`** — a policy layer over tool use, richer than our
  binary `requiresApproval`.
- **`admission.ts`** — admission control, which we have nothing of.
- **`mcp-server.test.ts`** — they can *serve* MCP, not only consume it.
- **`cloud-sync.e2e.test.ts`** — sync between machines.
- **`model-prices.ts`** / `harness-budget.ts` — cost accounting, which
  `SECURITY.md` already lists as a known gap for us.
- **ACP context reports and recovery** — recovering an agent session after a
  crash, which our "fail runs left in flight" handles only crudely.

## The honest summary

We are ahead on the thing that is hardest to retrofit and easiest to explain:
**a security model that a reviewer can check**. That is a real position and the
landing page leads with it.

We are behind on the thing that decides whether anyone gets to try it: **engines
and installers**. OpenMausBot wins the top of the funnel because a Claude Code
user is productive in one click, and we are not.

The shortest credible path to "as good" is, in order:

1. **CLI/ACP engines.** Removes the API-key barrier. Biggest single lever.
2. **Companion split.** Makes the security claim stronger, not weaker, and it is
   a day of work rather than a week.
3. **Signed installers.** Needs a certificate, unlocks non-technical users.
4. **An eval harness.** Turns "we have tests" into "we know the agent is good".
5. **Skills.** Lets the community contribute procedures, not just pull requests.

Claiming parity without 1 and 3 would be dishonest, and the README says so.
