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

A capability package is usually three things:

1. A **tool set**: `(options) => ToolDefinition[]` from `@guhbot/agent`. Read-only
   tools set `requiresApproval: false`; anything that mutates sets `true`.
2. **State**, if it needs any: a table plus methods in `host-core/src/store.ts`.
3. **RPC methods**, if a client needs to configure or observe it: a spec in
   `protocol/src/methods.ts` with an explicit `authz` class and a summary, plus a
   handler in the `HANDLERS` table in `host-core/src/host.ts`.

Do not add a fifth kind of thing.

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
