# Engineering conventions

Read this before writing code in this repository. It exists so that several
people — or several agents — can work in parallel without producing a codebase
that only looks coherent.

## What this project is

A self-hostable agent host. The runtime lives on a machine the user controls
(their laptop, a home server, or a hosted service) and clients — desktop,
mobile, cloud console — connect to it. Every client speaks one protocol, so
there is exactly one place where agent execution, authorization and persistence
happen.

The name in the code is `guhbot`. Rename freely; it is not load-bearing.

## Architecture in one page

```
apps/desktop      Electron client        ─┐
apps/mobile       React Native client    ─┼─ speak @guhbot/protocol over
apps/cloud        hosted multi-tenant    ─┘   WebSocket to a host
                                              │
packages/server   HostServer + GuhbotClient ──┤  the only thing that binds a socket
packages/host-core Host runtime, store, authz, approvals
packages/agent    Model loop, providers, tool calling
packages/protocol The wire contract. Depends on zod and nothing else.
```

Rules that keep this honest:

1. **`@guhbot/protocol` depends only on `zod`.** It is imported by the mobile
   client, the browser console and the host. If it ever gains a Node-specific
   import, the mobile bundle breaks.
2. **Only `@guhbot/server` binds a socket.** A package that wants to be reachable
   exposes a tool or an RPC method, never its own listener. The companion
   network transport (`@guhbot/companion`) is part of the server's own
   dependency closure and only listens when the operator passes `--companion`;
   a capability package must never depend on it.
3. **`@guhbot/host-core` owns every durable write.** Nothing else opens the
   database. If a feature needs new state, it gets a table and a method in
   `store.ts`.
4. **Every RPC method declares `authz: 'person' | 'background'`.** Adding a
   method without thinking about which one it is counts as a security bug. The
   rule: if it mutates durable state, sends something outward, spends money or
   resolves an approval, it is `person`.
5. **Clients are stateless.** They render the event stream and re-query on
   reconnect. Never cache authority on the client.

## TypeScript rules

- NodeNext modules, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
- **Relative imports end in `.js`** even from `.ts` sources. Node requires it and
  `verbatimModuleSyntax` makes it mandatory.
- **Exception: `apps/mobile` uses extensionless relative imports.** Metro appends
  its own platform extensions to the full specifier, so `./x.js` never resolves
  to `./x.tsx` on a device. The mobile `tsconfig` uses `moduleResolution:
  bundler`, which accepts extensionless imports; every other package keeps `.js`.
- Use `import type` for type-only imports.
- `exactOptionalPropertyTypes` means `{ a?: string }` does not accept
  `{ a: undefined }`. Either widen the type to `string | undefined` or omit the
  key. The idiom used throughout is `...(value ? { key: value } : {})`.
- No `any`. If a value is genuinely unknown, use `unknown` and narrow it.
- No non-null assertion on anything that can actually be null — narrow instead.
  (`arr[0]!` on a just-checked non-empty array is fine.)
- Comments explain **why**, never what. A comment that restates the code is
  noise; a comment that records a constraint, a tradeoff or a workaround is the
  most valuable line in the file.

## Testing rules

- `pnpm test` builds every package then runs vitest. Tests resolve workspace
  packages through their built `dist`, so **a stale build silently tests old
  code** — always run through `pnpm test` rather than invoking vitest alone.
- Put tests in `<package>/tests/*.test.ts`, never in `src/`. `src` is the build input.
- Test behaviour and, above all, **security properties**. The existing suites
  assert things like "a background device cannot resolve an approval", "a secret
  value never appears in a protocol response", "a path outside the working
  directory is refused", and "a symlink out of the jail is refused". New
  capability packages are expected to add their own; a tool that touches the
  filesystem, the network or a credential needs a refusal test.
- No network in tests. Use a scripted/fake provider or a local fixture. The
  `ScriptedProvider` in `packages/agent/tests/loop.test.ts` is the pattern.
- Prefer a real integration test over a mocked one where feasible. The server
  tests bind a real socket on an ephemeral port.

## Security posture

This software runs an LLM with the user's own permissions. Assume the model can
be manipulated by content it reads.

- **Path handling**: any path that arrives from a tool call goes through
  `resolveInside(root, candidate)` from `@guhbot/agent` before touching the
  filesystem. Never `join()` a model-supplied path to a root directly.
- **Command execution**: never `shell: true`, never string interpolation into a
  command. Use an argv array via `execFile`.
- **Child environments**: strip secret-looking variables. See `sanitizeEnv`.
- **Secrets**: values are sealed with AES-256-GCM under a 0600 master key. A
  secret value must never appear in a tool result, a log line, an error message
  or a protocol response. There is deliberately no `secrets.get` RPC method.
- **Egress**: `http_fetch` and any browser tool default to *no* reachable hosts.
  Empty allow list means no network. Do not add a tool that fetches an arbitrary
  URL without an allow list.
- **Approvals**: a tool that mutates anything outside the host's own data — sends
  a message, spends money, changes a remote system — sets
  `requiresApproval: true`.

## How to add a capability

A capability is one package exporting `createXCapability(options) => Capability`,
and it may contribute exactly four kinds of thing:

1. **Tools** — `tools: () => ToolDefinition[]`, the set the model can call. A tool
   that mutates anything outside the host's own data, sends something outward or
   spends money sets `requiresApproval: true`. A tool only ever writes inside this
   host's own store, is bounded, and is undoable by a human, does not.
2. **RPC methods** — `methods: Record<string, ContributedMethod>`, each carrying
   its own `authz` class, input schema, output schema and summary. Declare them in
   your own package: `protocol/src/methods.ts` is for *core* methods, and a
   capability that needs to edit it has been given too much. `authz` is the whole
   security model — if it mutates durable state, sends something outward, spends
   money or resolves an approval, it is `person`. A capability that tries to
   contribute a name the core registry already owns is refused at boot.
3. **A status flag** — `flags: { memory: true }`, merged into
   `host.status.capabilities` so a client can tell what this host really has
   instead of assuming.
4. **Prompt text** — `contextSections: (context) => string | null`, extra system
   prompt read once per run. Use it when the model should not have to spend a tool
   call to know something. Two rules: it must be cheap, because it runs while a
   run is assembled; and its text is untrusted, because it usually came from a
   model or a page, so flatten it and frame it as data. It must never be able to
   read as instructions.

Those are the only four.

**State.** `@guhbot/host-core` owns every durable write, and a capability may not
open a second database, add a table or write SQL. If your capability needs to
persist something, use the public `Store` API — `getMeta`/`setMeta` for a small,
capability-owned blob, or a new typed table in `host-core/src/store.ts` if it
deserves one. Take the store through a getter (`store: () => host.store`): the
host is constructed with your capability already in hand, so the store does not
exist yet at construction time. Write down what the storage choice costs — see
the header of `packages/memory/src/store.ts` for the worked example.

**Approvals.** A credential, or any other value that leaves the host, must leave
through a function called from inside a tool execution — never through a method,
and never as a return value. `packages/credentials` is the worked example: no
method or tool returns a value, and the release path re-checks the approval after
suspending, so a revocation wins a race it would otherwise lose.

## Commands

```bash
pnpm install
pnpm -r --filter './packages/**' build    # build all packages
pnpm test                                  # build, then run every suite
pnpm typecheck                            # tsc -b over the project references
node packages/server/dist/cli.js --help   # run the host
```

## Prose

Write in English. Portuguese is fine in conversation, not in the repository.

Avoid em dashes in identifiers, resource names and code comments that describe
AWS resources. In ordinary prose they are fine — but prefer a full stop.
