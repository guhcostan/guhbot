# Agent guidance

If you are an AI agent working in this repository, read
[`docs/engineering.md`](docs/engineering.md) before writing code. It is the
contract: layering rules, TypeScript conventions, the capability seam, and the
security posture every new capability has to honour.

The short version:

- **`pnpm test` builds first.** Tests resolve workspace packages through their
  built `dist`, so running vitest on its own can silently test stale code.
- **`@guhbot/protocol` depends only on `zod`.** The mobile client imports it; a
  Node-only import there breaks the phone build.
- **Only `@guhbot/server` binds a socket.** Capabilities expose tools or RPC
  methods, never their own listener.
- **`@guhbot/host-core` owns every durable write.** Nothing else opens the
  database.
- **Every new RPC method needs an honest `authz` class.** If it mutates durable
  state, sends something outward, spends money or resolves an approval, it is
  `person`. If in doubt, choose `person`.
- **Any path from a tool argument goes through `resolveInside()`** before it
  touches the filesystem.
- **Any tool that mutates something outside the host's own data, sends a message
  outward, or spends money sets `requiresApproval: true`.**
- **`recon/` is git-ignored on purpose.** It holds artifacts extracted from a
  proprietary application for study. Never commit anything from it, and never
  copy code, assets or strings out of it into `packages/` or `apps/`.

Run `pnpm test` and `pnpm typecheck` before you finish. For the live-model suite,
`pnpm test:live` (it skips itself without credentials).
