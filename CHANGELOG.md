# Changelog

All notable changes to this project are recorded here. Versions follow
Semantic Versioning; the `v0.1.0` section below describes the first public
state of the repository.

## [Unreleased] — v0.1.0

The first release anyone should run. A self-hostable agent host with desktop
and mobile clients, one protocol, and every operation classified by whether
it needs a human present.

### Runtime and protocol

- Agent host with a `person` / `background` authorization boundary enforced in
  one place (`Host.dispatch`). A paired phone always joins as `background` and
  cannot promote itself.
- Wire contract in `@guhbot/protocol` (zod only), spoken over WebSocket by
  every client. Loopback by default with a `Host`-header check against DNS
  rebinding; `--companion` adds a separate, explicit network socket for phones.
- Pairing flow with single-use, expiring, rate-limited codes (only hashes
  stored). Secrets sealed with AES-256-GCM; values never cross the wire.
- Model loop with streaming, tool calling, approval escalation, and turn and
  tool-call budgets. Reasoning-model round trip preserves `reasoning_content`.
- Agent memory (per-agent facts with ranked recall) and a per-origin credential
  vault with an exact scheme + host + port matcher.
- Scheduled and webhook automations, MCP (stdio/HTTP/SSE), a real-Chromium
  browser with deny-by-default egress, macOS Messages via a read-only handle,
  sandboxed canvas artifacts, and pluggable engines (Claude Code, Codex,
  OpenCode) alongside any OpenAI-compatible endpoint.

### Clients

- Desktop (Electron 38): embedded host, hardened window
  (`contextIsolation`, `sandbox`, no `nodeIntegration`), sidebar + thread +
  pinned approvals, live agent-list fan-out.
- Mobile (React Native + Expo): pair, watch agents, read transcripts, see
  approvals. Verified on an iPhone simulator against a real host, end to end.
- Landing page with a waitlist; the hosted agent service is built but switched
  off (no billing yet), which the docs say plainly.

### Verification

- 852 tests across 55 files, all passing, plus a 4-test live-model suite that
  drives the real host, tools and client against a real model.
- Security invariants are tests, not promises; see `SECURITY.md`. Known
  limitations (per-tool approval, one shared workspace jail, unencrypted
  transcripts, no per-agent cost budget) are listed there, not hidden.

[Unreleased]: https://github.com/guhcostan/guhbot
