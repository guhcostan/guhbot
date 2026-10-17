import type { ReactElement } from 'react';
import Svg, { Path, Rect, G } from 'react-native-svg';
import { StyleSheet, Text, View } from 'react-native';

import { avatarHue, colors, radius, spacing } from '../theme';

/**
 * Initial-based avatar. A stable hue per name keeps agents distinguishable
 * with no image pipeline and no network.
 */
export function Avatar({
  name,
  size = 36,
}: {
  readonly name: string;
  readonly size?: number;
}): ReactElement {
  const palette = ['#6960e8', '#edaa8b', '#74bda8'];
  return (
    <Mascot
      size={size}
      color={palette[avatarHue(name) % palette.length] ?? '#6960e8'}
    />
  );
}

export function Mascot({
  size = 36,
  color = colors.accent,
}: {
  size?: number;
  color?: string;
}): ReactElement {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      accessibilityElementsHidden
    >
      <Path
        d="M128 35C98 7 48 10 27 43C5 76 14 109 37 128C9 150 5 190 32 218C60 246 100 241 128 216C156 241 196 246 224 218C251 190 247 150 219 128C242 109 251 76 229 43C208 10 158 7 128 35Z"
        fill={color}
      />
      <G fill="#fffdf7">
        <Rect x="94" y="99" width="19" height="58" rx="9.5" />
        <Rect x="143" y="99" width="19" height="58" rx="9.5" />
      </G>
    </Svg>
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
  wrap: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },
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
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  detail: {
    color: colors.muted,
    fontSize: 13.5,
    lineHeight: 20,
    textAlign: 'center',
  },
});
