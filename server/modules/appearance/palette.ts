/**
 * Colour maths and the lightness ladder every theme is built on.
 *
 * The v1 engine guaranteed legibility with a fixed table: dark backgrounds were
 * pinned at 6% lightness, light ones at 98%, and nothing could move them. That
 * bought safety at the cost of a whole design space — true-black OLED, mid-grey
 * editorial and paper-white were all literally unreachable, and every dark
 * theme was the same dark.
 *
 * This module replaces the table with a solver. The author picks where the
 * surface sits and how hard the contrast should be; the ladder is derived from
 * those, and the anchor itself is walked away from the ink pole if the target
 * cannot be met from where it started. The invariant is unchanged — a theme
 * that cannot be read is impossible — but it is now enforced by solving rather
 * than by refusing to let anyone choose.
 */

/**
 * A colour in the `H S% L%` grammar the stylesheet uses.
 *
 * Kept as components rather than a formatted string so the contrast solver can
 * walk lightness without reparsing.
 */
export type Hsl = { h: number; s: number; l: number };

/**
 * Where the base surface sits on the lightness axis.
 *
 * Seven named points rather than a free number because the interesting
 * territory is not uniformly distributed: the difference between 0% and 5% is
 * the difference between OLED black and "very dark grey", while 60% and 65% are
 * the same design. Naming the landmarks puts the meaningful choices one token
 * apart in the model's output.
 */
export const SURFACE_ANCHORS = {
  'true-black': 0,
  'near-black': 5,
  deep: 11,
  dim: 20,
  mid: 46,
  paper: 96,
  'true-white': 100,
} as const;

export type SurfaceAnchor = keyof typeof SURFACE_ANCHORS;

export const SURFACE_ANCHOR_NAMES = Object.keys(SURFACE_ANCHORS) as [SurfaceAnchor, ...SurfaceAnchor[]];

/**
 * Contrast floors by authored target.
 *
 * `aa` is the legal floor, `aaa` the enhanced one, and `max` is not a WCAG
 * level at all — it is "push everything apart", which is what a terminal or a
 * high-glare look actually wants. Non-text floors track WCAG 1.4.11 rather than
 * the text number, because holding a border to 4.5:1 produces borders that
 * shout.
 */
export const CONTRAST_TARGETS = {
  aa: { text: 4.5, nonText: 3 },
  aaa: { text: 7, nonText: 3 },
  max: { text: 11, nonText: 4.5 },
} as const;

export type ContrastTarget = keyof typeof CONTRAST_TARGETS;

export const CONTRAST_TARGET_NAMES = Object.keys(CONTRAST_TARGETS) as [ContrastTarget, ...ContrastTarget[]];

/** The number of rungs on the ladder. Tier 0 is the page, tier 12 is the ink pole. */
export const LADDER_TIERS = 13;

export const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

export const wrapHue = (hue: number): number => ((hue % 360) + 360) % 360;

/** sRGB components 0-1 for an HSL colour. */
export function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const saturation = clamp(s, 0, 100) / 100;
  const lightness = clamp(l, 0, 100) / 100;
  const hue = wrapHue(h);

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;

  const sector = Math.floor(hue / 60) % 6;
  const triple: [number, number, number] = (
    sector === 0 ? [chroma, secondary, 0]
      : sector === 1 ? [secondary, chroma, 0]
        : sector === 2 ? [0, chroma, secondary]
          : sector === 3 ? [0, secondary, chroma]
            : sector === 4 ? [secondary, 0, chroma]
              : [chroma, 0, secondary]
  );

  return [triple[0] + match, triple[1] + match, triple[2] + match];
}

/** The inverse of `hslToRgb`, used when compositing a translucent fill. */
export function rgbToHsl([r, g, b]: [number, number, number]): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return { h: 0, s: 0, l: lightness * 100 };

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue = max === r
    ? 60 * (((g - b) / delta) % 6)
    : max === g
      ? 60 * ((b - r) / delta + 2)
      : 60 * ((r - g) / delta + 4);

  return { h: wrapHue(hue), s: clamp(saturation * 100, 0, 100), l: lightness * 100 };
}

