import type { ReactElement, ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors } from '../theme.js';

/** Full-height background for a screen; each list manages its own padding. */
export function Screen({ children }: { readonly children: ReactNode }): ReactElement {
  return <View style={styles.screen}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
});
