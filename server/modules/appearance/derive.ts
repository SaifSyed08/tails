import { FONT_FAMILIES, type ThemeSpec } from '@/modules/appearance/theme-spec.js';

/**
 * A colour in the `H S% L%` grammar the stylesheet uses.
 *
 * Kept as components rather than a formatted string so the contrast solver can
 * walk lightness without reparsing.
 */
export type Hsl = { h: number; s: number; l: number };

export type ThemeTokens = {
  colors: Record<string, Hsl>;
  lengths: Record<string, string>;
  fonts: Record<string, string>;
  durations: Record<string, string>;
  easings: Record<string, string>;
};

export type DerivedTheme = {
  light: ThemeTokens;
  dark: ThemeTokens | null;
  /** Tokens the solver had to adjust to reach the contrast floor. */
  adjusted: string[];
  /** The worst text contrast ratio in the result, for reporting. */
  minRatio: number;
};

/** A pair that must clear a contrast floor, and the floor it must clear. */
type ContrastPair = { foreground: string; background: string; minimum: number };

/**
 * Every pair the solver enforces.
 *
 * Text pairs use the WCAG AA 4.5:1 floor; borders and rings are non-text and
 * use 3:1. This list is the contract — a token pair absent from here is a pair
 * nobody is checking, so adding a colour token means adding its pair.
 */
const CONTRAST_PAIRS: ContrastPair[] = [
  { foreground: 'foreground', background: 'background', minimum: 4.5 },
  { foreground: 'card-foreground', background: 'card', minimum: 4.5 },
  { foreground: 'popover-foreground', background: 'popover', minimum: 4.5 },
  { foreground: 'primary-foreground', background: 'primary', minimum: 4.5 },
  { foreground: 'secondary-foreground', background: 'secondary', minimum: 4.5 },
  { foreground: 'accent-foreground', background: 'accent', minimum: 4.5 },
  { foreground: 'destructive-foreground', background: 'destructive', minimum: 4.5 },
  { foreground: 'positive-foreground', background: 'positive', minimum: 4.5 },
  { foreground: 'warning-foreground', background: 'warning', minimum: 4.5 },
  { foreground: 'muted-foreground', background: 'background', minimum: 4.5 },
  { foreground: 'muted-foreground', background: 'card', minimum: 4.5 },
  { foreground: 'border', background: 'background', minimum: 3 },
  { foreground: 'ring', background: 'background', minimum: 3 },
];

/**
 * Fixed lightness per role, per mode.
 *
 * This table is the reason generated themes are legible. The model influences
 * hue and saturation; these numbers are not negotiable.
 */
const LIGHTNESS = {
  light: {
    background: 98, foreground: 10,
    card: 100, 'card-foreground': 10,
    popover: 100, 'popover-foreground': 10,
    primary: 45, 'primary-foreground': 100,
    secondary: 94, 'secondary-foreground': 15,
    muted: 94, 'muted-foreground': 38,
    accent: 93, 'accent-foreground': 15,
    destructive: 42, 'destructive-foreground': 100,
    positive: 30, 'positive-foreground': 100,
    warning: 32, 'warning-foreground': 100,
    border: 86, input: 86, ring: 45,
  },
  dark: {
    background: 6, foreground: 95,
    card: 9, 'card-foreground': 95,
    popover: 9, 'popover-foreground': 95,
    primary: 62, 'primary-foreground': 8,
    secondary: 16, 'secondary-foreground': 95,
    muted: 16, 'muted-foreground': 66,
    accent: 18, 'accent-foreground': 95,
    destructive: 58, 'destructive-foreground': 8,
    positive: 52, 'positive-foreground': 8,
    warning: 58, 'warning-foreground': 8,
    border: 22, input: 22, ring: 62,
  },
} as const;

/** Saturation for surface roles, by authored chroma bucket. */
const SURFACE_SATURATION = { neutral: 5, tinted: 14, rich: 26 } as const;
/** Saturation for the accent roles. */
const ACCENT_SATURATION = { muted: 45, vivid: 74, electric: 92 } as const;
/** Status saturation tracks the accent one bucket down, so danger stays legible as danger. */
const STATUS_SATURATION = { muted: 40, vivid: 58, electric: 70 } as const;

/** Hue anchors for semantic colour. Shiftable by at most ±15°. */
const STATUS_HUES = { positive: 145, warning: 38, destructive: 8 } as const;

const RADIUS = { sharp: '0.125rem', soft: '0.5rem', round: '1rem', pill: '1.75rem' } as const;
const BORDER_WIDTH = { hairline: '1px', normal: '1.5px', bold: '2.5px' } as const;
const SPACE_UNIT = { tight: '0.2rem', default: '0.25rem', airy: '0.32rem' } as const;
const FONT_SIZE = { compact: '14px', default: '15px', spacious: '16.5px' } as const;
const TRACKING = { tight: '-0.015em', normal: '0em', wide: '0.06em' } as const;
const DISPLAY_WEIGHT = { regular: '400', medium: '500', bold: '700', black: '900' } as const;

