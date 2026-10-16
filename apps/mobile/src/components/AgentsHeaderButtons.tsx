import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { RootStackParamList } from '../navigation/types.js';
import { useAppState } from '../state/provider.js';
import { colors, spacing } from '../theme.js';

export function AgentsHeaderButtons(): ReactElement {
  const state = useAppState();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const pending = state.approvals.length;

  return (
    <View style={styles.row}>
      <Pressable accessibilityRole="button" onPress={() => navigation.navigate('Approvals')} style={({ pressed }) => (pressed ? styles.pressed : null)}>
        <Text style={styles.label}>Approvals{pending > 0 ? ` (${pending})` : ''}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => navigation.navigate('Settings')} style={({ pressed }) => (pressed ? styles.pressed : null)}>
        <Text style={styles.label}>Settings</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.lg },
  label: { color: colors.accent, fontSize: 15 },
  pressed: { opacity: 0.6 },
});
