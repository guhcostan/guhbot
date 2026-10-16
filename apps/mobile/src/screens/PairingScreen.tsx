import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';

import { describeEndpoint, parseEndpoint } from '../core/endpoint';
import { parsePairingUri } from '../core/pairing';
import { useAppState, useAppStore } from '../state/provider';
import { colors, fontSize, radius, spacing } from '../theme';
import { NoticeCard } from '../components/NoticeCard';
import { Screen } from '../components/Screen';

const CODE_PATTERN = /^\d{8}$/;

export function PairingScreen(): ReactElement {
  const state = useAppState();
  const app = useAppStore();
  // A scanned QR code arrives as guhbot://pair?... — expo-linking hands us the
  // URL for both the cold start and a warm foreground.
  const url = Linking.useURL();

  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [pairingId, setPairingId] = useState('');
  const [code, setCode] = useState('');
  const [linkDraft, setLinkDraft] = useState('');
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const applyLink = useCallback((raw: string): boolean => {
    const result = parsePairingUri(raw);
    if (!result.ok) {
      setLinkNote(null);
      setFieldError(result.error);
      return false;
    }
    setHost(result.link.host);
    setPort(String(result.link.port));
    setPairingId(result.link.pairingId);
    setCode(result.link.code);
    setFieldError(null);
    setLinkNote(`Filled in from the pairing link for ${describeEndpoint(result.link)}.`);
    return true;
  }, []);

  useEffect(() => {
    if (url !== null) applyLink(url);
  }, [url, applyLink]);

  // Re-pairing after an unpair keeps the address: it is the one field the user
  // would otherwise have to read off the host again.
  const previous = state.host;
  useEffect(() => {
    if (previous === null) return;
    setHost((current) => (current.length === 0 ? previous.host : current));
    setPort((current) => (current.length === 0 ? String(previous.port) : current));
  }, [previous]);

  const submit = (): void => {
    const parsed = parseEndpoint(host, port);
    if (!parsed.ok) {
      setFieldError(parsed.error);
      return;
    }
    if (pairingId.trim().length === 0) {
      setFieldError('Enter the pairing id from the host console, or paste the pairing link.');
      return;
    }
    if (!CODE_PATTERN.test(code.trim())) {
      setFieldError('The pairing code is the 8 digits guhbot printed on the host.');
      return;
    }
    setFieldError(null);
    setLinkNote(null);
    void app.pair(parsed.endpoint, pairingId.trim(), code.trim());
  };

  const busy = state.pairing.busy;

  return (
    // This screen hides the native header, so it owns the top inset itself:
    // without it the brand row renders under the status bar.
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
    <Screen>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.brand}>
          <View style={styles.mark}>
            <Text style={styles.markText}>G</Text>
          </View>
          <Text style={styles.brandName}>guhbot</Text>
        </View>
        <Text style={styles.title}>Pair this phone with a host</Text>
        <Text style={styles.lead}>
          Run guhbot on the machine you want to drive, print a pairing code there, and enter it here. Scan the QR code on that screen and
          everything below fills in.
        </Text>

        <NoticeCard
          title="What this phone will be allowed to do"
          detail={
            'A device that pairs over the network is always a background device: it can watch agents, read transcripts and see approval requests. ' +
            'Granting an approval, starting a run or changing anything on the host has to happen on the host machine itself, because guhbot does not let a remote device promote itself.'
          }
        />

        <View style={styles.card}>
          <Text style={styles.label}>Pairing link</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="guhbot://pair?host=…&port=…&id=…&code=…"
            placeholderTextColor={colors.faint}
            style={styles.input}
            value={linkDraft}
            onChangeText={setLinkDraft}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              if (applyLink(linkDraft)) setLinkDraft('');
            }}
            style={({ pressed }) => [styles.secondary, pressed ? styles.pressed : null]}
          >
            <Text style={styles.secondaryText}>Use this link</Text>
          </Pressable>

          {linkNote === null ? null : <Text style={styles.note}>{linkNote}</Text>}
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.grow}>
              <Text style={styles.label}>Host</Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="192.168.1.20"
                placeholderTextColor={colors.faint}
                style={styles.input}
                value={host}
                onChangeText={setHost}
              />
            </View>
            <View style={styles.portField}>
              <Text style={styles.label}>Port</Text>
              <TextInput
                keyboardType="number-pad"
                placeholder="8787"
                placeholderTextColor={colors.faint}
                style={styles.input}
                value={port}
                onChangeText={setPort}
              />
            </View>
          </View>

          <Text style={styles.label}>Pairing id</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="pr_…"
            placeholderTextColor={colors.faint}
            style={styles.input}
            value={pairingId}
            onChangeText={setPairingId}
          />

          <Text style={styles.label}>Pairing code</Text>
          <TextInput
            keyboardType="number-pad"
            maxLength={8}
            placeholder="8 digits"
            placeholderTextColor={colors.faint}
            style={[styles.input, styles.code]}
            value={code}
            onChangeText={setCode}
          />

          {fieldError === null ? null : <NoticeCard tone="warn" title="Check the details" detail={fieldError} />}
          {state.pairing.error === null ? null : <NoticeCard tone="bad" title="Pairing did not go through" detail={state.pairing.error} />}

          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={submit}
            style={({ pressed }) => [styles.primary, pressed ? styles.pressed : null, busy ? styles.disabled : null]}
          >
            {busy ? <ActivityIndicator color={colors.accentInk} /> : <Text style={styles.primaryText}>Pair with this host</Text>}
          </Pressable>

          <Text style={styles.footnote}>
            The pairing code is single use and expires a few minutes after it is minted. This app stores the device token it receives in the
            phone's keychain; there is no account and nothing is sent anywhere else.
          </Text>
        </View>
      </ScrollView>
    </Screen>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: colors.background, flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl * 2 },
  brand: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm, marginTop: spacing.sm },
  mark: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 10,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  markText: { color: colors.accentInk, fontSize: 17, fontWeight: '800' },
  brandName: { color: colors.text, fontSize: 17, fontWeight: '800' },
  title: { color: colors.text, fontSize: fontSize.hero, fontWeight: '800', letterSpacing: -0.4, marginBottom: spacing.xs },
  lead: { color: colors.muted, fontSize: 14, lineHeight: 21, marginBottom: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  label: { color: colors.muted, fontSize: fontSize.eyebrow, fontWeight: '700', marginBottom: spacing.xs, marginTop: spacing.md, textTransform: 'uppercase' },
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
  code: { fontSize: 20, fontWeight: '700', letterSpacing: 4, textAlign: 'center' },
  row: { flexDirection: 'row', gap: spacing.md },
  grow: { flex: 1 },
  portField: { width: 110 },
  primary: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
  },
  primaryText: { color: colors.accentInk, fontSize: 16, fontWeight: '800' },
  secondary: {
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
  },
  secondaryText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.6 },
  note: { color: colors.accent, fontSize: 13, marginTop: spacing.sm },
  footnote: { color: colors.faint, fontSize: 12, lineHeight: 18, marginTop: spacing.lg },
});
