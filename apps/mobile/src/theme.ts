export const colors = {
  background: '#0b0f14',
  surface: '#141b23',
  surfaceAlt: '#1c2530',
  border: '#27313d',
  text: '#e8eef5',
  muted: '#93a1b0',
  accent: '#4c9ffe',
  good: '#3fb950',
  warn: '#d29922',
  bad: '#f85149',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const radius = { sm: 6, md: 10, lg: 16 } as const;

export type NoticeTone = 'info' | 'good' | 'warn' | 'bad';

export const toneColor: Readonly<Record<NoticeTone, string>> = {
  info: colors.accent,
  good: colors.good,
  warn: colors.warn,
  bad: colors.bad,
};

export function toneFromConnection(tone: 'neutral' | 'good' | 'warn' | 'bad'): NoticeTone {
  return tone === 'neutral' ? 'info' : tone;
}
