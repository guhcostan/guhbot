# guhbot

An open-source agent host you run yourself. Agents do real work on your computer,
keep going when you close the laptop, and you drive them from your desktop or
your phone.

This is a from-scratch TypeScript implementation, informed by a reverse-engineering
study of a commercial product in this space. See [`docs/re/`](docs/re/00-index.md)
for that study, including its limits and its legal posture.

## The idea in one paragraph

Most "AI agent" products are a chat box that forgets you. This one treats an
agent as a **coworker with a host**: a long-lived process that holds the
transcript, the tools, the credentials and the schedule. Clients are thin. Your
desktop and your phone both connect to the same host, over the same protocol, and
see the same work. Because the host is a plain server, it can run on your laptop
or in a hosted service without either client knowing the difference.

## Why it is safe to leave running

An always-on agent that you can also reach from a phone has an obvious problem:
anything reachable from a phone is reachable by whoever holds the phone.

The answer is to classify **every** RPC method as one of two things:

- **`background`** — safe with nobody watching. Reading a transcript, checking
  status, listing tools.
- **`person`** — needs a human present. Sending a prompt, resolving an approval,
  writing a secret, creating an agent.

A phone that pairs over the network is **always** `background` class and cannot
promote itself. That is enforced in the dispatcher, next to the method table
rather than in a client, so a client bug cannot escalate. It is also why a run
that needs a decision parks in `waiting-approval` instead of guessing: the phone
sees the request and tells you, and you resolve it where you are.

## Layout

```
packages/protocol    The wire contract. Depends on zod and nothing else.
packages/host-core   Durable runtime: agents, transcripts, runs, approvals,
                     devices, encrypted secrets, and the authorization decision.
packages/agent       The model loop: streaming inference, tool calling,
                     approvals, and the built-in tools.
packages/server      WebSocket transport, pairing, event fan-out, client SDK.
apps/desktop         Electron client with an embedded host.
```

Planned and in progress, following the same seams:
`packages/mcp`, `packages/browser`, `packages/exec`, `packages/canvas`,
`packages/voice`, `packages/messages`, `packages/vnc`, `apps/mobile`, `apps/cloud`.

## Quick start

Requires Node 22.5 or newer (24+ recommended; `node:sqlite` is used, so there is
no native module to build).

```bash
pnpm install
pnpm -r --filter './packages/**' build
pnpm test
```

Run a host on this machine only:

```bash
node packages/server/dist/cli.js --data-dir ~/.guhbot
```

Run one that your phone can reach, with a model configured:

```bash
GUHBOT_API_KEY=sk-... node packages/server/dist/cli.js \
  --lan \
  --base-url https://api.openai.com/v1 \
  --model gpt-4o-mini
```

Then press Enter to mint a pairing code. The host prints a `guhbot://pair?...`
URI; a client that scans it knows where to connect and what code to redeem.

The CLI is the fastest way to see it work. A host with no model configured still
starts, still serves transcripts, and reports `inferenceReady: false` so clients
can explain why runs are unavailable.

## How a client connects

```ts
import { GuhbotClient } from '@guhbot/server';

const client = new GuhbotClient({ url: 'ws://127.0.0.1:8787/rpc', token });
await client.connect();

client.on('transcript.appended', ({ entry }) => render(entry));
client.on('transcript.delta', (delta) => appendToStreamingEntry(delta));

await client.request('runs.start', { agentId, prompt: 'Triage my inbox' });
```

`GuhbotClient` is written against the standard `WebSocket` global, so the same
file runs in Node, a browser and React Native.

## Design decisions worth knowing

**One protocol, two transports, one code path.** The desktop renderer talks to
its own embedded host over a loopback WebSocket, exactly as a phone does. It
could have used an in-process channel; using the socket instead means the desktop
and mobile clients cannot drift apart, and a renderer compromise has the same
reach as a remote device rather than more.

**The protocol registry is the source of truth.** Every method declares its
authorization class, input schema, output schema and summary in one table.
Dispatch validates against it in a fixed order: method exists → transport allowed
→ params valid → authorization class → handler → **output matches its own
schema**. That last step means a buggy handler cannot leak a shape clients cannot
parse.

**Capabilities compose; they do not patch the runtime.** A capability package
contributes tools, RPC methods and status flags through one interface
(`packages/agent/src/capability.ts`) and never edits `host-core` or `protocol`.
Contributions are checked for name collisions against core methods, so a
third-party package cannot redefine `approvals.resolve`.

**Secrets are sealed and write-only.** Values are encrypted with AES-256-GCM
under a 0600 master key. There is deliberately no `secrets.get` RPC method: a
value is reachable only from inside a tool execution, never over the wire.

**Everything the model did is in the transcript.** Every utterance, tool call and
result becomes an append-only entry with a per-agent monotonic sequence. Deltas
are explicitly lossy; durable entries are always re-readable, which is what lets
a phone drop off the network mid-run and resync.

## Testing

```bash
pnpm test
```

The suites concentrate on properties that would be dangerous to get wrong rather
than on coverage: a background device cannot resolve an approval; a phone cannot
promote itself; a secret value never appears in a protocol response; a path
outside the working directory is refused, including through a symlink; a
capability cannot shadow a core method; the OpenAI-compatible adapter is driven
against a real SSE server so the wire format is genuinely exercised.

`pnpm test` builds first. Tests resolve workspace packages through their built
`dist`, so running vitest alone can silently test stale code.

## Status

Working: the host runtime, the authorization model, the agent loop with tool
calling and approvals, the WebSocket transport with pairing, the shared client
SDK, and the built-in tools.

In progress: browser automation, MCP, and the mobile client.

Not started: voice, remote desktop, the hosted multi-tenant service.

Honest caveats: the agent loop has been verified against a scripted provider and
a real SSE server, but **not yet against a live model API**, because no
credentials were available in the environment where it was built. The desktop app
typechecks and its host bootstrap is tested; its window has not been launched in
a GUI session. See `docs/architecture.md` for the full status.

## Licence

Apache-2.0. See [`LICENSE`](LICENSE).