/**
 * Motion feel, the single source for both CSS variables and the TS constants
 * the renderer reads back.
 */
const MOTION_FEEL = {
  instant: { instant: 40, quick: 80, settle: 120, reflow: 180, emphasis: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  calm: { instant: 110, quick: 200, settle: 300, reflow: 460, emphasis: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  standard: { instant: 90, quick: 160, settle: 240, reflow: 380, emphasis: 'cubic-bezier(0.34, 1.4, 0.64, 1)' },
  playful: { instant: 100, quick: 180, settle: 280, reflow: 420, emphasis: 'cubic-bezier(0.34, 1.7, 0.64, 1)' },
} as const;

const wrapHue = (hue: number): number => ((hue % 360) + 360) % 360;

/** Secondary hue, derived from the accent by the authored scheme. */
function readSecondaryHue(spec: ThemeSpec): number {
  const { accentHue, scheme } = spec.palette;
  switch (scheme) {
    case 'mono': return accentHue;
    case 'analogous': return wrapHue(accentHue + 30);
    case 'complement': return wrapHue(accentHue + 180);
    case 'triad': return wrapHue(accentHue + 120);
  }
}

/** WCAG relative luminance for an HSL colour. */
export function relativeLuminance({ h, s, l }: Hsl): number {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const match = lightness - chroma / 2;

  const sector = Math.floor(h / 60) % 6;
  const [r, g, b] = (
    sector === 0 ? [chroma, secondary, 0]
      : sector === 1 ? [secondary, chroma, 0]
        : sector === 2 ? [0, chroma, secondary]
          : sector === 3 ? [0, secondary, chroma]
            : sector === 4 ? [secondary, 0, chroma]
              : [chroma, 0, secondary]
  ).map((channel) => channel + match);

  const linearize = (channel: number) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio between two colours. */
export function contrastRatio(a: Hsl, b: Hsl): number {
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

function buildColors(spec: ThemeSpec, mode: 'light' | 'dark'): Record<string, Hsl> {
  const bands = LIGHTNESS[mode];
  const { surfaceHue, accentHue, surfaceChroma, accentChroma, statusHueShift } = spec.palette;

  const surfaceS = SURFACE_SATURATION[surfaceChroma];
  const accentS = ACCENT_SATURATION[accentChroma];
  const statusS = STATUS_SATURATION[accentChroma];
  const secondaryHue = readSecondaryHue(spec);

  const surface = (role: keyof typeof bands, saturationScale = 1): Hsl =>
    ({ h: surfaceHue, s: surfaceS * saturationScale, l: bands[role] });

  return {
    // Surfaces carry only a fraction of the surface saturation so a "rich"
    // theme tints the page without turning the text background into a colour
    // field.
    background: surface('background', 0.7),
    foreground: surface('foreground', 0.5),
    card: surface('card', 0.5),
    'card-foreground': surface('card-foreground', 0.5),
    popover: surface('popover', 0.5),
    'popover-foreground': surface('popover-foreground', 0.5),
    secondary: { h: secondaryHue, s: surfaceS, l: bands.secondary },
    'secondary-foreground': surface('secondary-foreground', 0.6),
    muted: surface('muted'),
    'muted-foreground': surface('muted-foreground', 0.6),
    accent: surface('accent'),
    'accent-foreground': surface('accent-foreground', 0.6),
    border: surface('border'),
    input: surface('input'),

    primary: { h: accentHue, s: accentS, l: bands.primary },
    'primary-foreground': { h: accentHue, s: 12, l: bands['primary-foreground'] },
    ring: { h: accentHue, s: accentS, l: bands.ring },

    destructive: { h: wrapHue(STATUS_HUES.destructive + statusHueShift), s: statusS, l: bands.destructive },
    'destructive-foreground': { h: 0, s: 0, l: bands['destructive-foreground'] },
    positive: { h: wrapHue(STATUS_HUES.positive + statusHueShift), s: statusS, l: bands.positive },
    'positive-foreground': { h: 0, s: 0, l: bands['positive-foreground'] },
    warning: { h: wrapHue(STATUS_HUES.warning + statusHueShift), s: statusS, l: bands.warning },
    'warning-foreground': { h: 0, s: 0, l: bands['warning-foreground'] },
  };
}

/**
 * Walks foregrounds toward their pole until every pair clears its floor.
 *
 * The schema makes gross failures impossible; this exists for the residual few
 * points a saturated hue can cost. Adjusting the foreground rather than the
 * background keeps the authored look intact — the user asked for that pink,
 * not for the text on it.
 */
function solveContrast(colors: Record<string, Hsl>): { adjusted: string[]; minRatio: number } {
  const adjusted = new Set<string>();
  let minRatio = Number.POSITIVE_INFINITY;

  for (const pair of CONTRAST_PAIRS) {
    const background = colors[pair.background];
    const foreground = colors[pair.foreground];
    if (!background || !foreground) continue;

    if (contrastRatio(foreground, background) >= pair.minimum) {
      minRatio = Math.min(minRatio, contrastRatio(foreground, background));
      continue;
    }

    // Pick the pole that can actually reach the floor rather than assuming
    // "dark background means light text". A mid-lightness surface — which is
    // exactly what a saturated `primary` is — is often reachable only from the
    // opposite side, and walking the wrong way just pins the foreground at an
    // extreme that still fails.
    const towardWhite = contrastRatio({ ...foreground, l: 100 }, background);
    const towardBlack = contrastRatio({ ...foreground, l: 0 }, background);
    const direction = towardWhite >= towardBlack ? 1 : -1;

    let steps = 0;
    while (contrastRatio(foreground, background) < pair.minimum && steps < 60) {
      const next = foreground.l + direction * 2;
      if (next < 0 || next > 100) break;
      foreground.l = next;
      adjusted.add(pair.foreground);
      steps += 1;
    }

    // If even a full-range foreground cannot clear the floor, the background
    // itself sits at mid-luminance. Move it away too; black against white is
    // 21:1, so widening from both sides always converges.
    let backgroundSteps = 0;
    while (contrastRatio(foreground, background) < pair.minimum && backgroundSteps < 60) {
      const next = background.l - direction * 2;
      if (next < 0 || next > 100) break;
      background.l = next;
      adjusted.add(pair.background);
      backgroundSteps += 1;
    }

    minRatio = Math.min(minRatio, contrastRatio(foreground, background));
  }

  return { adjusted: [...adjusted], minRatio: Number.isFinite(minRatio) ? minRatio : 21 };
}

function buildNonColorTokens(spec: ThemeSpec): Omit<ThemeTokens, 'colors'> {
  const feel = MOTION_FEEL[spec.motion];

  return {
    lengths: {
      radius: RADIUS[spec.shape.radius],
      'border-width': BORDER_WIDTH[spec.shape.borderWeight],
      'space-unit': SPACE_UNIT[spec.density],
      'font-size-base': FONT_SIZE[spec.type.scale],
      'letter-spacing-base': TRACKING[spec.type.letterSpacing],
      'display-weight': DISPLAY_WEIGHT[spec.type.displayWeight],
    },
    fonts: {
      'font-sans': FONT_FAMILIES[spec.type.sansFamily],
      'font-display': FONT_FAMILIES[spec.type.displayFamily],
      'font-mono': FONT_FAMILIES[spec.type.monoFamily],
      'font-serif': FONT_FAMILIES.serif,
    },
    durations: {
      'duration-instant': `${feel.instant}ms`,
      'duration-quick': `${feel.quick}ms`,
      'duration-settle': `${feel.settle}ms`,
      'duration-reflow': `${feel.reflow}ms`,
    },
    easings: {
      'ease-enter': 'cubic-bezier(0.22, 1, 0.36, 1)',
      'ease-exit': 'cubic-bezier(0.64, 0, 0.78, 0)',
      'ease-standard': 'cubic-bezier(0.4, 0, 0.2, 1)',
      'ease-emphasis': feel.emphasis,
    },
  };
}

/**
 * Turns an authored spec into contrast-solved tokens.
 *
 * Pure and deterministic: the same spec always produces the same tokens, which
 * is what lets the derived output be cached alongside the spec and replayed
 * unchanged after a schema version bump.
 */
export function deriveTokens(spec: ThemeSpec): DerivedTheme {
  const shared = buildNonColorTokens(spec);

  const buildRamp = (mode: 'light' | 'dark') => {
    const colors = buildColors(spec, mode);
    const solved = solveContrast(colors);
    return { tokens: { colors, ...shared } as ThemeTokens, ...solved };
  };

  // A single-mode theme still needs its one ramp built for the mode it pins.
  if (spec.mode === 'dark') {
    const dark = buildRamp('dark');
    return { light: dark.tokens, dark: dark.tokens, adjusted: dark.adjusted, minRatio: dark.minRatio };
  }
  if (spec.mode === 'light') {
    const light = buildRamp('light');
    return { light: light.tokens, dark: null, adjusted: light.adjusted, minRatio: light.minRatio };
  }

  const light = buildRamp('light');
  const dark = buildRamp('dark');
  return {
    light: light.tokens,
    dark: dark.tokens,
    adjusted: [...new Set([...light.adjusted, ...dark.adjusted])],
    minRatio: Math.min(light.minRatio, dark.minRatio),
  };
}

/** The contrast pairs, exported so tests can assert the shipped default ramp too. */
export { CONTRAST_PAIRS };
