import type { Entry } from '@guhbot/protocol';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useEffect, useRef, type ReactElement } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { EmptyState } from '../components/Avatar';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { NoticeCard } from '../components/NoticeCard';
import { Screen } from '../components/Screen';
import { shortTime } from '../core/format';
import { isPending, type TranscriptItem } from '../core/transcript';
import type { RootStackParamList } from '../navigation/types';
import { useAppState, useAppStore, useTranscriptState, useTranscriptStore } from '../state/provider';
import { colors, fontSize, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Thread'>;

export function ThreadScreen({ route }: Props): ReactElement {
  const { agentId } = route.params;
  const appState = useAppState();
  const app = useAppStore();
  const transcript = useTranscriptState();
  const store = useTranscriptStore();
  const list = useRef<FlatList<TranscriptItem>>(null);
  const lastCount = useRef(0);

  useEffect(() => {
    void store.open(agentId);
    return () => {
      store.close();
      lastCount.current = 0;
    };
  }, [agentId, store]);

  useEffect(() => {
    const grew = transcript.items.length > lastCount.current;
    lastCount.current = transcript.items.length;
    if (!grew) return;
    // Follow the stream, but only when something new arrived.
    const timer = setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(timer);
  }, [transcript.items.length]);

  return (
    <Screen>
      <FlatList
        ref={list}
        contentContainerStyle={styles.content}
        data={transcript.items}
        keyExtractor={(item) => String(item.type === 'final' ? item.entry.seq : item.seq)}
        ListHeaderComponent={
          <View>
            <ConnectionBanner view={appState.connection} onRetry={() => void app.reconnect()} />
            {transcript.resyncing ? (
              <View style={styles.resyncRow}>
                <ActivityIndicator color={colors.muted} />
                <Text style={styles.muted}>Updating the transcript…</Text>
              </View>
            ) : null}
            {transcript.problem === null ? null : (
              <NoticeCard
                tone={transcript.problem.retryable ? 'warn' : 'bad'}
                title={transcript.problem.title}
                detail={transcript.problem.detail}
              />
            )}
            {transcript.canLoadOlder ? (
              <Pressable
                accessibilityRole="button"
                disabled={transcript.loadingOlder}
                onPress={() => void store.loadOlder()}
                style={({ pressed }) => [styles.loadOlder, pressed ? styles.pressed : null]}
              >
                {transcript.loadingOlder ? (
                  <ActivityIndicator color={colors.muted} />
                ) : (
                  <Text style={styles.loadOlderText}>↑ Load earlier messages</Text>
                )}
              </Pressable>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          transcript.status === 'loading' ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.muted} />
              <Text style={styles.muted}>Loading the transcript…</Text>
            </View>
          ) : transcript.status === 'failed' ? (
            <NoticeCard
              tone="bad"
              title="The transcript did not load"
              detail="Ask the host for this agent's transcript again."
              action={{ label: 'Retry', onPress: () => void store.open(agentId) }}
            />
          ) : (
            <EmptyState mark="✦" title="Nothing here yet" detail="This agent has no transcript entries. Send it something from the host to start." />
          )
        }
        refreshControl={
          <RefreshControl refreshing={appState.refreshing} onRefresh={() => void app.refresh()} tintColor={colors.muted} />
        }
        renderItem={({ item }) => <TranscriptRow item={item} />}
      />
    </Screen>
  );
}

function TranscriptRow({ item }: { readonly item: TranscriptItem }): ReactElement {
  if (isPending(item)) {
    return (
      <View style={styles.rowLeft}>
        <View style={[styles.bubble, styles.agentBubble]}>
          <Text style={styles.agentMark}>✦ agent · streaming</Text>
          <Text style={styles.agentBody}>
            {item.text}
            <Text style={styles.cursor}>▍</Text>
          </Text>
        </View>
      </View>
    );
  }
  const entry: Entry = item.entry;
  if (entry.kind === 'tool-call' || entry.kind === 'tool-result') {
    return (
      <View style={[styles.tool, entry.kind === 'tool-result' ? styles.toolResult : null]}>
        <Text style={styles.toolHead}>
          {entry.kind === 'tool-call' ? '→' : '←'} {entry.toolName ?? 'tool'}
        </Text>
        <Text style={styles.toolBody} numberOfLines={8}>
          {entry.content}
        </Text>
      </View>
    );
  }
  const isUser = entry.role === 'user';
  const isSystem = entry.role === 'system';
  if (isSystem) {
    return (
      <View style={styles.system}>
        <Text style={styles.systemText}>{entry.content}</Text>
      </View>
    );
  }
  return (
    <View style={isUser ? styles.rowRight : styles.rowLeft}>
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.agentBubble]}>
        {!isUser ? <Text style={styles.agentMark}>✦ agent · {shortTime(entry.createdAt)}</Text> : null}
        <Text style={isUser ? styles.userBody : styles.agentBody}>{entry.content}</Text>
        {isUser ? <Text style={styles.userMeta}>{shortTime(entry.createdAt)}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl * 2 },
  muted: { color: colors.muted, fontSize: 13 },
  loadingRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.lg },
  loadOlder: {
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.md,
    paddingVertical: spacing.sm,
  },
  loadOlderText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  resyncRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.lg },
  rowLeft: { alignItems: 'flex-start', marginBottom: spacing.md },
  rowRight: { alignItems: 'flex-end', marginBottom: spacing.md },
  bubble: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, maxWidth: '88%', padding: spacing.md },
  userBubble: { backgroundColor: colors.surfaceRaised, borderColor: colors.borderSoft, borderBottomRightRadius: 5 },
  agentBubble: { backgroundColor: colors.surface, borderColor: colors.borderSoft, borderBottomLeftRadius: 5 },
  agentMark: { color: colors.accent, fontSize: fontSize.meta, fontWeight: '700', marginBottom: spacing.xs },
  agentBody: { color: colors.text, fontSize: fontSize.body, lineHeight: 21 },
  userBody: { color: colors.text, fontSize: fontSize.body, lineHeight: 21 },
  userMeta: { color: colors.faint, fontSize: fontSize.meta, marginTop: spacing.xs, textAlign: 'right' },
  cursor: { color: colors.accent, fontWeight: '800' },
  tool: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.md,
    padding: spacing.sm,
  },
  toolResult: { borderStyle: 'dashed' },
  toolHead: { color: colors.muted, fontFamily: 'monospace', fontSize: 12, fontWeight: '700', marginBottom: 4 },
  toolBody: { color: colors.muted, fontFamily: 'monospace', fontSize: 12, lineHeight: 17 },
  system: {
    alignSelf: 'center',
    backgroundColor: 'transparent',
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderStyle: 'dashed',
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.md,
    maxWidth: '100%',
    padding: spacing.sm,
  },
  systemText: { color: colors.faint, fontSize: 12, textAlign: 'center' },
});