/** WCAG relative luminance for an HSL colour. */
export function relativeLuminance(color: Hsl): number {
  const linearize = (channel: number) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

  const [r, g, b] = hslToRgb(color).map((channel) => linearize(clamp(channel, 0, 1)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours. */
export function contrastRatio(a: Hsl, b: Hsl): number {
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Flattens a translucent colour against what sits behind it.
 *
 * Contrast is a property of what the eye receives, not of what was authored. A
 * glass card at 55% alpha is legible or not depending on the page under it, so
 * every ink decision composites first and measures second. Without this, glass
 * is the one surface type where the legibility guarantee quietly stops holding.
 */
export function compositeOver(color: Hsl, alpha: number, backdrop: Hsl): Hsl {
  if (alpha >= 1) return color;

  const front = hslToRgb(color);
  const back = hslToRgb(backdrop);
  return rgbToHsl([
    front[0] * alpha + back[0] * (1 - alpha),
    front[1] * alpha + back[1] * (1 - alpha),
    front[2] * alpha + back[2] * (1 - alpha),
  ]);
}

/**
 * The three lightness ladders a ramp exposes.
 *
 * `toward` runs from the page background to the ink pole, and is what `tier`
 * means everywhere in a surface recipe: tier 2 is "two steps more contrasty
 * than the page" in a dark theme and in a light theme alike, which is what lets
 * one recipe read correctly in both ramps.
 *
 * `lighter` and `darker` run to the white and black poles regardless of mode.
 * They exist because "a card raised above the page" is lighter than the page in
 * both a light and a dark theme — a fact `toward` cannot express, since it
 * points at black in a light theme.
 */
export type Ladder = {
  toward: number[];
  lighter: number[];
  darker: number[];
  /** +1 when the ink pole is white, -1 when it is black. */
  direction: 1 | -1;
  /** The anchor actually used, after any contrast-driven correction. */
  anchor: number;
  /** True when the authored anchor could not meet the text target and was moved. */
  anchorMoved: boolean;
};

/**
 * Builds the ladder for one ramp.
 *
 * The curve is a power function fitted so that the first rung lands `step`
 * lightness points from the anchor and the last rung lands exactly on the pole.
 * Fitting rather than accumulating matters: an accumulating ladder with a large
 * step runs off the end of the scale and clamps, collapsing the top four tiers
 * into one colour and quietly destroying the contrast headroom the solver needs.
 */
export function buildLadder(options: {
  anchor: SurfaceAnchor;
  mode: 'light' | 'dark';
  step: number;
  textTarget: number;
  hue: number;
  saturation: number;
}): Ladder {
  const { step, textTarget, hue, saturation } = options;
  const start: number = SURFACE_ANCHORS[options.anchor];

  // Around the middle of the scale both poles are roughly as legible, so the
  // anchor alone cannot say which way the ink runs. The ramp breaks the tie:
  // mid-grey in the light ramp is newsprint and takes dark ink; mid-grey in the
  // dark ramp is a lifted charcoal and takes light ink. Outside that band the
  // anchor decides, because there is only ever one workable answer.
  const direction: 1 | -1 = start >= 34 && start <= 66
    ? (options.mode === 'light' ? -1 : 1)
    : (start < 50 ? 1 : -1);
  const pole = direction > 0 ? 100 : 0;
  const inkColor = { h: hue, s: 0, l: pole };

  const roundTo = (value: number) => Math.round(clamp(value, 0, 100) * 10) / 10;
  const unit = (distance: number) => Math.max(1.5, Math.min(step, distance / 6));

  const shape = (anchor: number): Omit<Ladder, 'anchorMoved'> => {
    const span = Math.abs(pole - anchor);
    // Fitting the curve to land exactly on the pole, rather than accumulating a
    // fixed step, is what keeps the top of the ladder usable: an accumulating
    // ladder with a large step runs off the scale and clamps, collapsing the
    // last four tiers into one colour and destroying the headroom the solver
    // needs.
    const fraction = clamp(step / Math.max(span, 1), 0.02, 0.95);
    const gamma = clamp(Math.log(fraction) / Math.log(1 / (LADDER_TIERS - 1)), 0.35, 3);

    return {
      toward: Array.from({ length: LADDER_TIERS }, (_, tier) =>
        roundTo(anchor + direction * span * (tier / (LADDER_TIERS - 1)) ** gamma)),
      // The pole-relative ladders keep a floor under their step so a paper
      // anchor, which has four points of headroom to white, still separates its
      // tiers visibly instead of emitting twelve copies of the same colour.
      lighter: Array.from({ length: LADDER_TIERS }, (_, tier) =>
        roundTo(anchor + tier * unit(100 - anchor))),
      darker: Array.from({ length: LADDER_TIERS }, (_, tier) =>
        roundTo(anchor - tier * unit(anchor))),
      direction,
      anchor,
    };
  };

  // Walk the anchor away from the ink pole until the *hardest* surface on the
  // ladder — not just the page — can still carry text at the target. Checking
  // only the page is the subtle version of the bug this rebuild is fixing: a
  // mid-grey page passes on its own and then its raised card, two rungs closer
  // to the ink pole, quietly does not.
  let anchor = start;
  let anchorMoved = false;
  for (let guard = 0; guard < 120; guard += 1) {
    const candidate = shape(anchor);
    const hardest = direction > 0
      ? Math.max(candidate.toward[2], candidate.lighter[2])
      : Math.min(candidate.toward[2], candidate.darker[2]);

    if (contrastRatio(inkColor, { h: hue, s: saturation, l: hardest }) >= textTarget) {
      return { ...candidate, anchorMoved };
    }

    const next = anchor - direction;
    if (next < 0 || next > 100) return { ...candidate, anchorMoved };
    anchor = next;
    anchorMoved = true;
  }

  return { ...shape(anchor), anchorMoved };
}

/**
 * The lowest rung of a ladder that clears a contrast floor against a background.
 *
 * Lowest rather than highest so text stays as close to its surface as
 * legibility allows: jumping straight to the pole would make every theme's body
 * copy pure white, which is the look of a system that does not trust itself.
 */
export function solveTier(
  values: number[],
  tone: (lightness: number) => Hsl,
  background: Hsl,
  minimum: number,
  from = 1,
): number {
  for (let tier = clamp(from, 0, LADDER_TIERS - 1); tier < LADDER_TIERS; tier += 1) {
    if (contrastRatio(tone(values[tier]), background) >= minimum) return tier;
  }
  return LADDER_TIERS - 1;
}

/**
 * The lightness ladder text on an arbitrary surface should search.
 *
 * Normally that is the ramp's own `toward` ladder, which is what makes `tier`
 * mean the same thing everywhere. But a surface filled with the accent colour —
 * a primary button, a user's chat bubble — inverts the problem: in a dark theme
 * `toward` runs to white, and white on a bright accent is 2:1. When the far
 * pole is the wrong pole, this returns a ladder running from the surface's own
 * lightness to the *other* pole, so an inverted surface gets legible text
 * instead of the least-bad rung of a ladder pointing the wrong way.
 */
export function inkLadderFor(
  ladder: Ladder,
  tone: (lightness: number) => Hsl,
  surface: Hsl,
): number[] {
  const pole = ladder.toward[LADDER_TIERS - 1];
  const opposite = pole >= 50 ? 0 : 100;
  if (contrastRatio(tone(pole), surface) >= contrastRatio(tone(opposite), surface)) {
    return ladder.toward;
  }

  return Array.from({ length: LADDER_TIERS }, (_, tier) =>
    Math.round((surface.l + (opposite - surface.l) * (tier / (LADDER_TIERS - 1))) * 10) / 10);
}
