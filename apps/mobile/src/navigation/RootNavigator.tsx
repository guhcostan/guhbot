import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { ReactElement } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { AgentsHeaderButtons } from '../components/AgentsHeaderButtons';
import { Screen } from '../components/Screen';
import { AgentsScreen } from '../screens/AgentsScreen';
import { ApprovalsScreen } from '../screens/ApprovalsScreen';
import { PairingScreen } from '../screens/PairingScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { ThreadScreen } from '../screens/ThreadScreen';
import { useAppState } from '../state/provider';
import { colors, spacing } from '../theme';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Which screens exist is derived from the pairing state, not pushed by the
 * pairing screen: a successful claim swaps the whole stack, and unpairing from
 * Settings swaps it back, with no imperative navigation in either path.
 */
export function RootNavigator(): ReactElement {
  const state = useAppState();

  if (state.status === 'starting') {
    return (
      <Screen>
        <View style={styles.starting}>
          <View style={styles.mark}>
            <Text style={styles.markText}>G</Text>
          </View>
          <Text style={styles.brand}>guhbot</Text>
          <ActivityIndicator color={colors.muted} />
          <Text style={styles.hint}>Reading the pairing stored on this phone…</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Stack.Navigator
      screenOptions={{
        contentStyle: { backgroundColor: colors.background },
        headerStyle: { backgroundColor: '#0b0e12' },
        headerTintColor: colors.text,
        headerTitleStyle: { fontSize: 16, fontWeight: '700' },
        headerShadowVisible: false,
      }}
    >
      {state.status === 'unpaired' ? (
        <Stack.Screen name="Pairing" component={PairingScreen} options={{ title: 'guhbot', headerShown: false }} />
      ) : (
        <>
          <Stack.Screen name="Agents" component={AgentsScreen} options={{ title: 'guhbot', headerRight: () => <AgentsHeaderButtons /> }} />
          <Stack.Screen name="Thread" component={ThreadScreen} options={({ route }) => ({ title: route.params.agentName })} />
          <Stack.Screen name="Approvals" component={ApprovalsScreen} options={{ title: 'Approvals' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
        </>
      )}
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  starting: { alignItems: 'center', flex: 1, gap: spacing.sm, justifyContent: 'center' },
  mark: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 16, height: 56, justifyContent: 'center', width: 56 },
  markText: { color: colors.accentInk, fontSize: 28, fontWeight: '800' },
  brand: { color: colors.text, fontSize: 24, fontWeight: '800' },
  hint: { color: colors.muted, fontSize: 13 },
});
