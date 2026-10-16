# Parity tracker

Every capability that Grok Bot (the commercial product) and OpenMausBot (the
leading open-source alternative) have, mapped against guhbot. This is the working
list; work proceeds one line at a time.

Sources, so each row can be checked: Grok Bot's features come from the
reverse-engineering dossier in `docs/re/`, which is evidence-backed and marks its
own confidence. OpenMausBot's come from reading their public source. Neither is
copied.

**Legend** — ✅ works and is tested · ⚠️ partial · ❌ missing · 🅿️ in progress

## Engines

How an agent actually runs. This is the adoption gate: a person who already pays
for a subscription should not need an API key.

| Capability | Grok Bot | MausBot | guhbot |
|---|---|---|---|
| Own model loop, any OpenAI-compatible endpoint | ✅ | ✅ | ✅ |
| Claude Code as an engine | — | ✅ | ✅ |
| Codex as an engine | — | ✅ | ✅ |
| OpenCode as an engine | — | ✅ | ✅ |
| Generic CLI engine from an argv template | — | ✅ | ✅ |
| Engine probing: installed / version / blocked | — | ✅ | ✅ |
| Per-agent model choice | ✅ | ✅ | ✅ |
| Cost reporting per run | ✅ | ✅ | ❌ |

## The agent itself

| Capability | Grok Bot | MausBot | guhbot |
|---|---|---|---|
| Long-lived agents with their own instructions | ✅ | ✅ | ✅ |
| Streaming responses | ✅ | ✅ | ✅ |
| Tool calling | ✅ | ✅ | ✅ |
| Approval before a consequential action | ✅ | ✅ | ✅ |
| Many agents in one thread, passing work | ✅ | ✅ | ⚠️ protocol only |
| Transcript with resync after a disconnect | ✅ | ✅ | ✅ |
| Subagents / async tasks | ✅ | ✅ | ❌ |
| Memory that persists and improves across runs | ✅ | ✅ | ❌ |

## Local execution

| Capability | Grok Bot | MausBot | guhbot |
|---|---|---|---|
| Read/write files in a jail | ✅ | ✅ | ✅ |
| Run commands, no shell | ✅ | ✅ | ✅ |
| Path traversal and symlink refusal | ✅ | ✅ | ✅ |
| Per-command allow/deny policy | ✅ | ✅ | ⚠️ deny list only |
| Per-tool permission modes | ✅ | ✅ | ⚠️ binary only |
| Computer use: click, type, screenshot | ✅ | ✅ | ❌ |
| Isolated VM per agent | ✅ | ✅ | ❌ |

## Web

| Capability | Grok Bot | MausBot | guhbot |
|---|---|---|---|
| Drive a real browser | ✅ | ✅ | ✅ |
| Egress denied by default, allow list | ✅ | ✅ | ✅ |
| Search | ✅ | ✅ | ✅ (operator-supplied endpoint) |
| Sign in to sites on the user's behalf | ✅ | ✅ | ❌ |
| Cookie import, per-origin approval | ✅ | ✅ | ❌ |
| Passkey / WebAuthn ceremonies | ✅ | ✅ | ❌ |

## Integrations

| Capability | Grok Bot | MausBot | guhbot |
|---|---|---|---|
| MCP client (stdio, HTTP, SSE) | ✅ | ✅ | ✅ |
| MCP apps in a sandboxed frame | ✅ | — | ❌ |
| Serve MCP (be a server, not only a client) | ✅ | ✅ | ❌ |
| macOS Messages / iMessage | ✅ | — | ✅ |
| Gmail, Slack, Notion, Linear | ✅ | ✅ via Composio | ❌ |
| GitHub | ✅ | ✅ | ❌ |

## Output the user can look at

