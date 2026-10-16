/**
 * Keeper theme: the single visual language shared by desktop, mobile and the
 * website. Dark-only on purpose: an agent console is a night-shift tool, and
 * one theme halves the QA surface.
 */
export const colors = {
  background: '#08090b',
  surface: '#10151b',
  surfaceAlt: '#151c24',
  surfaceRaised: '#1a222c',
  border: '#1e262f',
  borderSoft: '#161c23',
  text: '#eef2f6',
  muted: '#9aa5b1',
  faint: '#626d79',
  accent: '#67e8a2',
  accentInk: '#04120b',
  info: '#8ab4f8',
  good: '#67e8a2',
  warn: '#e0b054',
  bad: '#e0796a',
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
