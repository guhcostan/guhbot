import type { Approval } from '@guhbot/protocol';
import type { ReactElement } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { ConnectionBanner } from '../components/ConnectionBanner.js';
import { NoticeCard } from '../components/NoticeCard.js';
import { Pill } from '../components/Pill.js';
import { Screen } from '../components/Screen.js';
import { capabilityFor } from '../core/capabilities.js';
import { ageLabel, remainingLabel } from '../core/format.js';
import { useAppState, useAppStore } from '../state/provider.js';
import { colors, radius, spacing } from '../theme.js';

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
            <ConnectionBanner view={state.connection} onRetry={() => void app.reconnect()} />
            {canResolve.allowed ? (
              <Text style={styles.lead}>
                A run is parked until one of these is answered. Granting lets the run continue with the action it asked for.
              </Text>
            ) : (
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
              title={state.connection.state === 'unreachable' ? 'Could not read the approval queue' : 'Nothing waiting'}
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
        <Text style={styles.agent}>{agentName}</Text>
        <Pill label={approval.kind} tone="info" />
      </View>
      <Text style={styles.summary}>{approval.summary}</Text>
      {showDetail ? <Text style={styles.detail}>{detail}</Text> : null}
      <Text style={styles.muted}>
        asked {ageLabel(approval.createdAt, Date.now())}
        {approval.expiresAt === null ? '' : ` · expires ${remainingLabel(approval.expiresAt, Date.now())}`}
      </Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={!canResolve || busy}
          onPress={() => onResolve(true)}
          style={({ pressed }) => [styles.grant, pressed ? styles.pressed : null, !canResolve || busy ? styles.disabled : null]}
        >
          {busy ? <ActivityIndicator color={colors.background} /> : <Text style={styles.grantText}>Grant</Text>}
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
  content: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  lead: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: spacing.md },
  muted: { color: colors.muted, fontSize: 12 },
  loadingRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.lg },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  cardHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, justifyContent: 'space-between' },
  agent: { color: colors.text, flexShrink: 1, fontSize: 15, fontWeight: '600' },
  summary: { color: colors.text, fontSize: 14, lineHeight: 20 },
  detail: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.sm,
    color: colors.muted,
    fontFamily: 'monospace',
    fontSize: 12,
    padding: spacing.sm,
  },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  grant: { alignItems: 'center', backgroundColor: colors.good, borderRadius: radius.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  grantText: { color: colors.background, fontSize: 14, fontWeight: '700' },
  deny: {
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  denyText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
});
