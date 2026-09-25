import { useMemo } from 'react';
import { Platform, StyleSheet, useColorScheme } from 'react-native';

export type Palette = {
  scheme: 'light' | 'dark';
  bg: string; surface: string; surfaceAlt: string; border: string; borderStrong: string;
  text: string; muted: string; faint: string;
  accent: string; accentText: string; accentSoft: string;
  success: string; successSoft: string; warning: string; warningSoft: string; danger: string; dangerSoft: string;
};

/** Neutral grayscale with a single accent; status hues are reserved for state, never decoration. */
const dark: Palette = {
  scheme: 'dark',
  bg: '#0A0A0B', surface: '#141416', surfaceAlt: '#1C1C1F', border: '#26262A', borderStrong: '#3A3A40',
  text: '#EDEDEF', muted: '#A0A0A8', faint: '#85858D',
  accent: '#EDEDEF', accentText: '#0A0A0B', accentSoft: '#1F1F23',
  success: '#3FB950', successSoft: 'rgba(63,185,80,0.14)', warning: '#E3A008', warningSoft: 'rgba(227,160,8,0.14)', danger: '#F0524F', dangerSoft: 'rgba(240,82,79,0.14)',
};
const light: Palette = {
  scheme: 'light',
  bg: '#FFFFFF', surface: '#FAFAFA', surfaceAlt: '#F4F4F5', border: '#E7E7EA', borderStrong: '#D4D4D8',
  text: '#18181B', muted: '#5F5F68', faint: '#6B6B74',
  accent: '#18181B', accentText: '#FFFFFF', accentSoft: '#F1F1F3',
  success: '#1A7F37', successSoft: 'rgba(26,127,55,0.10)', warning: '#955800', warningSoft: 'rgba(149,88,0,0.10)', danger: '#CF222E', dangerSoft: 'rgba(207,34,46,0.08)',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;
export const type = {
  title: { fontSize: 26, lineHeight: 32, fontWeight: '600', letterSpacing: -0.5 },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.2 },
  body: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
  mono: { fontSize: 12.5, lineHeight: 18, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, monospace' }) },
} as const;

export function usePalette(): Palette { return useColorScheme() === 'light' ? light : dark; }

/** Theme-aware StyleSheet factory: styles are rebuilt only when the colour scheme changes. */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(factory: (c: Palette) => T) {
  return () => { const c = usePalette(); return useMemo(() => StyleSheet.create(factory(c)), [c]); };
}
