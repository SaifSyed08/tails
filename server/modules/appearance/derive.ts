import {
  buildLadder,
  clamp,
  compositeOver,
  contrastRatio,
  CONTRAST_TARGETS,
  inkLadderFor,
  LADDER_TIERS,
  solveTier,
  wrapHue,
  type ContrastTarget,
  type Hsl,
  type Ladder,
} from '@/modules/appearance/palette.js';
import {
  BASELINE_RECIPE,
  mergeRecipe,
  SURFACE_PARTS,
  type ColorRef,
  type ResolvedFillLayer,
  type ResolvedShadow,
  type ResolvedSurfaceRecipe,
  type SurfacePart,
} from '@/modules/appearance/surface-recipe.js';
import { readOverlayPaint, readTexturePaint } from '@/modules/appearance/textures.js';
import {
  FONT_FAMILIES,
  upgradeSpec,
  type ThemeSpec,
  type ThemeSpecV2,
} from '@/modules/appearance/theme-spec.js';

/**
 * Turns an authored spec into the complete set of tokens the renderer reads.
 *
 * The rule this module is built around, and the one v1 broke: **nothing is
 * validated and then dropped**. If a field exists in the schema it reaches the
 * stylesheet, and if it reaches the stylesheet it is named in
 * RENDERER-CONTRACT.md. A knob the model can turn that changes nothing is worse
 * than no knob at all — it teaches the model that the spec is decorative.
 */

export type { Hsl } from '@/modules/appearance/palette.js';
export { contrastRatio, relativeLuminance } from '@/modules/appearance/palette.js';

export type ThemeTokens = {
  colors: Record<string, Hsl>;
  lengths: Record<string, string>;
  fonts: Record<string, string>;
  durations: Record<string, string>;
  easings: Record<string, string>;
  /** Per-part custom properties, keyed by `data-tails-part` value. */
  surfaces: Record<string, Record<string, string>>;
  /** Per-tone custom properties, keyed by `data-tails-surface` value. */
  tones: Record<string, Record<string, string>>;
};

export type DerivedTheme = {
  light: ThemeTokens;
  dark: ThemeTokens | null;
  /** Tokens and anchors the solver had to move to reach the contrast target. */
  adjusted: string[];
  /** The worst text contrast ratio in the result, for reporting. */
  minRatio: number;
};

/** A pair that must clear a contrast floor, and which floor applies to it. */
type ContrastPair = { foreground: string; background: string; kind: 'text' | 'nonText' };

/**
 * Every pair the solver enforces.
 *
 * The floor is looked up from the theme's contrast target rather than hard-coded
 * here, so raising a theme to AAA raises this whole manifest with it. This list
 * is the contract — a token pair absent from here is a pair nobody is checking,
 * so adding a colour token means adding its pair.
 */
const CONTRAST_PAIRS: ContrastPair[] = [
  { foreground: 'foreground', background: 'background', kind: 'text' },
  { foreground: 'card-foreground', background: 'card', kind: 'text' },
  { foreground: 'popover-foreground', background: 'popover', kind: 'text' },
  { foreground: 'primary-foreground', background: 'primary', kind: 'text' },
  { foreground: 'secondary-foreground', background: 'secondary', kind: 'text' },
  { foreground: 'accent-foreground', background: 'accent', kind: 'text' },
  { foreground: 'destructive-foreground', background: 'destructive', kind: 'text' },
  { foreground: 'positive-foreground', background: 'positive', kind: 'text' },
  { foreground: 'warning-foreground', background: 'warning', kind: 'text' },
  { foreground: 'muted-foreground', background: 'background', kind: 'text' },
  { foreground: 'muted-foreground', background: 'card', kind: 'text' },
  { foreground: 'border', background: 'background', kind: 'nonText' },
  { foreground: 'ring', background: 'background', kind: 'nonText' },
];

/** The floor a pair must clear under a given contrast target. */
export const pairMinimum = (pair: ContrastPair, target: ContrastTarget): number =>
  CONTRAST_TARGETS[target][pair.kind];

/**
 * The contrast the system promises regardless of what anyone asked for.
 *
 * A theme may target `aaa` and miss it on a surface whose own fill makes the
 * target unreachable. It may not miss this one.
 */
const HARD_TEXT_FLOOR = CONTRAST_TARGETS.aa.text;

/** Saturation for surface roles, by authored chroma bucket. */
const SURFACE_SATURATION = { neutral: 5, tinted: 14, rich: 26 } as const;
/** Saturation for the accent roles. */
const ACCENT_SATURATION = { muted: 45, vivid: 74, electric: 92 } as const;
/** Status saturation tracks the accent one bucket down, so danger stays legible as danger. */
const STATUS_SATURATION = { muted: 40, vivid: 58, electric: 70 } as const;

