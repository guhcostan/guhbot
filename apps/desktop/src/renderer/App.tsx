import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Entry } from '@guhbot/protocol';
import { useHost } from './api.js';

/**
 * The desktop UI.
 *
 * Three things, in priority order: which agents exist, what the selected agent's
 * thread looks like, and what is waiting on a human decision. Approvals are
 * pinned at the top rather than buried in a menu, because a run that is parked
 * on an approval is doing nothing at all until someone looks at it.
 */
export function App(): JSX.Element {
  const { state, selectAgent, sendPrompt, resolveApproval } = useHost();
  const [draft, setDraft] = useState('');
  const threadRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest entry in view as the transcript grows.
  useEffect(() => {
    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [state.entries.length]);

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft('');
    void sendPrompt(text);
  };

  const activeAgent = state.agents.find((a) => a.id === state.activeAgentId) ?? null;

  return (
    <div style={styles.shell}>
      <aside style={styles.sidebar}>
        <div style={styles.brand}>
          guhbot
          <span style={styles.version}>{state.host?.version ?? ''}</span>
        </div>

        <div style={styles.connRow}>
          <span style={{ ...styles.dot, background: state.status === 'ready' ? '#2fbf71' : '#c9563f' }} />
          {state.status === 'ready' ? 'connected' : state.status}
          {state.deviceClass ? <span style={styles.pill}>{state.deviceClass}</span> : null}
        </div>

        <div style={styles.sectionLabel}>Agents</div>
        <nav>
          {state.agents.length === 0 ? (
            <div style={styles.muted}>No agents yet.</div>
          ) : (
            state.agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => selectAgent(agent.id)}
                style={{
                  ...styles.agentRow,
                  background: agent.id === state.activeAgentId ? '#1c2430' : 'transparent',
                }}
              >
                <span style={styles.agentName}>{agent.name}</span>
                {agent.unreadCount > 0 ? <span style={styles.badge}>{agent.unreadCount}</span> : null}
              </button>
            ))
          )}
        </nav>

        <div style={styles.footnote}>
          {state.host?.inferenceReady === false
            ? 'No model configured. Start with GUHBOT_BASE_URL and GUHBOT_MODEL set.'
            : `mode ${state.host?.mode ?? '-'}-hosted`}
        </div>
      </aside>

      <main style={styles.main}>
        {state.error !== null ? <div style={styles.errorBar}>{state.error}</div> : null}

        {state.approvals.length > 0 ? (
          <section style={styles.approvalBar}>
            {state.approvals.map((approval) => (
              <div key={approval.id} style={styles.approvalCard}>
                <div style={styles.approvalKind}>{approval.kind}</div>
                <div style={styles.approvalSummary}>{approval.summary}</div>
                <div style={styles.approvalActions}>
                  <button type="button" style={styles.grant} onClick={() => void resolveApproval(approval.id, true)}>
                    Approve
                  </button>
                  <button type="button" style={styles.deny} onClick={() => void resolveApproval(approval.id, false)}>
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </section>
        ) : null}

        <header style={styles.header}>
          <strong>{activeAgent?.name ?? 'No agent selected'}</strong>
          {activeAgent?.model ? <span style={styles.muted}> · {activeAgent.model}</span> : null}
        </header>

        <div style={styles.thread} ref={threadRef}>
          {state.entries.length === 0 ? (
            <div style={styles.muted}>
              {activeAgent === null ? 'Select an agent to see its thread.' : 'Nothing here yet.'}
            </div>
          ) : (
            state.entries.map((entry) => <EntryRow key={entry.id} entry={entry} />)
          )}
        </div>

        <footer style={styles.composer}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={activeAgent === null ? 'Select an agent first' : 'Give the agent a task…'}
            disabled={activeAgent === null}
            style={styles.textarea}
            rows={3}
          />
          <button type="button" onClick={submit} disabled={activeAgent === null || draft.trim().length === 0} style={styles.send}>
            Send
          </button>
        </footer>
      </main>
    </div>
  );
}

function EntryRow({ entry }: { entry: Entry }): JSX.Element {
  const label =
    entry.kind === 'tool-call'
      ? `→ ${entry.toolName ?? 'tool'}`
      : entry.kind === 'tool-result'
        ? `← ${entry.toolName ?? 'tool'}`
        : entry.role;

  const tone =
    entry.role === 'user'
      ? '#8ab4f8'
      : entry.role === 'tool'
        ? '#d0a24c'
        : entry.role === 'system'
          ? '#8b93a0'
          : '#e6e8ec';

  return (
    <article style={styles.entry}>
      <div style={{ ...styles.entryLabel, color: tone }}>{label}</div>
      <pre style={{ ...styles.entryBody, color: tone, opacity: entry.id.startsWith('pending:') ? 0.6 : 1 }}>
        {entry.content}
      </pre>
    </article>
  );
}

const styles = {
  shell: { display: 'flex', height: '100vh', background: '#0b0d10', color: '#e6e8ec', font: '13px/1.5 ui-sans-serif, system-ui, sans-serif' },
  sidebar: { width: 250, borderRight: '1px solid #1b2027', padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 10 },
  brand: { fontWeight: 600, fontSize: 15, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  version: { color: '#69707d', fontSize: 11, fontWeight: 400 },
  connRow: { display: 'flex', alignItems: 'center', gap: 6, color: '#9aa2ae', fontSize: 11 },
  dot: { width: 7, height: 7, borderRadius: 7, display: 'inline-block' },
  pill: { marginLeft: 'auto', background: '#1c2430', padding: '1px 6px', borderRadius: 4, fontSize: 10, color: '#9aa2ae' },
  sectionLabel: { marginTop: 8, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.7, color: '#69707d' },
  agentRow: { display: 'flex', width: '100%', border: 0, color: '#e6e8ec', textAlign: 'left', padding: '7px 8px', borderRadius: 6, cursor: 'pointer', font: 'inherit', alignItems: 'center', gap: 6 },
  agentName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  badge: { marginLeft: 'auto', background: '#8ab4f8', color: '#0b0d10', borderRadius: 9, padding: '0 6px', fontSize: 10, fontWeight: 600 },
  footnote: { marginTop: 'auto', color: '#69707d', fontSize: 10, lineHeight: 1.5 },
  main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  errorBar: { background: '#3a1d1a', color: '#f0b3a8', padding: '7px 12px', fontSize: 11, borderBottom: '1px solid #5a2a24' },
  approvalBar: { display: 'flex', gap: 8, padding: 10, overflowX: 'auto', borderBottom: '1px solid #1b2027', background: '#14181e' },
  approvalCard: { minWidth: 260, border: '1px solid #2b3644', borderRadius: 8, padding: 9, display: 'flex', flexDirection: 'column', gap: 6 },
  approvalKind: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6, color: '#d0a24c' },
  approvalSummary: { fontSize: 12, color: '#e6e8ec' },
  approvalActions: { display: 'flex', gap: 6, marginTop: 2 },
  grant: { background: '#2fbf71', border: 0, color: '#06130c', borderRadius: 5, padding: '4px 10px', cursor: 'pointer', font: 'inherit', fontWeight: 600 },
  deny: { background: 'transparent', border: '1px solid #3a4450', color: '#c9ced6', borderRadius: 5, padding: '4px 10px', cursor: 'pointer', font: 'inherit' },
  header: { padding: '10px 14px', borderBottom: '1px solid #1b2027', fontSize: 12 },
  thread: { flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 },
  entry: { display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 900 },
  entryLabel: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6, color: '#69707d' },
  entryBody: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', font: 'inherit' },
  composer: { display: 'flex', gap: 8, padding: 10, borderTop: '1px solid #1b2027' },
  textarea: { flex: 1, background: '#14181e', color: '#e6e8ec', border: '1px solid #262d36', borderRadius: 8, padding: 9, resize: 'none', font: 'inherit' },
  send: { background: '#8ab4f8', border: 0, color: '#0b0d10', borderRadius: 8, padding: '0 18px', cursor: 'pointer', font: 'inherit', fontWeight: 600 },
  muted: { color: '#69707d', fontSize: 12 },
} as const;
