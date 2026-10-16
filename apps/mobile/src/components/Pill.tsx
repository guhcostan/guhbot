import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme.js';

export type PillTone = 'neutral' | 'info' | 'good' | 'warn' | 'bad';

const TONE: Readonly<Record<PillTone, string>> = {
  neutral: colors.faint,
  info: colors.info,
  good: colors.good,
  warn: colors.warn,
  bad: colors.bad,
};

export function Pill({ label, tone = 'neutral' }: { readonly label: string; readonly tone?: PillTone }): ReactElement {
  const color = TONE[tone];
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  dot: { borderRadius: 3, height: 6, width: 6 },
  label: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
});
