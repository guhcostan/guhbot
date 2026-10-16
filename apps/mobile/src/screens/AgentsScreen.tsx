import type { Agent } from '@guhbot/protocol';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useState, type ReactElement } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';

import { ConnectionBanner } from '../components/ConnectionBanner.js';
import { NoticeCard } from '../components/NoticeCard.js';
import { Pill, type PillTone } from '../components/Pill.js';
import { Screen } from '../components/Screen.js';
import { capabilityFor } from '../core/capabilities.js';
import { ageLabel } from '../core/format.js';
import type { RootStackParamList } from '../navigation/types.js';
import { useAppState, useAppStore } from '../state/provider.js';
import { colors, radius, spacing } from '../theme.js';

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
        <View style={styles.createBlock}>
          <Text style={styles.label}>New agent</Text>
          <View style={styles.createRow}>
            <TextInput
              autoCapitalize="sentences"
              placeholder="Name"
              placeholderTextColor={colors.muted}
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
              {state.creatingAgent ? <ActivityIndicator color={colors.background} /> : <Text style={styles.createText}>Create</Text>}
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
            <NoticeCard
              tone={state.connection.state === 'unreachable' ? 'bad' : 'info'}
              title={state.connection.state === 'unreachable' ? 'No agents to show' : 'No agents yet'}
              detail={
                state.connection.state === 'unreachable'
                  ? 'The host has not answered, so this list is empty rather than confirmed empty. Bring the host back and pull to refresh.'
                  : 'This host has no agents. Create one on the host machine; a phone that paired over the network cannot create agents itself.'
              }
              {...(state.connection.state === 'unreachable' ? { action: { label: 'Try again', onPress: () => void app.refresh() } } : {})}
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
            <View style={styles.rowHeader}>
              <Text style={styles.name}>{item.name}</Text>
              {item.unreadCount > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{item.unreadCount > 99 ? '99+' : String(item.unreadCount)}</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.rowMeta}>
              <Pill label={item.status} tone={STATUS_TONE[item.status]} />
              <Text style={styles.muted}>{item.model ?? 'host default model'}</Text>
              <Text style={styles.muted}>{ageLabel(item.updatedAt, Date.now())}</Text>
            </View>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  loadingRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.lg },
  muted: { color: colors.muted, fontSize: 13 },
  name: { color: colors.text, flexShrink: 1, fontSize: 16, fontWeight: '600' },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  rowHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, justifyContent: 'space-between' },
  rowMeta: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  badge: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: spacing.sm, paddingVertical: 1 },
  badgeText: { color: colors.background, fontSize: 11, fontWeight: '700' },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: spacing.xs, textTransform: 'uppercase' },
  createBlock: { marginBottom: spacing.md },
  createRow: { flexDirection: 'row', gap: spacing.sm },
  grow: { flex: 1 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  createButton: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: radius.sm, justifyContent: 'center', paddingHorizontal: spacing.lg },
  createText: { color: colors.background, fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.5 },
});