/** Hue anchors for semantic colour. Shiftable by at most +/-15deg. */
const STATUS_HUES = { positive: 145, warning: 38, destructive: 8 } as const;

const SPACE_UNIT = { tight: '0.2rem', default: '0.25rem', airy: '0.32rem' } as const;
const FONT_SIZE = { compact: '14px', default: '15px', spacious: '16.5px' } as const;
const TRACKING = { tight: '-0.015em', normal: '0em', wide: '0.06em' } as const;
const DISPLAY_WEIGHT = { regular: '400', medium: '500', bold: '700', black: '900' } as const;
const LINE_HEIGHT = { tight: '1.35', default: '1.55', loose: '1.75' } as const;
const MEASURE = { narrow: '58ch', default: '72ch', wide: '88ch', full: 'none' } as const;

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

/** Secondary hue, derived from the accent by the authored scheme. */
function readSupportHue(spec: ThemeSpecV2): number {
  const { accentHue, scheme } = spec.palette;
  switch (scheme) {
    case 'mono': return accentHue;
    case 'analogous': return wrapHue(accentHue + 30);
    case 'complement': return wrapHue(accentHue + 180);
    case 'triad': return wrapHue(accentHue + 120);
  }
}

/**
 * Everything one ramp needs to resolve a colour reference.
 *
 * Assembled once per mode and threaded through surface derivation so a
 * `{ role: 'shadow' }` in a recipe means the same thing everywhere in that
 * ramp, and something appropriately different in the other one.
 */
type Ramp = {
  ladder: Ladder;
  surfaceHue: number;
  surfaceSaturation: number;
  accentHue: number;
  supportHue: number;
  accentSaturation: number;
  accentLightness: number;
  target: { text: number; nonText: number };
  /** Solved tiers for the roles a recipe can reference without a tier. */
  roleTiers: { foreground: number; border: number };
};

const round = (value: number): number => Math.round(value * 10) / 10;

/** Formats a resolved colour as a complete CSS colour value. */
export const formatColor = (color: Hsl, alpha = 1): string => {
  const body = `${round(wrapHue(color.h))} ${round(clamp(color.s, 0, 100))}% ${round(clamp(color.l, 0, 100))}%`;
  return alpha >= 1 ? `hsl(${body})` : `hsl(${body} / ${Math.round(alpha * 1000) / 1000})`;
};

const tierOf = (values: number[], tier: number): number =>
  values[clamp(Math.round(tier), 0, LADDER_TIERS - 1)];

/**
 * Turns a role reference into an actual colour.
 *
 * The whole point of forcing recipes through roles: a shadow authored as
 * `{ role: 'shadow' }` is a dark grey on paper and pure black on OLED, and the
 * theme author never had to think about which ramp they were in. A recipe
 * holding literal colours would need to be authored twice and would be wrong
 * the first time the user toggled dark mode.
 */
export function resolveColorRef(ref: ColorRef, ramp: Ramp): { color: Hsl; alpha: number } {
  const { ladder, surfaceHue, surfaceSaturation: saturation } = ramp;
  const alpha = ref.alpha ?? 1;

  const surfaceTone = (lightness: number, scale: number): Hsl =>
    ({ h: surfaceHue, s: saturation * scale, l: lightness });

  switch (ref.role) {
    case 'surface':
      return { color: surfaceTone(tierOf(ladder.toward, ref.tier ?? 0), 0.7), alpha };
    case 'foreground':
      return { color: surfaceTone(tierOf(ladder.toward, ref.tier ?? ramp.roleTiers.foreground), 0.5), alpha };
    case 'ink':
      return { color: surfaceTone(tierOf(ladder.toward, ref.tier ?? LADDER_TIERS - 1), 0.35), alpha };
    case 'border':
      return { color: surfaceTone(tierOf(ladder.toward, ref.tier ?? ramp.roleTiers.border), 1), alpha };
    case 'light':
      return { color: surfaceTone(tierOf(ladder.lighter, ref.tier ?? 4), 0.4), alpha };
    case 'shadow':
      return { color: surfaceTone(tierOf(ladder.darker, ref.tier ?? 6), 0.6), alpha };
    case 'accent':
      return {
        color: {
          h: ramp.accentHue,
          s: ramp.accentSaturation,
          l: ref.tier === undefined ? ramp.accentLightness : tierOf(ladder.toward, ref.tier),
        },
        alpha,
      };
    case 'support':
      return {
        color: {
          h: ramp.supportHue,
          s: ramp.accentSaturation * 0.8,
          l: ref.tier === undefined ? ramp.accentLightness : tierOf(ladder.toward, ref.tier),
        },
        alpha,
      };
  }
}

