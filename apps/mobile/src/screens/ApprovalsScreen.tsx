import type { Approval } from '@guhbot/protocol';
import type { ReactElement } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '../components/Avatar';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { NoticeCard } from '../components/NoticeCard';
import { Pill } from '../components/Pill';
import { Screen } from '../components/Screen';
import { capabilityFor } from '../core/capabilities';
import { ageLabel, remainingLabel } from '../core/format';
import { useAppState, useAppStore } from '../state/provider';
import { colors, fontSize, radius, spacing } from '../theme';

export function ApprovalsScreen(): ReactElement {
  const state = useAppState();
  const app = useAppStore();

  const canResolve = capabilityFor(state.deviceClass, 'approvals.resolve');
  const nameOf = (agentId: string): string => state.agents.find((agent) => agent.id === agentId)?.name ?? agentId;

  return (
    <Screen>
      <FlatList
        contentContainerStyle={styles.content}
        data={state.approvals}
        keyExtractor={(approval) => approval.id}
        ListHeaderComponent={
          <View>
            <View style={styles.hero}>
              <Text style={styles.heroTitle}>Waiting on you</Text>
              <Text style={styles.heroSub}>
                {state.approvals.length === 0
                  ? 'Nothing parked right now.'
                  : `${state.approvals.length} ${state.approvals.length === 1 ? 'run is' : 'runs are'} parked until answered.`}
              </Text>
            </View>
            <ConnectionBanner view={state.connection} onRetry={() => void app.reconnect()} />
            {canResolve.allowed ? null : (
              // The honest version of "you cannot do this here", shown before
              // the buttons rather than after a failed tap.
              <NoticeCard
                tone="warn"
                title={canResolve.title}
                detail={`${canResolve.detail} Until then this screen is read-only: you can see what an agent is waiting for, and answer it on the host.`}
              />
            )}
            {state.problem === null ? null : (
              <NoticeCard
                tone={state.problem.needsHostMachine ? 'warn' : 'bad'}
                title={state.problem.title}
                detail={state.problem.detail}
                onDismiss={() => app.dismissProblem()}
              />
            )}
          </View>
        }
        ListEmptyComponent={
          state.loadedAt === null && state.connection.busy ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.muted} />
              <Text style={styles.muted}>Asking the host…</Text>
            </View>
          ) : (
            <NoticeCard
              tone={state.connection.state === 'unreachable' ? 'bad' : 'info'}
              title={state.connection.state === 'unreachable' ? 'Could not read the approval queue' : 'All clear'}
              detail={
                state.connection.state === 'unreachable'
                  ? 'This list is empty because the host did not answer, not because nothing is pending. Reconnect and pull to refresh.'
                  : 'No agent is waiting on a human decision right now.'
              }
              {...(state.connection.state === 'unreachable' ? { action: { label: 'Try again', onPress: () => void app.refresh() } } : {})}
            />
          )
        }
        refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={() => void app.refresh()} tintColor={colors.muted} />}
        renderItem={({ item }) => (
          <ApprovalRow
            approval={item}
            agentName={nameOf(item.agentId)}
            canResolve={canResolve.allowed}
            busy={state.resolvingApprovalId === item.id}
            onResolve={(granted) => void app.resolveApproval(item.id, granted)}
          />
        )}
      />
    </Screen>
  );
}

function ApprovalRow({
  approval,
  agentName,
  canResolve,
  busy,
  onResolve,
}: {
  readonly approval: Approval;
  readonly agentName: string;
  readonly canResolve: boolean;
  readonly busy: boolean;
  readonly onResolve: (granted: boolean) => void;
}): ReactElement {
  const detail = approval.detail.trim();
  const showDetail = detail.length > 2 && detail !== '{}' && detail.length <= 600;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Avatar name={agentName} size={32} />
        <View style={styles.cardTitle}>
          <Text style={styles.agent} numberOfLines={1}>
            {agentName}
          </Text>
          <Text style={styles.time}>
            asked {ageLabel(approval.createdAt, Date.now())}
            {approval.expiresAt === null ? '' : ` · expires ${remainingLabel(approval.expiresAt, Date.now())}`}
          </Text>
        </View>
        <Pill label={approval.kind} tone="warn" />
      </View>
      <Text style={styles.summary}>{approval.summary}</Text>
      {showDetail ? <Text style={styles.detail}>{detail}</Text> : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={!canResolve || busy}
          onPress={() => onResolve(true)}
          style={({ pressed }) => [styles.grant, pressed ? styles.pressed : null, !canResolve || busy ? styles.disabled : null]}
        >
          {busy ? <ActivityIndicator color={colors.accentInk} /> : <Text style={styles.grantText}>✓ Approve</Text>}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!canResolve || busy}
          onPress={() => onResolve(false)}
          style={({ pressed }) => [styles.deny, pressed ? styles.pressed : null, !canResolve || busy ? styles.disabled : null]}
        >
          <Text style={styles.denyText}>Deny</Text>
        </Pressable>
      </View>
      {canResolve ? null : <Text style={styles.muted}>Resolve this on the host machine.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl * 2 },
  hero: { marginBottom: spacing.md, marginTop: spacing.sm },
  heroTitle: { color: colors.text, fontSize: fontSize.hero, fontWeight: '800', letterSpacing: -0.4 },
  heroSub: { color: colors.muted, fontSize: fontSize.secondary, marginTop: 2 },
  muted: { color: colors.muted, fontSize: 12 },
  loadingRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.lg },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.warn,
    borderLeftWidth: 3,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  cardHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  cardTitle: { flex: 1, minWidth: 0 },
  agent: { color: colors.text, fontSize: 15, fontWeight: '700' },
  time: { color: colors.faint, fontSize: fontSize.meta, marginTop: 1 },
  summary: { color: colors.text, fontSize: fontSize.body, lineHeight: 20 },
  detail: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.sm,
    color: colors.muted,
    fontFamily: 'monospace',
    fontSize: 12,
    padding: spacing.sm,
  },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  grant: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  grantText: { color: colors.accentInk, fontSize: 14.5, fontWeight: '800' },
  deny: {
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  denyText: { color: colors.text, fontSize: 14.5, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
});
