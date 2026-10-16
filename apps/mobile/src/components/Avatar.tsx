import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { avatarHue, colors, initials, radius, spacing } from '../theme';

/**
 * Initial-based avatar. A stable hue per name keeps agents distinguishable
 * with no image pipeline and no network.
 */
export function Avatar({ name, size = 36 }: { readonly name: string; readonly size?: number }): ReactElement {
  return (
    <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: `hsl(${avatarHue(name)} 45% 62%)` }]}>
      <Text style={[styles.text, { fontSize: size * 0.36 }]}>{initials(name)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  text: { color: colors.accentInk, fontWeight: '800' },
});

export function EmptyState({
  mark,
  title,
  detail,
}: {
  readonly mark: string;
  readonly title: string;
  readonly detail: string;
}): ReactElement {
  return (
    <View style={empty.wrap}>
      <View style={empty.mark}>
        <Text style={empty.markText}>{mark}</Text>
      </View>
      <Text style={empty.title}>{title}</Text>
      <Text style={empty.detail}>{detail}</Text>
    </View>
  );
}

const empty = StyleSheet.create({
  wrap: { alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xl, paddingVertical: spacing.xxl },
  mark: {
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    height: 56,
    justifyContent: 'center',
    marginBottom: spacing.sm,
    width: 56,
  },
  markText: { color: colors.accent, fontSize: 24 },
  title: { color: colors.text, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  detail: { color: colors.muted, fontSize: 13.5, lineHeight: 20, textAlign: 'center' },
});