function buildRamp(spec: ThemeSpecV2, mode: 'light' | 'dark'): Ramp {
  const { surfaceHue, accentHue, surfaceChroma, accentChroma } = spec.palette;
  const target = CONTRAST_TARGETS[spec.surface.contrastTarget];
  const surfaceSaturation = SURFACE_SATURATION[surfaceChroma];

  const ladder = buildLadder({
    anchor: mode === 'light' ? spec.surface.lightAnchor : spec.surface.darkAnchor,
    mode,
    step: spec.surface.step,
    textTarget: target.text,
    hue: surfaceHue,
    saturation: surfaceSaturation * 0.7,
  });

  const background: Hsl = { h: surfaceHue, s: surfaceSaturation * 0.7, l: ladder.toward[0] };
  const skeleton: Ramp = {
    ladder,
    surfaceHue,
    surfaceSaturation,
    accentHue,
    supportHue: readSupportHue(spec),
    accentSaturation: ACCENT_SATURATION[accentChroma],
    // Provisional: the accent has to clear the non-text floor against the page,
    // and where it lands depends on which way the ladder runs.
    accentLightness: ladder.direction > 0 ? 62 : 45,
    target,
    roleTiers: { foreground: LADDER_TIERS - 1, border: LADDER_TIERS - 1 },
  };

  const surfaceTone = (scale: number) => (lightness: number): Hsl =>
    ({ h: surfaceHue, s: surfaceSaturation * scale, l: lightness });

  skeleton.roleTiers = {
    foreground: solveTier(ladder.toward, surfaceTone(0.5), background, target.text),
    border: solveTier(ladder.toward, surfaceTone(1), background, target.nonText),
  };

  // Walk the accent until it separates from the page. An electric accent on a
  // near-black page already clears it; a muted one on paper does not, and an
  // invisible primary button is a functional bug, not a style.
  const accentTone = (lightness: number): Hsl =>
    ({ h: accentHue, s: skeleton.accentSaturation, l: lightness });
  let steps = 0;
  while (
    contrastRatio(accentTone(skeleton.accentLightness), background) < target.nonText
    && steps < 60
  ) {
    const next = skeleton.accentLightness - ladder.direction * 2;
    if (next < 0 || next > 100) break;
    skeleton.accentLightness = next;
    steps += 1;
  }

  return skeleton;
}

