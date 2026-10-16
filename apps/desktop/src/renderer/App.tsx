import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Approval, Entry, Run, RunStatus } from '@guhbot/protocol';
import { useHost } from './api.js';
import logo from './assets/mascot/logo.svg';
import keeperPerson from './assets/mascot/keeper-person.svg';
import keeperBackground from './assets/mascot/keeper-background.svg';
import keeperAsleep from './assets/mascot/keeper-asleep.svg';
import avatar1 from './assets/mascot/avatar-1.svg';
import avatar2 from './assets/mascot/avatar-2.svg';
import avatar3 from './assets/mascot/avatar-3.svg';
import avatar4 from './assets/mascot/avatar-4.svg';
import avatar5 from './assets/mascot/avatar-5.svg';
import avatar6 from './assets/mascot/avatar-6.svg';
import './App.css';

/**
 * The desktop UI: a premium chat surface in the style of agentes.chat / Grok.
 *
 * Layout: a quiet sidebar (which agents exist + how to reach them) and a
 * central thread (what the selected agent is saying + what waits on a human).
 * Approvals stay pinned above the thread because a parked run does nothing
 * until someone looks at it.
 */
export function App(): JSX.Element {
  const { state, selectAgent, sendPrompt, resolveApproval } = useHost();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [state.entries.length, state.activeAgentId]);

  const activeAgent = state.agents.find((a) => a.id === state.activeAgentId) ?? null;
  const activeRun = useMemo(() => latestRun(state.runs, state.activeAgentId), [state.runs, state.activeAgentId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return state.agents;
    return state.agents.filter(
      (a) => a.name.toLowerCase().includes(q) || (a.model ?? '').toLowerCase().includes(q),
    );
  }, [state.agents, query]);

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft('');
    void sendPrompt(text);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src={logo} alt="guhbot" />
          <span className="brand-version">{state.host?.version ?? '…'}</span>
        </div>

        <div className="conn">
          <span className={`conn-dot ${state.status === 'ready' ? 'on' : 'off'}`} />
          {state.status === 'ready' ? 'connected' : state.status}
          {state.deviceClass !== null ? <span className="conn-pill">{state.deviceClass}</span> : null}
        </div>

        {/*
          Keeper carries the authorization model, so it belongs here rather than
          only on the marketing site. A device with a person token sees both eyes
          open; a paired phone sees one, because it cannot act outward.
        */}
        <div className="keeper-row">
          <img className="keeper" src={keeperState(state.deviceClass, activeRun)} alt="" />
          <span className="keeper-note">{keeperNote(state.deviceClass, activeRun)}</span>
        </div>

        <label className="search">
          <span className="ic">⌕</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search agents…" aria-label="Search agents" />
        </label>

        <div className="side-label">
          Agents <em>{state.agents.length}</em>
        </div>
        <nav className="agent-list" aria-label="Agents">
          {filtered.length === 0 ? (
            <div className="muted">{state.agents.length === 0 ? 'No agents yet. Create one on the host.' : 'No match.'}</div>
          ) : (
            filtered.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => selectAgent(agent.id)}
                className={`agent-row ${agent.id === state.activeAgentId ? 'active' : ''}`}
              >
                <img className="avatar" src={avatarFor(agent.name)} alt="" />
                <span className="agent-meta">
                  <span className="agent-name">{agent.name}</span>
                  <span className="agent-sub">{agent.model ?? 'host default model'}</span>
                </span>
                {agent.unreadCount > 0 ? <span className="badge">{agent.unreadCount > 99 ? '99+' : agent.unreadCount}</span> : null}
                <span className={`status-dot ${agent.status}`} title={agent.status} />
              </button>
            ))
          )}
        </nav>

        <div className="side-foot">
          {state.host?.inferenceReady === false ? (
            <div className="host-card warn">
              No model configured. Start with <b>GUHBOT_BASE_URL</b> and <b>GUHBOT_MODEL</b> set.
            </div>
          ) : (
            <div className="host-card">
              {state.host?.mode ?? 'self-hosted'} · {Object.entries(state.host?.capabilities ?? {}).filter(([, v]) => v).length} capabilities on
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        {state.error !== null ? <div className="error-bar">{state.error}</div> : null}

        {state.approvals.length > 0 ? (
          <section className="approvals" aria-label="Pending approvals">
            {state.approvals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} onResolve={(g) => void resolveApproval(approval.id, g)} />
            ))}
          </section>
        ) : null}

        {activeAgent === null ? (
          <WelcomeState onPick={(id) => selectAgent(id)} agents={state.agents} />
        ) : (
          <>
            <header className="chat-header">
              <img className="avatar" src={avatarFor(activeAgent.name)} alt="" />
              <h2>{activeAgent.name}</h2>
              {activeAgent.model !== null ? <span className="model">{activeAgent.model}</span> : null}
              {activeRun !== null && (activeRun.status === 'running' || activeRun.status === 'waiting-approval' || activeRun.status === 'queued') ? (
                <span className={`run-pill ${activeRun.status === 'waiting-approval' ? 'waiting' : ''}`}>
                  <span className="pulse" />
                  {activeRun.status === 'waiting-approval' ? 'waiting on you' : activeRun.status}
                </span>
              ) : null}
            </header>

            <div className="thread" ref={threadRef}>
              <div className="thread-inner">
                {state.entries.length === 0 ? (
                  <ThreadEmpty agent={activeAgent} onSuggest={(t) => setDraft(t)} />
                ) : (
                  state.entries.map((entry) => <EntryView key={entry.id} entry={entry} />)
                )}
              </div>
            </div>

            <div className="composer-zone">
              <div className="composer">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={`Message ${activeAgent.name}…`}
                  rows={1}
                  aria-label="Message composer"
                />
                <button type="button" className="send-btn" onClick={submit} disabled={draft.trim().length === 0} aria-label="Send">
                  ↑
                </button>
              </div>
              <div className="composer-hint">
                <kbd>Enter</kbd> to send · <kbd>Shift + Enter</kbd> for a new line
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/* — Approvals ——————————————————————————— */

function ApprovalCard({ approval, onResolve }: { approval: Approval; onResolve: (granted: boolean) => void }): JSX.Element {
  return (
    <div className="approval-card">
      <div className="approval-kind">⏸ {prettyKind(approval.kind)} · needs you</div>
      <div className="approval-summary">{approval.summary}</div>
      <div className="approval-actions">
        <button type="button" className="btn-approve" onClick={() => onResolve(true)}>
          Approve
        </button>
        <button type="button" className="btn-deny" onClick={() => onResolve(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

/* — Entries ————————————————————————————— */

function EntryView({ entry }: { entry: Entry }): JSX.Element {
  const [open, setOpen] = useState(false);
  const streaming = entry.id.startsWith('pending:');

  if (entry.kind === 'tool-call' || entry.kind === 'tool-result') {
    return (
      <div className={`tool-block ${entry.kind === 'tool-result' ? 'result' : ''}`}>
        <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className="arrow">{entry.kind === 'tool-call' ? '→' : '←'}</span>
          <span className="tname">{entry.toolName ?? 'tool'}</span>
          <span className="tkind">{entry.kind === 'tool-call' ? 'call' : 'result'} · {open ? 'hide' : 'show'}</span>
        </button>
        {open || streaming ? <pre className="tool-body">{truncate(entry.content, 4000)}</pre> : null}
      </div>
    );
  }

  const who = entry.role === 'user' ? 'user' : entry.role === 'system' ? 'system' : 'agent';
  const failed = entry.kind === 'error';
  return (
    <div className={`msg ${who}`}>
      {who === 'agent' ? (
        <span className="avatar" style={{ background: 'linear-gradient(150deg,#7defb0,#2f9c6a)' }}>
          ✦
        </span>
      ) : null}
      <div style={{ maxWidth: who === 'user' ? '78%' : '100%', flex: who === 'user' ? undefined : 1 }}>
        <div className={`bubble ${streaming ? 'streaming' : ''}`} style={failed ? { borderColor: '#5a2a24' } : undefined}>
          {entry.content}
          {streaming ? <span className="cursor">▍</span> : null}
        </div>
        <div className="msg-meta">
          {who} · {formatTime(entry.createdAt)}
        </div>
      </div>
    </div>
  );
}

/* — Empty states ———————————————————————— */

function ThreadEmpty({ agent, onSuggest }: { agent: Agent; onSuggest: (t: string) => void }): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-mark">✦</div>
      <h2>Talk to {agent.name}</h2>
      <p>Give it real work. Anything that spends, sends or changes the outside world waits for your yes.</p>
      <div className="suggestions">
        <button type="button" className="suggestion" onClick={() => onSuggest('Summarize what changed in the workspace today.')}>
          <b>Summarize the day</b>
          <span>Read the workspace and report back.</span>
        </button>
        <button type="button" className="suggestion" onClick={() => onSuggest('Check my inbox and draft replies, but do not send anything.')}>
          <b>Triage my inbox</b>
          <span>Drafts only — sending needs approval.</span>
        </button>
        <button type="button" className="suggestion" onClick={() => onSuggest('Look for failing tests and propose a fix.')}>
          <b>Find failing tests</b>
          <span>Inspect, explain, then ask before editing.</span>
        </button>
      </div>
    </div>
  );
}

function WelcomeState({ agents, onPick }: { agents: Agent[]; onPick: (id: string) => void }): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-mark">✦</div>
      <h2>Your agents live here</h2>
      <p>Pick one from the sidebar to see its thread. Runs stream in live, approvals park at the top.</p>
      {agents.length > 0 ? (
        <div className="suggestions">
          {agents.slice(0, 3).map((a) => (
            <button key={a.id} type="button" className="suggestion" onClick={() => onPick(a.id)}>
              <b>{a.name}</b>
              <span>{a.model ?? 'host default model'}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* — Helpers (why: deterministic presentation, no network, no deps) ——————— */

function latestRun(runs: Record<string, Run>, agentId: string | null): Run | null {
  if (agentId === null) return null;
  let best: Run | null = null;
  for (const run of Object.values(runs)) {
    if (run.agentId !== agentId) continue;
    if (best === null || run.startedAt > best.startedAt) best = run;
  }
  return best;
}

/**
 * Pick an avatar from the agent's name.
 *
 * Deterministic on purpose: the same agent must keep the same face across
 * restarts, or the sidebar becomes unreadable. Six hues, all the same character.
 */
export function avatarFor(name: string): string {
  const pool = [avatar1, avatar2, avatar3, avatar4, avatar5, avatar6];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 100_000;
  }
  return pool[hash % pool.length] ?? avatar1;
}

/**
 * Statuses that mean a run is still in flight. A run that has reached a terminal
 * status is over, even though its row stays in the store.
 */
const LIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting-approval'];

function runInFlight(run: Run | null): boolean {
  return run !== null && LIVE_RUN_STATUSES.includes(run.status);
}

/**
 * Which Keeper to draw, and it is not decoration: the state is the authorization
 * model, and it has to agree with the three states the landing page advertises.
 * Both eyes open while a human-backed device has a run in flight, one eye for a
 * device that may only watch, and closed when nothing is running at all.
 */
export function keeperState(deviceClass: 'person' | 'background' | null, run: Run | null): string {
  if (!runInFlight(run)) return keeperAsleep;
  return deviceClass === 'person' ? keeperPerson : keeperBackground;
}

export function keeperNote(deviceClass: 'person' | 'background' | null, run: Run | null): string {
  if (deviceClass !== 'person') return 'A paired device. It can watch, and cannot act outward.';
  if (run !== null && run.status === 'waiting-approval') return 'Waiting on your approval.';
  if (runInFlight(run)) return 'Working.';
  return 'You are here, so this device can act. Nothing is running.';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return (parts[0]?.slice(0, 2) ?? '·').toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
}

/** Stable pastel gradient per name, so avatars are distinguishable without images. */
function avatarGradient(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(150deg, hsl(${h} 60% 72%), hsl(${(h + 40) % 360} 55% 52%))`;
}

function prettyKind(kind: Approval['kind']): string {
  return kind.replace(/-/g, ' ');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
