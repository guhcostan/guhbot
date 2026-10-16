import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { RootStackParamList } from '../navigation/types';
import { useAppState } from '../state/provider';
import { colors, spacing } from '../theme';

export function AgentsHeaderButtons(): ReactElement {
  const state = useAppState();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const pending = state.approvals.length;

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        onPress={() => navigation.navigate('Approvals')}
        style={({ pressed }) => [styles.chip, pending > 0 ? styles.chipAlert : null, pressed ? styles.pressed : null]}
      >
        <Text style={[styles.label, pending > 0 ? styles.labelAlert : null]}>⏸ {pending > 0 ? `Approvals · ${pending}` : 'Approvals'}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={() => navigation.navigate('Settings')}
        style={({ pressed }) => [styles.chip, pressed ? styles.pressed : null]}
      >
        <Text style={styles.label}>⚙</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  chip: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  chipAlert: { borderColor: colors.warn },
  label: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  labelAlert: { color: colors.warn },
  pressed: { opacity: 0.6 },
});
