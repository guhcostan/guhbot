import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme.js';

export type PillTone = 'neutral' | 'info' | 'good' | 'warn' | 'bad';

const TONE: Readonly<Record<PillTone, string>> = {
  neutral: colors.muted,
  info: colors.accent,
  good: colors.good,
  warn: colors.warn,
  bad: colors.bad,
};

export function Pill({ label, tone = 'neutral' }: { readonly label: string; readonly tone?: PillTone }): ReactElement {
  const color = TONE[tone];
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  label: { fontSize: 11, fontWeight: '600', letterSpacing: 0.3, textTransform: 'uppercase' },
});
