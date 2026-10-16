import type { ReactElement, ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, toneColor, type NoticeTone } from '../theme.js';

export interface NoticeAction {
  readonly label: string;
  readonly onPress: () => void;
  readonly busy?: boolean;
}

export interface NoticeCardProps {
  readonly tone?: NoticeTone;
  readonly title: string;
  readonly detail: string;
  readonly action?: NoticeAction;
  readonly onDismiss?: () => void;
  readonly children?: ReactNode;
}

/**
 * The single way this app explains a state the user cannot change by tapping:
 * a refused method, an unreachable host, an expired token.
 */
export function NoticeCard({ tone = 'info', title, detail, action, onDismiss, children }: NoticeCardProps): ReactElement {
  return (
    <View style={[styles.card, { borderLeftColor: toneColor[tone] }]}>
      <Text style={[styles.title, { color: toneColor[tone] }]}>{title}</Text>
      <Text style={styles.detail}>{detail}</Text>
      {children}
      {action !== undefined || onDismiss !== undefined ? (
        <View style={styles.row}>
          {action === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              disabled={action.busy === true}
              onPress={action.onPress}
              style={({ pressed }) => [styles.action, pressed ? styles.pressed : null, action.busy === true ? styles.disabled : null]}
            >
              {action.busy === true ? <ActivityIndicator size="small" color={colors.text} /> : <Text style={styles.actionText}>{action.label}</Text>}
            </Pressable>
          )}
          {onDismiss === undefined ? null : (
            <Pressable accessibilityRole="button" onPress={onDismiss} style={({ pressed }) => [styles.dismiss, pressed ? styles.pressed : null]}>
              <Text style={styles.dismissText}>Dismiss</Text>
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
    borderLeftWidth: 3,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  title: { fontSize: 13.5, fontWeight: '700' },
  detail: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  action: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  dismiss: { justifyContent: 'center', paddingHorizontal: spacing.sm, paddingVertical: spacing.sm },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.5 },
  actionText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  dismissText: { color: colors.muted, fontSize: 13 },
});
