import type { ReactElement, ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ConnectionBanner } from '../components/ConnectionBanner.js';
import { NoticeCard } from '../components/NoticeCard.js';
import { Pill } from '../components/Pill.js';
import { Screen } from '../components/Screen.js';
import { describeEndpoint } from '../core/endpoint.js';
import { useAppState, useAppStore } from '../state/provider.js';
import { colors, radius, spacing } from '../theme.js';

export function SettingsScreen(): ReactElement {
  const state = useAppState();
  const app = useAppStore();
  const host = state.host;
  const status = state.hostStatus;

  const confirmUnpair = (): void => {
    Alert.alert(
      'Unpair this phone?',
      'The device token is deleted from this phone and the app returns to pairing. The device stays listed on the host until you revoke it there.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unpair', style: 'destructive', onPress: () => void app.unpair() },
      ],
    );
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <ConnectionBanner view={state.connection} onRetry={() => void app.reconnect()} />

        <Section title="This device">
          <Row label="Name" value={host?.deviceName ?? 'unknown'} />
          <Row label="Device id" value={state.deviceId ?? host?.deviceId ?? 'unknown'} />
          <Row label="Address" value={host === null ? 'not paired' : describeEndpoint(host)} />
          <View style={styles.pillRow}>
            <Pill label={state.deviceClass ?? 'unpaired'} tone={state.deviceClass === 'person' ? 'good' : 'neutral'} />
          </View>
          {state.deviceClass === 'background' ? (
            <Text style={styles.note}>
              A device that paired over the network holds the background class. It can read everything here; approving, starting runs and
              changing the host are refused by the host itself, and only the host machine can grant a device human presence.
            </Text>
          ) : null}
        </Section>

        <Section title="Host">
          {status === null ? (
            <Text style={styles.note}>{state.connection.ready ? 'Reading host status…' : 'Host status is unavailable while the phone is not connected.'}</Text>
          ) : (
            <>
              <Row label="Host id" value={status.hostId} />
              <Row label="Version" value={status.version} />
              <Row label="Mode" value={status.mode} />
              <Row label="Platform" value={status.platform} />
              <Row label="Port" value={String(status.port)} />
              <Row label="Addresses" value={status.addresses.length === 0 ? 'none advertised' : status.addresses.join(', ')} />
              <Row label="Inference" value={status.inferenceReady ? 'ready' : 'no model provider configured'} />
              <Row label="Started" value={status.startedAt} />
              {Object.entries(status.capabilities).length === 0 ? null : (
                <View style={styles.pillRow}>
                  {Object.entries(status.capabilities).map(([name, enabled]) => (
                    <Pill key={name} label={name} tone={enabled ? 'good' : 'neutral'} />
                  ))}
                </View>
              )}
            </>
          )}
        </Section>

        <Section title="Pairing">
          <Text style={styles.note}>
            If this phone is lost, revoke it on the host: the token stops working immediately. Unpairing here only deletes the token from this
            phone.
          </Text>
          <Pressable accessibilityRole="button" onPress={confirmUnpair} style={({ pressed }) => [styles.danger, pressed ? styles.pressed : null]}>
            <Text style={styles.dangerText}>Unpair this phone</Text>
          </Pressable>
        </Section>

        {state.problem === null ? null : (
          <NoticeCard
            tone={state.problem.needsHostMachine ? 'warn' : 'bad'}
            title={state.problem.title}
            detail={state.problem.detail}
            onDismiss={() => app.dismissProblem()}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  section: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    marginBottom: spacing.lg,
    padding: spacing.md,
  },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: spacing.xs },
  row: { flexDirection: 'row', gap: spacing.md, justifyContent: 'space-between' },
  rowLabel: { color: colors.muted, fontSize: 13 },
  rowValue: { color: colors.text, flexShrink: 1, fontSize: 13, textAlign: 'right' },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  note: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: spacing.xs },
  danger: {
    alignItems: 'center',
    borderColor: colors.bad,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
  },
  dangerText: { color: colors.bad, fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.6 },
});
