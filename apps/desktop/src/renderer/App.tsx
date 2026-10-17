import type { JSX } from 'react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Approval, Entry, Run, RunStatus } from '@guhbot/protocol';
import {
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Link2,
  Menu,
  Monitor,
  Plus,
  Search,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
const RichText = lazy(() => import('./RichText.js'));
import { useHost } from './api.js';
import { HostDialogs } from './HostDialogs.js';
import avatar1 from './assets/mascot/guh.svg';
import avatar2 from './assets/mascot/peach.svg';
import avatar3 from './assets/mascot/mint.svg';
import keeperPerson from './assets/mascot/keeper-person.svg';
import keeperBackground from './assets/mascot/keeper-background.svg';
import keeperAsleep from './assets/mascot/keeper-asleep.svg';
import './App.css';
const avatar4 = avatar1,
  avatar5 = avatar2,
  avatar6 = avatar3;

export function App(): JSX.Element {
  const api = useHost();
  const { state, selectAgent, sendPrompt, resolveApproval, cancelRun } = api;
  const [dialog, setDialog] = useState<'agent' | 'devices' | 'connect' | null>(
    null,
  );
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [sending, setSending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [state.entries, state.activeAgentId]);
  const visibleAgents = useMemo(
    () => state.agents.filter((a) => !a.hidden),
    [state.agents],
  );
  const filtered = useMemo(
    () =>
      visibleAgents.filter((a) =>
        a.name.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [visibleAgents, query],
  );
  const active =
    visibleAgents.find((a) => a.id === state.activeAgentId) ?? null;
  const run = latestRun(state.runs, state.activeAgentId);
  const running = runInFlight(run);
  const operator = state.deviceClass === 'person';
  const ready = state.status === 'ready';
  const canSend =
    operator &&
    ready &&
    state.host?.inferenceReady === true &&
    active !== null &&
    !sending;
  const submit = (): void => {
    const text = draft.trim();
    if (!text || !canSend || running) return;
    setSending(true);
    void sendPrompt(text)
      .then(() =>
        setDraft((current) => (current.trim() === text ? '' : current)),
      )
      .catch(() => undefined)
      .finally(() => setSending(false));
  };
  const suggest = (text: string): void => {
    setDraft(text);
    composerRef.current?.focus();
  };
  return (
    <div className="shell">
      <a className="skip-link" href="#conversation">
        Skip to conversation
      </a>
      {sidebarOpen ? (
        <button
          className="sidebar-shade"
          type="button"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <img src={avatar1} width="36" height="36" alt="" />
          <span>guh bot</span>
          <button
            className="icon-button sidebar-close"
            type="button"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            <X />
          </button>
        </div>
        <div className="workspace-switch">
          <span className={`connection-dot ${ready ? 'online' : ''}`} />
          <span>
            {state.host?.mode === 'hosted'
              ? 'Hosted workspace'
              : 'Your workspace'}
          </span>
          <ChevronDown size={15} />
        </div>
        <button
          className="new-bot"
          type="button"
          disabled={!ready || !operator}
          onClick={() => setDialog('agent')}
        >
          <Plus size={19} />
          New bot
        </button>
        <label className="search">
          <Search size={18} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search bots…"
            aria-label="Search bots"
          />
        </label>
        <span className="sidebar-label">
          Your bots<span>{visibleAgents.length || ''}</span>
        </span>
        <nav className="agent-list" aria-label="Your bots">
          {filtered.map((agent) => (
            <button
              key={agent.id}
              className={`agent-item ${active?.id === agent.id ? 'selected' : ''}`}
              type="button"
              onClick={() => {
                selectAgent(agent.id);
                setSidebarOpen(false);
              }}
            >
              <img src={avatarFor(agent.name)} width="31" height="31" alt="" />
              <span>{agent.name}</span>
              {agent.unreadCount ? <em>{agent.unreadCount}</em> : null}
            </button>
          ))}
          {filtered.length === 0 ? (
            <p className="sidebar-empty">
              {query
                ? 'No matching bots.'
                : ready
                  ? 'Make room for your first bot.'
                  : 'Connect a host to find your bots.'}
            </p>
          ) : null}
        </nav>
        <div className="sidebar-bottom">
          <button type="button" onClick={() => setDialog('connect')}>
            <Link2 />
            Connect a host
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => setDialog('devices')}
          >
            <Monitor />
            Devices & pairing
          </button>
          <div className="workspace-note">
            <ShieldCheck />
            <span>
              {ready
                ? operator
                  ? 'Operator access'
                  : 'Viewing access'
                : state.status === 'connecting'
                  ? 'Connecting…'
                  : 'No host connected'}
            </span>
          </div>
        </div>
      </aside>
      <main className="main" id="conversation">
        <header className="chat-header">
          <button
            className="icon-button mobile-menu"
            type="button"
            aria-label="Open sidebar"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu />
          </button>
          {active ? (
            <>
              <img
                className="header-avatar"
                src={avatarFor(active.name)}
                width="40"
                height="40"
                alt=""
              />
              <div>
                <h1>{active.name}</h1>
                <p>{active.model ?? 'Your own AI teammate'}</p>
              </div>
            </>
          ) : (
            <div className="header-title">
              <h1>Your workspace</h1>
              <p>A little team of your own.</p>
            </div>
          )}
          <div className="header-status">
            <span className={`connection-dot ${ready ? 'online' : ''}`} />
            <span>
              {ready
                ? 'Connected'
                : state.status === 'connecting'
                  ? 'Connecting'
                  : 'Offline'}
            </span>
          </div>
        </header>
        {state.error ? (
          <div className="error-bar" role="alert">
            {state.error}
          </div>
        ) : null}
        {ready && !state.host?.inferenceReady ? (
          <div className="setup-banner">
            <Folder size={17} />
            <span>
              Connect an agent CLI or model endpoint to start working.
            </span>
            <a
              href="https://github.com/guhcostan/guhbot#quick-start"
              target="_blank"
              rel="noreferrer"
            >
              Setup guide
              <ArrowRight size={14} />
            </a>
          </div>
        ) : null}
        {!operator && ready ? (
          <div className="viewer-banner">
            You're viewing this workspace. An operator can grant access in
            Devices & pairing.
          </div>
        ) : null}
        {state.approvals.length ? (
          <section className="approvals" aria-label="Pending approvals">
            {state.approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                busy={!operator || state.resolvingApprovalId === approval.id}
                onResolve={(granted) =>
                  void resolveApproval(approval.id, granted)
                }
              />
            ))}
          </section>
        ) : null}
        <div className="thread" ref={threadRef}>
          {state.entries.length === 0 ? (
            <motion.div
              key={active?.id ?? 'welcome'}
              className="empty"
              initial={reducedMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
            >
              <img
                src={active ? avatarFor(active.name) : avatar1}
                width="90"
                height="90"
                alt=""
              />
              <h2>
                {active
                  ? 'What are we working on?'
                  : ready
                    ? 'Meet your first bot.'
                    : 'Your team starts here.'}
              </h2>
              {active ? (
                <div className="suggestions">
                  <button
                    type="button"
                    onClick={() =>
                      suggest('Summarize the notes in my workspace.')
                    }
                  >
                    <FileText />
                    Summarize my notes
                    <ArrowRight />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      suggest(
                        'Help me plan a project. Ask me what you need to know first.',
                      )
                    }
                  >
                    <Folder />
                    Help me plan a project
                    <ArrowRight />
                  </button>
                </div>
              ) : (
                <>
                  <p>
                    {ready
                      ? 'Give it a name, a role, and something worth doing.'
                      : 'Connect to Guh Bot on your computer or a host you manage.'}
                  </p>
                  <button
                    className="action-button primary-action"
                    type="button"
                    onClick={() =>
                      setDialog(ready && operator ? 'agent' : 'connect')
                    }
                  >
                    {ready && operator
                      ? 'Create your first bot'
                      : 'Connect a host'}
                    <ArrowRight size={17} />
                  </button>
                </>
              )}
            </motion.div>
          ) : (
            <div className="thread-inner">
              {state.entries.map((entry) => (
                <EntryView
                  key={entry.id}
                  entry={entry}
                  avatar={active ? avatarFor(active.name) : avatar1}
                  name={active?.name ?? 'Bot'}
                />
              ))}
              {running ? (
                <div className="working-status" role="status">
                  <span className="working-dot" />
                  {run?.status === 'waiting-approval'
                    ? 'Waiting for your approval'
                    : 'Working on it…'}
                </div>
              ) : null}
              {run?.status === 'failed' ? (
                <p className="run-error" role="alert">
                  {run.error ?? 'This task could not finish. Try again.'}
                </p>
              ) : null}
            </div>
          )}
        </div>
        <div className="composer-zone">
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={
                active
                  ? `Give ${active.name} something to do…`
                  : 'Create a bot to start a conversation…'
              }
              aria-label="Message composer"
              rows={1}
              disabled={!active || !operator || !ready}
            />
            {running ? (
              <button
                className="send-button stop-button"
                type="button"
                aria-label="Stop task"
                onClick={() => run && void cancelRun(run.id)}
              >
                <Square size={17} />
              </button>
            ) : (
              <button
                className="send-button"
                type="submit"
                disabled={!canSend || !draft.trim()}
                aria-label="Send"
              >
                <ArrowUp size={22} />
              </button>
            )}
          </form>
          <p className="composer-caption">
            Your workspace. Your models. Your call.
          </p>
        </div>
      </main>
      {dialog ? (
        <HostDialogs kind={dialog} api={api} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function ApprovalCard({
  approval,
  busy,
  onResolve,
}: {
  approval: Approval;
  busy: boolean;
  onResolve: (granted: boolean) => void;
}): JSX.Element {
  return (
    <article className="approval-card">
      <div className="approval-copy">
        <span className="approval-label">
          <ShieldCheck size={15} />
          Your approval, please
        </span>
        <strong>{approval.summary}</strong>
        <small>
          Requested {ageLabel(approval.createdAt, Date.now())}
          {approval.expiresAt
            ? ` · expires ${remainingLabel(approval.expiresAt, Date.now())}`
            : ''}
        </small>
      </div>
      <div className="approval-actions">
        <button
          className="btn-deny"
          type="button"
          disabled={busy}
          onClick={() => onResolve(false)}
        >
          Deny
        </button>
        <button
          className="btn-approve"
          type="button"
          disabled={busy}
          onClick={() => onResolve(true)}
        >
          <Check size={15} />
          Approve
        </button>
      </div>
    </article>
  );
}
function EntryView({
  entry,
  avatar,
  name,
}: {
  entry: Entry;
  avatar: string;
  name: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  if (entry.kind === 'tool-call' || entry.kind === 'tool-result')
    return (
      <div className="tool-block">
        <button
          type="button"
          className="tool-head"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight className={open ? 'rotated' : ''} size={15} />
          <span>
            {entry.toolName ?? 'Tool'}
            <small>{entry.kind === 'tool-call' ? 'Requested' : 'Result'}</small>
          </span>
        </button>
        {open ? (
          <pre className="tool-body">{truncate(entry.content, 6000)}</pre>
        ) : null}
      </div>
    );
  const user = entry.role === 'user';
  const system = entry.role === 'system';
  return (
    <article
      className={`message ${user ? 'user-message' : system ? 'system-message' : 'bot-message'} ${entry.kind === 'error' ? 'message-error' : ''}`}
    >
      {!user && !system ? (
        <img src={avatar} width="32" height="32" alt="" />
      ) : null}
      <div className="message-content">
        {!user && !system ? <strong>{name}</strong> : null}
        <div className="markdown">
          <Suspense fallback={<p className="plain-message">{entry.content}</p>}>
            <RichText text={entry.content} />
          </Suspense>
          {entry.id.startsWith('pending:') ? (
            <span className="stream-cursor" />
          ) : null}
        </div>
        <small className="message-time">{formatTime(entry.createdAt)}</small>
      </div>
    </article>
  );
}

/* — Helpers (why: deterministic presentation, no network, no deps) ——————— */

function latestRun(
  runs: Record<string, Run>,
  agentId: string | null,
): Run | null {
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
const LIVE_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting-approval',
];

function runInFlight(run: Run | null): boolean {
  return run !== null && LIVE_RUN_STATUSES.includes(run.status);
}

/**
 * Which Keeper to draw, and it is not decoration: the state is the authorization
 * model, and it has to agree with the three states the landing page advertises.
 * Both eyes open while a human-backed device has a run in flight, one eye for a
 * device that may only watch, and closed when nothing is running at all.
 */
export function keeperState(
  deviceClass: 'person' | 'background' | null,
  run: Run | null,
): string {
  if (!runInFlight(run)) return keeperAsleep;
  return deviceClass === 'person' ? keeperPerson : keeperBackground;
}

export function keeperNote(
  deviceClass: 'person' | 'background' | null,
  run: Run | null,
): string {
  if (deviceClass !== 'person')
    return 'A paired device. It can watch, and cannot act outward.';
  if (run !== null && run.status === 'waiting-approval')
    return 'Waiting on your approval.';
  if (runInFlight(run)) return 'Working.';
  return 'You are here, so this device can act. Nothing is running.';
}

function prettyKind(kind: Approval['kind']): string {
  return kind.replace(/-/g, ' ');
}

/* — Pure presentation helpers (no network, no deps, testable) ——————— */

export function ageLabel(iso: string, now: number): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return 'just now';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function remainingLabel(expiresAt: string, now: number): string {
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return 'soon';
  const ms = at - now;
  if (ms <= 0) return 'expired';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'under a minute';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

function truncate(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n… (${text.length - max} more chars)`
    : text;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
