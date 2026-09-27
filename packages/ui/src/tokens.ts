/**
 * KORA design tokens — single source of truth (Committee artboard, goal 01 §3).
 * `scripts/build-css.ts` generates `src/styles/tokens.generated.css`; `scripts/contrast.ts` checks
 * WCAG 2.2 AA (>= 4.5:1) for every text/surface pair declared below.
 */
export type ThemeName = 'pro-dark' | 'novice-light';
export type ColourConvention = 'blue_orange' | 'green_red' | 'red_up_asia';

export interface ThemeTokens {
  /** Surfaces */
  bg: string;
  panel: string;
  raised: string;
  border: string;
  /** Text */
  text: string;
  textMuted: string;
  /** Semantic */
  up: string;
  down: string;
  accent: string;
  ai: string;
  warn: string;
  warnSurface: string;
  kill: string;
  focus: string;
  /** Foreground on filled semantic backgrounds */
  onUp: string;
  onDown: string;
  onAccent: string;
  onKill: string;
  onWarn: string;
  onPrimary: string;
  primary: string;
  paperChip: string;
  onPaperChip: string;
  upSurface: string;
  downSurface: string;
  /**
   * IRTC R5-15/R5-16: semantic colours that must NOT follow the up/down colour convention.
   * accentSurface: selected / active highlight (nav, chosen option, chart area).
   * loss: money you could lose (novice "Most you could lose"); risk: risk-level bars.
   * ok: healthy status (connection dot). borderStrong: non-text outline >= 3:1 on panels (WCAG 1.4.11).
   */
  accentSurface: string;
  loss: string;
  risk: string;
  ok: string;
  borderStrong: string;
}

export const themes: Record<ThemeName, ThemeTokens> = {
  'pro-dark': {
    bg: '#0B0E13',
    panel: '#11151C',
    raised: '#1A202A',
    border: '#262E3B',
    text: '#E6EAF0',
    textMuted: '#9AA4B2',
    up: '#4DA3FF',
    down: '#FF9F40',
    accent: '#4DA3FF',
    ai: '#A78BFA',
    warn: '#F2C94C',
    warnSurface: '#2A2412',
    kill: '#FF4D6D',
    focus: '#F2C94C',
    onUp: '#0B0E13',
    onDown: '#0B0E13',
    onAccent: '#0B0E13',
    onKill: '#0B0E13',
    onWarn: '#0B0E13',
    primary: '#4DA3FF',
    onPrimary: '#0B0E13',
    paperChip: '#F2C94C',
    onPaperChip: '#0B0E13',
    upSurface: '#0F2238',
    downSurface: '#33220F',
    accentSurface: '#0F2238',
    loss: '#FF9F40',
    risk: '#FF9F40',
    ok: '#4DA3FF',
    borderStrong: '#667085',
  },
  'novice-light': {
    bg: '#F7F5F0',
    panel: '#FFFFFF',
    raised: '#FAF8F4',
    border: '#E2DDD2',
    text: '#1C2430',
    textMuted: '#58616E',
    up: '#1D6FD1',
    down: '#B8520B',
    accent: '#3E5BD8',
    ai: '#6B4FD0',
    warn: '#7A5700',
    warnSurface: '#FBF3D5',
    kill: '#B3123B',
    focus: '#3E5BD8',
    onUp: '#FFFFFF',
    onDown: '#FFFFFF',
    onAccent: '#FFFFFF',
    onKill: '#FFFFFF',
    onWarn: '#FFFFFF',
    primary: '#1C2430',
    onPrimary: '#FFFFFF',
    paperChip: '#FBF0C9',
    onPaperChip: '#5C4300',
    upSurface: '#F0F6FD',
    downSurface: '#FDF5EF',
    accentSurface: '#F0F6FD',
    loss: '#B8520B',
    risk: '#B8520B',
    ok: '#1D6FD1',
    borderStrong: '#857F73',
  },
};

/**
 * Direction colours per convention (Settings). Blue/orange is the colour-blind-safe default.
 * IRTC R5-15: the direction surfaces (depth bars, tick flash, selected buy/sell option) follow the
 * convention too, so one widget never mixes two palettes.
 */
