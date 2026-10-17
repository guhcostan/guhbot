import { DefaultTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RootNavigator } from './src/navigation/RootNavigator';
import { StoreProvider } from './src/state/provider';
import { colors } from './src/theme';

const theme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: colors.background,
    border: colors.border,
    card: colors.surface,
    primary: colors.accent,
    text: colors.text,
  },
};

export default function App(): ReactElement {
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <NavigationContainer theme={theme}>
          <StatusBar style="dark" />
          <RootNavigator />
        </NavigationContainer>
      </StoreProvider>
    </SafeAreaProvider>
  );
}