| Capability | Grok Bot | MausBot | guhbot |
|---|---|---|---|
| Artifacts | ✅ | ✅ | ✅ |
| Canvas: rendered HTML with a per-document CSP | ✅ | ✅ | ✅ |
| Document rendering (PDF, XLSX, DOCX) | ✅ | ✅ | ❌ |
| Live screen preview of the agent's computer | ✅ | ✅ | ❌ |
| Remote desktop (VNC) | ✅ | ✅ | ❌ |
| Voice calls | ✅ | ⚠️ voice notes | ❌ |
| Text to speech / transcription | ✅ | ✅ | ❌ |

## Working while you are not there

| Capability | Grok Bot | MausBot | guhbot |
|---|---|---|---|
| Scheduled automations | ✅ | ✅ | ✅ |
| Webhook-triggered automations | ✅ | ✅ | ✅ |
| Cron with correct DST and catch-up | ✅ | ✅ | ✅ |
| Teach once, replay as a routine | ✅ | ✅ | ⚠️ protocol only |
| Always-on cloud box | ✅ | ✅ | ❌ |
| Runs resume after a crash | ✅ | ✅ | ✅ (fail cleanly) |

## Clients

| Capability | Grok Bot | MausBot | guhbot |
|---|---|---|---|
| Desktop app | ✅ | ✅ | ✅ |
| Mobile app | ✅ | ✅ | ⚠️ unrun on device |
| Reachable from a phone off your network | ✅ | ✅ | ✅ |
| Pairing by code or QR | ✅ | ✅ | ✅ |
| Signed, notarised installers | ✅ | ✅ | ❌ |
| Docker deployment | — | ✅ | ❌ |

## Security and trust

This is where we are ahead, and it is worth keeping it that way as the rest
lands.

| Property | Grok Bot | MausBot | guhbot |
|---|---|---|---|
| Per-method authorization class enforced in the dispatcher | ⚠️ different mechanism | ❌ | ✅ |
| A paired device cannot promote itself | ❌ | ❌ | ✅ tested |
| No way to read a secret back over the wire | ❌ | ❌ | ✅ tested |
| Output validated against the method's own schema | ❌ | ❌ | ✅ |
| Capabilities cannot shadow core methods | ❌ | ❌ | ✅ tested |
| Runtime never binds a network socket | ❌ | ✅ sidecar | ✅ sidecar |
| DNS-rebinding defence on the local API | ❌ | ✅ | ✅ tested |
| Egress denied by default | ⚠️ | ❌ | ✅ tested |
| Secrets sealed at rest under a 0600 key | ⚠️ | ❌ | ✅ tested |

## What is left, in the order it should be done

1. ~~**Engines**~~ — done. `guhbot-host --list-engines` probes what is installed
   and reports rate limits honestly; `--engine codex` (or claude-code, opencode)
   runs agents through a subscription the user already pays for.
2. **Routines** — the protocol methods exist and nothing implements them. "Show
   the bot how you do it once" is the single most-praised Grok Bot feature.
3. ~~**Wire the companion**~~ — done, by embedding it in the host process so it
   reaches the device table directly: `--companion` binds the network, and
   `--companion-insecure-plaintext` is required to acknowledge what that means.
   A second process would have needed an RPC that hands one process another's
   authentication decision, or a second opener of `data.db`.
4. **Sign-in on the user's behalf** — cookies, per-origin approval, WebAuthn.
   This is what makes an agent able to work in the tools you actually use, and it
   is the largest remaining gap.
4. **Signed installers** — the difference between a project people star and one
   they use. Needs a certificate, not just code.
5. **Computer use and the live screen** — click, type, screenshot, watch.
6. **Voice** — calls and transcription.
7. **MCP apps and serving MCP.**
8. **Connected apps** — Gmail, Slack, GitHub, Notion. Composio is one route;
   direct integrations are another.
9. **Memory** — agents that get better instead of starting cold.
10. **Evals** — measure whether the agent is any good, not only whether the code
    is correct.
11. **Docker and a hosted deployment for 24/7** — the part AWS is for.
12. **VNC / remote desktop.**
13. **Document rendering** — PDF, XLSX, DOCX.