export interface ConventionColours {
  up: string;
  down: string;
  upSurface: string;
  downSurface: string;
}

export const conventions: Record<ThemeName, Record<ColourConvention, ConventionColours>> = {
  'pro-dark': {
    blue_orange: { up: '#4DA3FF', down: '#FF9F40', upSurface: '#0F2238', downSurface: '#33220F' },
    green_red: { up: '#3FB950', down: '#FF6B6B', upSurface: '#0F2A17', downSurface: '#3A1616' },
    red_up_asia: { up: '#FF6B6B', down: '#3FB950', upSurface: '#3A1616', downSurface: '#0F2A17' },
  },
  'novice-light': {
    blue_orange: { up: '#1D6FD1', down: '#B8520B', upSurface: '#F0F6FD', downSurface: '#FDF5EF' },
    green_red: { up: '#1A7F37', down: '#C62828', upSurface: '#EEF7F0', downSurface: '#FDEEEE' },
    red_up_asia: { up: '#C62828', down: '#1A7F37', upSurface: '#FDEEEE', downSurface: '#EEF7F0' },
  },
};

export const typography = {
  'pro-dark': {
    ui: "'IBM Plex Sans Condensed', 'IBM Plex Sans', system-ui, sans-serif",
    num: "'IBM Plex Mono', ui-monospace, monospace",
    display: "'IBM Plex Sans Condensed', system-ui, sans-serif",
  },
  'novice-light': {
    ui: "'Figtree', system-ui, sans-serif",
    num: "'Figtree', system-ui, sans-serif",
    display: "'Fraunces Variable', 'Fraunces', Georgia, serif",
  },
} as const;

/** Text/surface pairs that must meet 4.5:1. [foreground, background, where it is used]. */
export function contrastPairs(t: ThemeTokens): Array<[keyof ThemeTokens, keyof ThemeTokens, string]> {
  const surfaces: Array<keyof ThemeTokens> = ['bg', 'panel', 'raised'];
  const texts: Array<keyof ThemeTokens> = ['text', 'textMuted', 'up', 'down', 'accent', 'ai', 'warn', 'kill', 'loss', 'ok'];
  const pairs: Array<[keyof ThemeTokens, keyof ThemeTokens, string]> = [];
  for (const fg of texts) for (const bg of surfaces) pairs.push([fg, bg, `${fg} text on ${bg}`]);
  void t;
  pairs.push(
    ['onUp', 'up', 'buy button label'],
    ['onDown', 'down', 'sell button label'],
    ['onAccent', 'accent', 'accent fill label'],
    ['onKill', 'kill', 'kill confirm label'],
    ['onPrimary', 'primary', 'primary button label'],
    ['onPaperChip', 'paperChip', 'PAPER environment chip'],
    ['warn', 'warnSurface', 'warning banner text'],
    ['text', 'warnSurface', 'warning banner body'],
    ['up', 'upSurface', 'selected buy option'],
    ['down', 'downSurface', 'selected sell option'],
    ['text', 'upSurface', 'text on up surface'],
    ['accent', 'accentSurface', 'active nav item'],
    ['text', 'accentSurface', 'text on the selected option'],
  );
  return pairs;
}

/** Non-text pairs that must meet 3:1 (WCAG 1.4.11): [colour, surface, where it is used]. IRTC R5-16. */
export function nonTextPairs(): Array<[keyof ThemeTokens, keyof ThemeTokens, string]> {
  return [
    ['borderStrong', 'panel', 'empty risk-level segment outline'],
    ['risk', 'panel', 'filled risk-level segment'],
    ['ok', 'bg', 'connection status dot'],
  ];
}

export const radii = { sm: '4px', md: '8px', lg: '14px', pill: '999px' } as const;
export const space = { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '24px', 6: '32px' } as const;
/** Novice touch targets are >= 44 px (Committee artboard). */
export const touchTarget = { pro: '28px', novice: '44px' } as const;
