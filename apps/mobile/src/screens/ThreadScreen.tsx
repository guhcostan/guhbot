import type { Entry } from '@guhbot/protocol';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useEffect, useRef, type ReactElement } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { ConnectionBanner } from '../components/ConnectionBanner.js';
import { NoticeCard } from '../components/NoticeCard.js';
import { Screen } from '../components/Screen.js';
import { clampText, shortTime } from '../core/format.js';
import { isPending, type TranscriptItem } from '../core/transcript.js';
import type { RootStackParamList } from '../navigation/types.js';
import { useAppState, useAppStore, useTranscriptState, useTranscriptStore } from '../state/provider.js';
import { colors, radius, spacing } from '../theme.js';

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
                  <Text style={styles.loadOlderText}>Load earlier messages</Text>
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
            <NoticeCard title="Nothing here yet" detail="This agent has no transcript entries. Send it something from the host to start." />
          )
        }
        renderItem={({ item }) => <TranscriptRow item={item} />}
      />
    </Screen>
  );
}

function TranscriptRow({ item }: { readonly item: TranscriptItem }): ReactElement {
  if (isPending(item)) {
    return <Bubble align="left" label="agent · streaming" body={`${item.text}▍`} />;
  }
  const entry: Entry = item.entry;
  const label = entry.toolName === null ? `${entry.role} · ${entry.kind}` : `${entry.role} · ${entry.kind} · ${entry.toolName}`;
  const align = entry.role === 'user' ? 'right' : 'left';
  const tone = entry.kind === 'error' ? styles.errorBubble : entry.role === 'user' ? styles.userBubble : null;
  return <Bubble align={align} label={`${label} · ${shortTime(entry.createdAt)}`} body={clampText(entry.content)} tone={tone} />;
}

function Bubble({
  align,
  label,
  body,
  tone,
}: {
  readonly align: 'left' | 'right';
  readonly label: string;
  readonly body: string;
  readonly tone?: StyleProp<ViewStyle> | null;
}): ReactElement {
  return (
    <View style={[styles.bubbleRow, align === 'right' ? styles.alignRight : null]}>
      <View style={[styles.bubble, tone ?? null]}>
        <Text style={styles.bubbleLabel}>{label}</Text>
        <Text style={styles.bubbleBody}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
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
  loadOlderText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.6 },
  bubbleRow: { alignItems: 'flex-start', marginBottom: spacing.md },
  alignRight: { alignItems: 'flex-end' },
  bubble: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: '92%',
    padding: spacing.md,
  },
  userBubble: { backgroundColor: colors.surfaceAlt, borderColor: colors.accent },
  errorBubble: { borderColor: colors.bad },
  bubbleLabel: { color: colors.muted, fontSize: 11, marginBottom: spacing.xs, textTransform: 'uppercase' },
  bubbleBody: { color: colors.text, fontSize: 14, lineHeight: 20 },
});
