import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { ReactElement } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { AgentsHeaderButtons } from '../components/AgentsHeaderButtons.js';
import { Screen } from '../components/Screen.js';
import { AgentsScreen } from '../screens/AgentsScreen.js';
import { ApprovalsScreen } from '../screens/ApprovalsScreen.js';
import { PairingScreen } from '../screens/PairingScreen.js';
import { SettingsScreen } from '../screens/SettingsScreen.js';
import { ThreadScreen } from '../screens/ThreadScreen.js';
import { useAppState } from '../state/provider.js';
import { colors, spacing } from '../theme.js';
import type { RootStackParamList } from './types.js';

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
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        headerTitleStyle: { fontSize: 17 },
      }}
    >
      {state.status === 'unpaired' ? (
        <Stack.Screen name="Pairing" component={PairingScreen} options={{ title: 'guhbot' }} />
      ) : (
        <>
          <Stack.Screen name="Agents" component={AgentsScreen} options={{ title: 'Agents', headerRight: () => <AgentsHeaderButtons /> }} />
          <Stack.Screen name="Thread" component={ThreadScreen} options={({ route }) => ({ title: route.params.agentName })} />
          <Stack.Screen name="Approvals" component={ApprovalsScreen} options={{ title: 'Approvals' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
        </>
      )}
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  starting: { alignItems: 'center', flex: 1, gap: spacing.md, justifyContent: 'center' },
  brand: { color: colors.text, fontSize: 28, fontWeight: '700' },
  hint: { color: colors.muted, fontSize: 13 },
});