function buildColors(spec: ThemeSpecV2, ramp: Ramp): Record<string, Hsl> {
  const { ladder, surfaceHue, surfaceSaturation, target } = ramp;
  const { statusHueShift } = spec.palette;
  const statusSaturation = STATUS_SATURATION[spec.palette.accentChroma];

  const surface = (tier: number, scale = 1): Hsl =>
    ({ h: surfaceHue, s: surfaceSaturation * scale, l: tierOf(ladder.toward, tier) });

  const background = surface(0, 0.7);
  const card = { h: surfaceHue, s: surfaceSaturation * 0.4, l: tierOf(ladder.lighter, 1) };
  const popover = { h: surfaceHue, s: surfaceSaturation * 0.4, l: tierOf(ladder.lighter, 2) };
  const muted = surface(2);
  const accentSurface = surface(2, 0.9);
  const secondary = { h: ramp.supportHue, s: surfaceSaturation, l: tierOf(ladder.toward, 2) };

  const tone = (scale: number) => (lightness: number): Hsl =>
    ({ h: surfaceHue, s: surfaceSaturation * scale, l: lightness });

  const readable = (background_: Hsl, minimum: number, scale = 0.5): Hsl => {
    const values = inkLadderFor(ladder, tone(scale), background_);
    return tone(scale)(tierOf(values, solveTier(values, tone(scale), background_, minimum)));
  };

  // A foreground that must sit on more than one surface is solved against the
  // harder of them, not against whichever one was written first.
  const mutedFloor = target.text;
  const mutedForeground = tierOf(ladder.toward, Math.max(
    solveTier(ladder.toward, tone(0.6), background, mutedFloor),
    solveTier(ladder.toward, tone(0.6), card, mutedFloor),
  ));

  const primary: Hsl = { h: ramp.accentHue, s: ramp.accentSaturation, l: ramp.accentLightness };
  // The pole that can actually reach the floor, rather than assuming light text
  // on a dark button: a mid-lightness accent is only readable from one side.
  const primaryForeground: Hsl = contrastRatio({ h: ramp.accentHue, s: 10, l: 100 }, primary)
    >= contrastRatio({ h: ramp.accentHue, s: 10, l: 0 }, primary)
    ? { h: ramp.accentHue, s: 10, l: 100 }
    : { h: ramp.accentHue, s: 10, l: 0 };

  const status = (hue: number): Hsl => {
    const shifted = wrapHue(hue + statusHueShift);
    let lightness = ladder.direction > 0 ? 58 : 38;
    let steps = 0;
    while (
      contrastRatio({ h: shifted, s: statusSaturation, l: lightness }, background) < target.nonText
      && steps < 60
    ) {
      const next = lightness - ladder.direction * 2;
      if (next < 0 || next > 100) break;
      lightness = next;
      steps += 1;
    }
    return { h: shifted, s: statusSaturation, l: lightness };
  };

  const statusForeground = (color: Hsl): Hsl =>
    (contrastRatio({ h: 0, s: 0, l: 100 }, color) >= contrastRatio({ h: 0, s: 0, l: 0 }, color)
      ? { h: 0, s: 0, l: 100 }
      : { h: 0, s: 0, l: 0 });

  const destructive = status(STATUS_HUES.destructive);
  const positive = status(STATUS_HUES.positive);
  const warning = status(STATUS_HUES.warning);

  return {
    background,
    foreground: readable(background, target.text),
    card,
    'card-foreground': readable(card, target.text),
    popover,
    'popover-foreground': readable(popover, target.text),
    secondary,
    'secondary-foreground': readable(secondary, target.text, 0.6),
    muted,
    'muted-foreground': tone(0.6)(mutedForeground),
    accent: accentSurface,
    'accent-foreground': readable(accentSurface, target.text, 0.6),
    border: readable(background, target.nonText, 1),
    input: readable(background, target.nonText, 1),

    primary,
    'primary-foreground': primaryForeground,
    // A copy, not the same object. `ring` and `primary` sharing one Hsl means
    // the ring/background pair walks the primary the foreground pair just
    // finished solving, and the earlier pair silently comes undone — a bug that
    // only shows up at the tighter targets, where there is no slack to absorb it.
    ring: { ...primary },

    destructive,
    'destructive-foreground': statusForeground(destructive),
    positive,
    'positive-foreground': statusForeground(positive),
    warning,
    'warning-foreground': statusForeground(warning),
  };
}

/**
 * Walks foregrounds toward their pole until every pair clears its floor.
 *
 * The tier solver above already targets the floor directly, so this almost
 * never fires. It stays because "almost never" is not "never": saturation
 * shifts luminance in ways the ladder does not model, and the guarantee this
 * system sells is not allowed to depend on a model being approximately right.
 */
