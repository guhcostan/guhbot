import type { Agent } from '@guhbot/protocol';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useState, type ReactElement } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar, EmptyState } from '../components/Avatar.js';
import { ConnectionBanner } from '../components/ConnectionBanner.js';
import { NoticeCard } from '../components/NoticeCard.js';
import { Pill, type PillTone } from '../components/Pill.js';
import { Screen } from '../components/Screen.js';
import { capabilityFor } from '../core/capabilities.js';
import { ageLabel } from '../core/format.js';
import type { RootStackParamList } from '../navigation/types.js';
import { useAppState, useAppStore } from '../state/provider.js';
import { colors, fontSize, radius, spacing } from '../theme.js';

const STATUS_TONE: Readonly<Record<Agent['status'], PillTone>> = { active: 'good', paused: 'warn', archived: 'neutral' };

export function AgentsScreen(): ReactElement {
  const state = useAppState();
  const app = useAppStore();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [draftName, setDraftName] = useState('');

  const canCreate = capabilityFor(state.deviceClass, 'agents.create');
  const neverLoaded = state.loadedAt === null;

  const header = (
    <View>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>Your agents</Text>
        <Text style={styles.heroSub}>
          {state.agents.length === 0 ? 'Nothing running yet.' : `${state.agents.length} ${state.agents.length === 1 ? 'agent' : 'agents'} on this host.`}
        </Text>
      </View>
      <ConnectionBanner view={state.connection} onRetry={() => void app.reconnect()} />
      {state.problem === null ? null : (
        <NoticeCard
          tone={state.problem.needsHostMachine ? 'warn' : 'bad'}
          title={state.problem.title}
          detail={state.problem.detail}
          onDismiss={() => app.dismissProblem()}
        />
      )}

      {canCreate.allowed ? (
        <View style={styles.createCard}>
          <Text style={styles.label}>New agent</Text>
          <View style={styles.createRow}>
            <TextInput
              autoCapitalize="sentences"
              placeholder="Name it…"
              placeholderTextColor={colors.faint}
              style={[styles.input, styles.grow]}
              value={draftName}
              onChangeText={setDraftName}
            />
            <Pressable
              accessibilityRole="button"
              disabled={state.creatingAgent || draftName.trim().length === 0}
              onPress={() => {
                void app.createAgent(draftName.trim()).then((created) => {
                  if (created) setDraftName('');
                });
              }}
              style={({ pressed }) => [
                styles.createButton,
                pressed ? styles.pressed : null,
                state.creatingAgent || draftName.trim().length === 0 ? styles.disabled : null,
              ]}
            >
              {state.creatingAgent ? <ActivityIndicator color={colors.accentInk} /> : <Text style={styles.createText}>+ Create</Text>}
            </Pressable>
          </View>
        </View>
      ) : (
        // A phone cannot create an agent, and the UI says so instead of
        // offering a button that the host would refuse.
        <NoticeCard
          tone="warn"
          title={canCreate.title}
          detail={canCreate.detail}
          action={{
            label: 'How?',
            onPress: () =>
              Alert.alert(
                'Create agents on the host',
                'The desktop app and the CLI create agents on the host. This phone sees them as soon as it refreshes.',
              ),
          }}
        />
      )}
    </View>
  );

  return (
    <Screen>
      <FlatList
        contentContainerStyle={styles.content}
        data={state.agents}
        keyExtractor={(agent) => agent.id}
        ListHeaderComponent={header}
        ListEmptyComponent={
          neverLoaded && state.connection.busy ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.muted} />
              <Text style={styles.muted}>Loading agents from the host…</Text>
            </View>
          ) : (
            <EmptyState
              mark="✦"
              title={state.connection.state === 'unreachable' ? 'No agents to show' : 'No agents yet'}
              detail={
                state.connection.state === 'unreachable'
                  ? 'The host has not answered, so this list is empty rather than confirmed empty.'
                  : 'Create one on the host machine; a phone that paired over the network cannot create agents itself.'
              }
            />
          )
        }
        refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={() => void app.refresh()} tintColor={colors.muted} />}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate('Thread', { agentId: item.id, agentName: item.name })}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
          >
            <Avatar name={item.name} size={42} />
            <View style={styles.rowBody}>
              <View style={styles.rowHeader}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.unreadCount > 0 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{item.unreadCount > 99 ? '99+' : String(item.unreadCount)}</Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.rowMeta}>
                <Pill label={item.status} tone={STATUS_TONE[item.status]} />
                <Text style={styles.muted} numberOfLines={1}>
                  {item.model ?? 'host default'} · {ageLabel(item.updatedAt, Date.now())}
                </Text>
              </View>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl * 2 },
  hero: { marginBottom: spacing.md, marginTop: spacing.sm },
  heroTitle: { color: colors.text, fontSize: fontSize.hero, fontWeight: '800', letterSpacing: -0.4 },
  heroSub: { color: colors.muted, fontSize: fontSize.secondary, marginTop: 2 },
  loadingRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.lg },
  muted: { color: colors.muted, fontSize: 12.5, flexShrink: 1 },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.sm,
    padding: spacing.md,
  },
  rowBody: { flex: 1, gap: 6, minWidth: 0 },
  rowHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  name: { color: colors.text, flexShrink: 1, fontSize: 15.5, fontWeight: '700' },
  rowMeta: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  badge: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: spacing.sm, paddingVertical: 1 },
  badgeText: { color: colors.accentInk, fontSize: 11, fontWeight: '800' },
  chevron: { color: colors.faint, fontSize: 20, fontWeight: '400' },
  label: { color: colors.muted, fontSize: fontSize.eyebrow, fontWeight: '700', marginBottom: spacing.xs, textTransform: 'uppercase' },
  createCard: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  createRow: { flexDirection: 'row', gap: spacing.sm },
  grow: { flex: 1 },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  createButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  createText: { color: colors.accentInk, fontSize: 14.5, fontWeight: '800' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.45 },
});
