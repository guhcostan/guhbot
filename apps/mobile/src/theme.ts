/**
 * Keeper theme: the single visual language shared by desktop, mobile and the
 * website. The light palette matches the desktop client and the public site.
 */
export const colors = {
  background: '#fafafd',
  sidebar: '#f4f3f8',
  surface: '#ffffff',
  surfaceAlt: '#f3effb',
  surfaceRaised: '#ebe5f7',
  border: '#e4dcec',
  borderSoft: '#eee8f4',
  text: '#25232e',
  muted: '#81748e',
  faint: '#a093ae',
  accent: '#6960e8',
  accentInk: '#ffffff',
  info: '#8c73c8',
  good: '#6960e8',
  warn: '#b58c4a',
  bad: '#b25a72',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 9, md: 13, lg: 18, pill: 999 } as const;

export const fontSize = {
  eyebrow: 10.5,
  meta: 11,
  secondary: 12.5,
  body: 14,
  title: 16,
  hero: 22,
} as const;

export type NoticeTone = 'info' | 'good' | 'warn' | 'bad';

export const toneColor: Readonly<Record<NoticeTone, string>> = {
  info: colors.info,
  good: colors.good,
  warn: colors.warn,
  bad: colors.bad,
};

export function toneFromConnection(tone: 'neutral' | 'good' | 'warn' | 'bad'): NoticeTone {
  return tone === 'neutral' ? 'info' : tone;
}

/**
 * Stable avatar background per name, so agents are distinguishable with no
 * image pipeline. The desktop computes a gradient from the same hash; here a
 * single hue is enough at small sizes.
 */
export function avatarHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return (parts[0]?.slice(0, 2) ?? '·').toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
}