function solveContrast(
  colors: Record<string, Hsl>,
  target: ContrastTarget,
): { adjusted: string[]; minRatio: number } {
  const adjusted = new Set<string>();
  let minRatio = Number.POSITIVE_INFINITY;

  for (const pair of CONTRAST_PAIRS) {
    const background = colors[pair.background];
    const foreground = colors[pair.foreground];
    if (!background || !foreground) continue;

    const minimum = pairMinimum(pair, target);
    if (contrastRatio(foreground, background) >= minimum) {
      minRatio = Math.min(minRatio, contrastRatio(foreground, background));
      continue;
    }

    const towardWhite = contrastRatio({ ...foreground, l: 100 }, background);
    const towardBlack = contrastRatio({ ...foreground, l: 0 }, background);
    const direction = towardWhite >= towardBlack ? 1 : -1;

    let steps = 0;
    while (contrastRatio(foreground, background) < minimum && steps < 60) {
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
    while (contrastRatio(foreground, background) < minimum && backgroundSteps < 60) {
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

/** CSS position keywords for a gradient origin. */
const ORIGIN_POSITIONS: Record<string, string> = {
  center: 'center',
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right',
  'top-left': 'left top',
  'top-right': 'right top',
  'bottom-left': 'left bottom',
  'bottom-right': 'right bottom',
};

/** Renders one fill layer as a CSS `<image>`. */
function formatFillLayer(layer: ResolvedFillLayer, ramp: Ramp): string {
  const paint = layer.stops.map((stop) => {
    const { color, alpha } = resolveColorRef(stop.color, ramp);
    return { value: formatColor(color, alpha), position: stop.position };
  });

  if (layer.kind === 'solid') {
    return `linear-gradient(${paint[0].value}, ${paint[0].value})`;
  }

  if (layer.kind === 'repeating-linear') {
    // Bands are emitted as explicit pixel runs rather than percentages so the
    // stripe period is the authored `band` regardless of how big the element
    // is — a stripe that rescales with its container is not a stripe.
    const runs = paint.map((stop, index) =>
      `${stop.value} ${index * layer.band}px ${(index + 1) * layer.band}px`);
    return `repeating-linear-gradient(${layer.angle}deg, ${runs.join(', ')})`;
  }

  const stops = paint
    .map((stop) => (stop.position === null ? stop.value : `${stop.value} ${stop.position}%`))
    .join(', ');

  if (layer.kind === 'linear') return `linear-gradient(${layer.angle}deg, ${stops})`;
  if (layer.kind === 'radial') {
    return `radial-gradient(${layer.shape} at ${ORIGIN_POSITIONS[layer.origin]}, ${stops})`;
  }
  return `conic-gradient(from ${layer.angle}deg at ${ORIGIN_POSITIONS[layer.origin]}, ${stops})`;
}

/** Renders the shadow stack, or `none`. */
function formatShadows(shadows: ResolvedShadow[], ramp: Ramp): string {
  if (shadows.length === 0) return 'none';

  return shadows.map((shadow) => {
    const { color, alpha } = resolveColorRef(shadow.color, ramp);
    const value = formatColor(color, shadow.alpha ?? alpha);
    const geometry = `${shadow.x}px ${shadow.y}px ${shadow.blur}px ${shadow.spread}px`;
    return `${shadow.inset ? 'inset ' : ''}${geometry} ${value}`;
  }).join(', ');
}

/**
 * The colour a surface actually presents to the eye.
 *
 * Fill layers are composited bottom-up over the page background, and a gradient
 * contributes the average of its stops. Approximate on purpose — the exact
 * luminance under a diagonal gradient varies across the surface — but
 * approximating and then solving is the only way translucent and gradient
 * surfaces get the same legibility guarantee flat ones have always had.
 */
function flattenFill(recipe: ResolvedSurfaceRecipe, ramp: Ramp): Hsl {
  let result: Hsl = { h: ramp.surfaceHue, s: ramp.surfaceSaturation * 0.7, l: ramp.ladder.toward[0] };

  for (const layer of [...recipe.fill].reverse()) {
    const resolved = layer.stops.map((stop) => resolveColorRef(stop.color, ramp));
    const average: Hsl = {
      h: resolved[0].color.h,
      s: resolved.reduce((total, stop) => total + stop.color.s, 0) / resolved.length,
      l: resolved.reduce((total, stop) => total + stop.color.l, 0) / resolved.length,
    };
    const alpha = resolved.reduce((total, stop) => total + stop.alpha, 0) / resolved.length;
    result = compositeOver(average, alpha, result);
  }

  return result;
}

/** The per-part token block, plus the worst contrast ratio it contains. */
function buildSurfaceTokens(
  recipe: ResolvedSurfaceRecipe,
  ramp: Ramp,
  part: SurfacePart,
): { tokens: Record<string, string>; ratio: number; adjusted: string[] } {
  const adjusted: string[] = [];
  const effective = flattenFill(recipe, ramp);

  const inkTone = (scale: number) => (lightness: number): Hsl =>
    ({ h: ramp.surfaceHue, s: ramp.surfaceSaturation * scale, l: lightness });

  // Ink is held well above the floor and muted sits at it, so the two are
  // visibly different weights of text rather than the same colour twice.
  const inkFloor = Math.min(ramp.target.text * 1.6, 15);
  const values = inkLadderFor(ramp.ladder, inkTone(0.35), effective);
  const mutedTier = solveTier(
    values, inkTone(0.5), effective, ramp.target.text, recipe.ink.mutedTier ?? 1,
  );
  const inkTier = solveTier(
    values, inkTone(0.35), effective, inkFloor, Math.max(mutedTier, recipe.ink.tier ?? 1),
  );

  if (recipe.ink.tier !== null && inkTier !== recipe.ink.tier) {
    adjusted.push(`surfaces.${part}.ink.tier`);
  }
  if (recipe.ink.mutedTier !== null && mutedTier !== recipe.ink.mutedTier) {
    adjusted.push(`surfaces.${part}.ink.mutedTier`);
  }

  const ink = inkTone(0.35)(tierOf(values, inkTier));
  const inkMuted = inkTone(0.5)(tierOf(values, mutedTier));

  // Two different reports, because they are two different situations, and
  // collapsing them would make the guarantee unfalsifiable.
  //
  // Missing the theme's *chosen* target is ordinary: a 40%-opaque scrim over a
  // mid-grey page composites to a mid-grey, and no colour reads at 7:1 on that.
  // The author asked for something the physics of their own fill will not give,
  // and saying so is the useful response.
  //
  // Missing the AA floor is a defect. AA is the promise the whole system makes,
  // and it is enforced by construction — the ink ladder can always reach one
  // pole or the other. This report exists so that if the promise ever stops
  // holding, it stops loudly rather than shipping grey text on grey.
  const achieved = contrastRatio(ink, effective);
  if (achieved < HARD_TEXT_FLOOR) {
    adjusted.push(`surfaces.${part}.fill`);
  } else if (achieved < ramp.target.text) {
    adjusted.push(`surfaces.${part}.ink.target`);
  }

  // A link on a glass popover has to clear the floor against the popover, not
  // against the page — this is the token that makes accent-coloured text safe
  // on any surface a theme invents.
  const accentTone = (lightness: number): Hsl =>
    ({ h: ramp.accentHue, s: ramp.accentSaturation, l: lightness });
  const accentDirection = contrastRatio(accentTone(100), effective)
    >= contrastRatio(accentTone(0), effective) ? 1 : -1;
  let accentOn: Hsl = accentTone(ramp.accentLightness);
  let accentSteps = 0;
  while (contrastRatio(accentOn, effective) < ramp.target.text && accentSteps < 60) {
    const next = accentOn.l + accentDirection * 2;
    if (next < 0 || next > 100) break;
    accentOn = { ...accentOn, l: next };
    accentSteps += 1;
  }

  const ring = recipe.border.variant === 'gradient-ring' ? recipe.border.ring : null;
  const useRing = ring !== null;

  const ringImage = ring
    ? `linear-gradient(${ring.angle}deg, ${ring.stops.map((stop) => {
      const { color, alpha } = resolveColorRef(stop.color, ramp);
      return stop.position === null
        ? formatColor(color, alpha)
        : `${formatColor(color, alpha)} ${stop.position}%`;
    }).join(', ')})`
    : 'none';

  const fills = recipe.fill.map((layer) => ({
    image: formatFillLayer(layer, ramp),
    blend: layer.blend as string,
    box: 'padding-box',
  }));

  // A gradient border and a border radius are famously incompatible:
  // `border-image` squares the corners off. Painting the ring as a background
  // layer clipped to the border box, with the fill clipped to the padding box,
  // is the one construction that follows the radius — and doing it here rather
  // than in the renderer means the renderer needs no extra element and no
  // special case, only two more custom properties.
  const bottom = recipe.fill[recipe.fill.length - 1];
  const bottomIsOpaqueSolid = !useRing
    && bottom?.kind === 'solid'
    && (bottom.stops[0].color.alpha ?? 1) >= 1;

  const painted = bottomIsOpaqueSolid ? fills.slice(0, -1) : fills;
  if (useRing) painted.push({ image: ringImage, blend: 'normal', box: 'border-box' });

  const fillColor = bottomIsOpaqueSolid
    ? (() => {
      const { color, alpha } = resolveColorRef(bottom.stops[0].color, ramp);
      return formatColor(color, alpha);
    })()
    : 'transparent';

  const sideWidth = (side: 'top' | 'right' | 'bottom' | 'left'): string =>
    `${recipe.border.style === 'none' ? 0 : recipe.border.sides.includes(side) ? recipe.border.width : 0}px`;

  const borderColor = useRing
    ? 'transparent'
    : (() => {
      const { color, alpha } = resolveColorRef(recipe.border.color, ramp);
      return formatColor(color, alpha);
    })();

  const texture = readTexturePaint(
    recipe.texture.kind, recipe.texture.scale, recipe.texture.opacity,
  );
  const tint = {
    light: (alpha: number) => {
      const resolved = resolveColorRef({ role: 'light', tier: 8 }, ramp);
      return formatColor(resolved.color, alpha);
    },
    shadow: (alpha: number) => {
      const resolved = resolveColorRef({ role: 'shadow', tier: 8 }, ramp);
      return formatColor(resolved.color, alpha);
    },
  };
  const overlay = readOverlayPaint(
    recipe.overlay.kind, recipe.overlay.angle, recipe.overlay.strength, tint,
  );

  const refraction = recipe.backdrop?.refraction ?? 0;
  const backdrop = recipe.backdrop
    ? [
      `blur(${recipe.backdrop.blur}px)`,
      `saturate(${recipe.backdrop.saturate})`,
      `brightness(${recipe.backdrop.brightness})`,
      // Refraction has no CSS primitive in Chromium 140. Half of it lands as a
      // contrast lift in the filter chain and half as an inner edge highlight
      // folded into the shadow stack below; between them the edge reads as
      // bending light rather than as a blur with a line drawn on it.
      ...(refraction > 0 ? [`contrast(${round(1 + refraction * 0.2)})`] : []),
    ].join(' ')
    : 'none';

  // Prepended rather than appended: box-shadow paints the first layer on top,
  // and a specular rim that sits under an ambient shadow is not a rim.
  const shadowStack = refraction > 0
    ? `inset 0 0 ${round(6 + refraction * 18)}px ${-round(2 + refraction * 6)}px ${tint.light(refraction * 0.45)}, ${formatShadows(recipe.shadows, ramp)}`
      .replace(/, none$/, '')
    : formatShadows(recipe.shadows, ramp);

  // `square` is emitted as a zero radius rather than as `corner-shape: square`
  // so it is square on every engine, not only on those with corner-shape.
  const cornerShape = recipe.corner.shape === 'squircle'
    ? 'superellipse(4)'
    : recipe.corner.shape === 'square'
      ? 'round'
      : recipe.corner.shape;

  return {
    ratio: contrastRatio(ink, effective),
    adjusted,
    tokens: {
      't-fill-color': fillColor,
      't-fill-image': painted.length > 0 ? painted.map((entry) => entry.image).join(', ') : 'none',
      't-fill-blend': painted.length > 0 ? painted.map((entry) => entry.blend).join(', ') : 'normal',
      // Both boxes are emitted as per-layer lists so the renderer can set
      // `background-clip` and `background-origin` unconditionally.
      't-fill-clip': painted.length > 0 ? painted.map((entry) => entry.box).join(', ') : 'border-box',
      't-fill-origin': painted.length > 0 ? painted.map((entry) => entry.box).join(', ') : 'padding-box',
      't-border-width': `${sideWidth('top')} ${sideWidth('right')} ${sideWidth('bottom')} ${sideWidth('left')}`,
      't-border-style': useRing && recipe.border.style === 'none' ? 'solid' : recipe.border.style,
      't-border-color': borderColor,
      't-radius': `${recipe.corner.shape === 'square' ? 0 : recipe.corner.radius}px`,
      't-corner-shape': cornerShape,
      't-shadow': shadowStack,
      't-backdrop': backdrop,
      't-texture-image': texture?.image ?? 'none',
      't-texture-size': texture?.size ?? 'auto',
      // 0 or 1, never the authored strength: the strength is already in the
      // image's own pixels. Emitting it here as well would let a renderer that
      // applies `opacity: var(--t-texture-opacity)` square it, which is the
      // kind of bug that looks like "the grain is too subtle" for a week.
      't-texture-opacity': texture ? '1' : '0',
      't-texture-blend': recipe.texture.blend,
      't-overlay-image': overlay?.image ?? 'none',
      't-overlay-opacity': overlay ? '1' : '0',
      't-overlay-blend': overlay?.blend ?? 'normal',
      't-ink': formatColor(ink),
      't-ink-muted': formatColor(inkMuted),
      't-ink-shadow': recipe.ink.glow > 0
        ? `0 0 ${round(2 + recipe.ink.glow * 10)}px ${formatColor(ink, clamp(recipe.ink.glow, 0, 1) * 0.8)}`
        : 'none',
      't-accent-on': formatColor(accentOn),
    },
  };
}

/**
 * The tone variants, keyed by `data-tails-surface`.
 *
 * A second axis to `data-tails-part`: a card is a card, but a *selected* card is
 * raised and a *disabled* one is flush. Without this the renderer would have to
 * hard-code `bg-muted` for those states, which is exactly the kind of literal
 * that stops following the theme.
 */
function buildToneTokens(ramp: Ramp, colors: Record<string, Hsl>): Record<string, Record<string, string>> {
  const surfaceTone = (lightness: number): Hsl =>
    ({ h: ramp.surfaceHue, s: ramp.surfaceSaturation * 0.6, l: lightness });

  const inkFor = (background: Hsl): string => {
    const tone = (lightness: number): Hsl =>
      ({ h: ramp.surfaceHue, s: ramp.surfaceSaturation * 0.35, l: lightness });
    const values = inkLadderFor(ramp.ladder, tone, background);
    return formatColor(tone(tierOf(values, solveTier(values, tone, background, ramp.target.text))));
  };

  const raised = surfaceTone(tierOf(ramp.ladder.lighter, 2));
  const sunken = surfaceTone(tierOf(ramp.ladder.darker, 2));
  const inverted = { h: ramp.surfaceHue, s: ramp.surfaceSaturation * 0.35, l: tierOf(ramp.ladder.toward, LADDER_TIERS - 1) };
  const accent = colors.primary;

  return {
    flush: {
      't-fill-color': formatColor(colors.background),
      't-ink': inkFor(colors.background),
    },
    raised: {
      't-fill-color': formatColor(raised),
      't-ink': inkFor(raised),
    },
    sunken: {
      't-fill-color': formatColor(sunken),
      't-ink': inkFor(sunken),
    },
    inverted: {
      't-fill-color': formatColor(inverted),
      't-ink': formatColor(colors.background),
    },
    accent: {
      't-fill-color': formatColor(accent),
      't-ink': formatColor(colors['primary-foreground']),
    },
  };
}

function buildNonColorTokens(spec: ThemeSpecV2): Pick<ThemeTokens, 'lengths' | 'fonts' | 'durations' | 'easings'> {
  const feel = MOTION_FEEL[spec.motion];
  const defaultRecipe = mergeRecipe(BASELINE_RECIPE, spec.surfaces.default);

  return {
    lengths: {
      // `--radius` and `--border-width` mirror the default recipe so Tailwind's
      // `rounded-lg` and the global `border-color` rule follow the theme even on
      // elements that carry no `data-tails-part`.
      radius: `${defaultRecipe.corner.shape === 'square' ? 0 : defaultRecipe.corner.radius}px`,
      'border-width': `${defaultRecipe.border.style === 'none' ? 0 : defaultRecipe.border.width}px`,
      'space-unit': SPACE_UNIT[spec.density],
      'font-size-base': FONT_SIZE[spec.type.scale],
      'letter-spacing-base': TRACKING[spec.type.letterSpacing],
      'display-weight': DISPLAY_WEIGHT[spec.type.displayWeight],
      'line-height-base': LINE_HEIGHT[spec.type.lineHeight],
      measure: MEASURE[spec.type.measure],
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
 * unchanged after a schema version bump. v1 specs are upgraded on the way in
 * rather than handled separately, so there is exactly one derivation to keep
 * correct.
 */
export function deriveTokens(rawSpec: ThemeSpec): DerivedTheme {
  const spec = upgradeSpec(rawSpec);
  const shared = buildNonColorTokens(spec);

  const buildOne = (mode: 'light' | 'dark') => {
    const ramp = buildRamp(spec, mode);
    const colors = buildColors(spec, ramp);
    const solved = solveContrast(colors, spec.surface.contrastTarget);

    const adjusted = [...solved.adjusted];
    if (ramp.ladder.anchorMoved) {
      adjusted.push(`surface.${mode}Anchor`);
    }

    const surfaces: Record<string, Record<string, string>> = {};
    let minRatio = solved.minRatio;

    const base = mergeRecipe(BASELINE_RECIPE, spec.surfaces.default);
    for (const part of SURFACE_PARTS) {
      const recipe = part === 'default' ? base : mergeRecipe(base, spec.surfaces[part]);
      const built = buildSurfaceTokens(recipe, ramp, part);
      surfaces[part] = built.tokens;
      adjusted.push(...built.adjusted);
      minRatio = Math.min(minRatio, built.ratio);
    }

    return {
      tokens: { colors, ...shared, surfaces, tones: buildToneTokens(ramp, colors) } as ThemeTokens,
      adjusted,
      minRatio,
    };
  };

  // A single-mode theme still needs its one ramp built for the mode it pins.
  if (rawSpec.mode === 'dark') {
    const dark = buildOne('dark');
    return { light: dark.tokens, dark: dark.tokens, adjusted: dark.adjusted, minRatio: dark.minRatio };
  }
  if (rawSpec.mode === 'light') {
    const light = buildOne('light');
    return { light: light.tokens, dark: null, adjusted: light.adjusted, minRatio: light.minRatio };
  }

  const light = buildOne('light');
  const dark = buildOne('dark');
  return {
    light: light.tokens,
    dark: dark.tokens,
    adjusted: [...new Set([...light.adjusted, ...dark.adjusted])],
    minRatio: Math.min(light.minRatio, dark.minRatio),
  };
}

/** The contrast pairs, exported so tests can assert the shipped default ramp too. */
export { CONTRAST_PAIRS };
export type { ContrastPair };
