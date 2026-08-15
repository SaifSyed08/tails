import { z } from 'zod';

import {
  CONTRAST_TARGET_NAMES,
  SURFACE_ANCHOR_NAMES,
} from '@/modules/appearance/palette.js';
import { surfacesMapSchema } from '@/modules/appearance/surface-recipe.js';

/**
 * The authored theme surface — everything a model may decide about how the app
 * looks.
 *
 * There are still no hex codes, no `url()`, no font names outside a bundled
 * set and no CSS in a spec. What changed in v2 is the *shape* of the freedom:
 * v1 offered fifteen global enums, seven of which the derivation quietly threw
 * away, so every generated theme was a hue rotation of the default. v2 offers a
 * small compositional vocabulary — fills, borders, corners, shadows, backdrops,
 * textures, overlays — applied per surface, and emits every field it accepts.
 *
 * Lightness is still not authored directly. It is derived from a named anchor
 * and a contrast target and then solved (see `palette.ts`), so the guarantee
 * survives: hue, chroma and structure cannot combine into something unreadable.
 */

/** Bundled font stacks. A free-form family name would either hit the network or silently fall back. */
export const FONT_FAMILIES = {
  'system-sans': "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  grotesk: "'Inter', 'Helvetica Neue', Arial, sans-serif",
  geometric: "'Poppins', 'Century Gothic', system-ui, sans-serif",
  humanist: "'Optima', 'Gill Sans', 'Segoe UI', sans-serif",
  serif: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  slab: "'Rockwell', 'Courier Bold', Georgia, serif",
  display: "'Futura', 'Trebuchet MS', system-ui, sans-serif",
  mono: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, monospace",
} as const;

export type FontFamilyName = keyof typeof FONT_FAMILIES;

const FONT_ENUM = Object.keys(FONT_FAMILIES) as [FontFamilyName, ...FontFamilyName[]];

/** Shared by both spec versions: the fields that were right the first time. */
const paletteSchema = z.object({
  surfaceHue: z.number().int().min(0).max(360)
    .describe('Base hue for backgrounds, cards and borders, 0-360. Surfaces usually look best either fully neutral or within ~40 degrees of the accent hue.'),
  surfaceChroma: z.enum(['neutral', 'tinted', 'rich'])
    .describe('How much colour the backgrounds carry. "neutral" is near-grey, "tinted" is a subtle wash, "rich" is unmistakably coloured.'),
  accentHue: z.number().int().min(0).max(360)
    .describe('Hue for buttons, links, focus rings and the primary action colour, 0-360.'),
  accentChroma: z.enum(['muted', 'vivid', 'electric'])
    .describe('Accent intensity. "muted" is restrained and editorial, "vivid" is confident, "electric" is high-energy and works best against dark or neutral surfaces.'),
  scheme: z.enum(['mono', 'analogous', 'complement', 'triad'])
    .describe('How the secondary ("support") hue relates to the accent. "mono" reuses it, "analogous" shifts 30 degrees, "complement" opposes it, "triad" shifts 120.'),
  statusHueShift: z.number().int().min(-15).max(15).default(0)
    .describe('Nudges the success/warning/danger hues by up to 15 degrees so they sit with the palette. Kept small on purpose: a danger colour that stops reading as danger is an accessibility failure, not personalisation.'),
}).strict();

const motionSchema = z.enum(['instant', 'calm', 'standard', 'playful'])
  .describe('How the interface moves. "instant" is nearly immediate, "playful" overshoots slightly. This is honoured everywhere, including reduced-motion users, who get no animation regardless.');

const densitySchema = z.enum(['tight', 'default', 'airy'])
  .describe('Spacing between things. "tight" fits more on screen, "airy" feels calmer.');

/**
 * v1, frozen.
 *
 * Kept parseable rather than migrated in place because saved themes reference
 * it and a spec the app can no longer read is a look the user cannot edit. New
 * themes must be v2; this exists so old ones still open.
 */
export const themeSpecV1Schema = z.object({
  specVersion: z.literal(1),
  name: z.string().min(1).max(40),
  summary: z.string().min(1).max(140),
  mode: z.enum(['adaptive', 'light', 'dark']),
  palette: paletteSchema,
  type: z.object({
    sansFamily: z.enum(FONT_ENUM),
    displayFamily: z.enum(FONT_ENUM),
    monoFamily: z.enum(FONT_ENUM),
    scale: z.enum(['compact', 'default', 'spacious']),
    displayWeight: z.enum(['regular', 'medium', 'bold', 'black']),
    letterSpacing: z.enum(['tight', 'normal', 'wide']),
  }).strict(),
  shape: z.object({
    radius: z.enum(['sharp', 'soft', 'round', 'pill']),
    borderWeight: z.enum(['hairline', 'normal', 'bold']),
    elevation: z.enum(['flat', 'raised', 'floating']),
  }).strict(),
  density: densitySchema,
  motion: motionSchema,
  surfaceTexture: z.enum(['flat', 'glass']),
}).strict();

export type ThemeSpecV1 = z.infer<typeof themeSpecV1Schema>;

export const themeSpecV2Schema = z.object({
  specVersion: z.literal(2),

  name: z.string().min(1).max(40)
    .describe('Short display name for this look, e.g. "Bloom" or "Deep Space".'),

  summary: z.string().min(1).max(140)
    .describe('One sentence on why this look feels the way it does. Shown to the user in the theme gallery.'),

  mode: z.enum(['adaptive', 'light', 'dark'])
    .describe('Prefer "adaptive": it generates matching light and dark ramps and leaves the user\'s dark-mode toggle working. Use "light" or "dark" ONLY when the look is inherently one or the other (a CRT terminal makes no sense on white), because it disables the user\'s toggle.'),

  palette: paletteSchema,

  surface: z.object({
    lightAnchor: z.enum(SURFACE_ANCHOR_NAMES).default('paper')
      .describe('Where the page sits in the light ramp. "true-white" is clinical, "paper" is the usual off-white, "mid" is a mid-grey editorial ground that used to be impossible. Dark values are accepted here and will simply produce a dark "light" ramp — legibility still holds, but the user\'s toggle will stop meaning much.'),
    darkAnchor: z.enum(SURFACE_ANCHOR_NAMES).default('near-black')
      .describe('Where the page sits in the dark ramp. "true-black" is real OLED black, "near-black" is the safe default, "deep" and "dim" read softer and less harsh under bright ambient light.'),
    step: z.number().int().min(2).max(14).default(6)
      .describe('Lightness points between the page and the first tier above it, 2-14. Small values give a flat, layered look where separation comes from borders and shadows; large values give strongly stacked planes. This sets the near-page spacing only — the ladder always reaches full contrast at tier 12.'),
    contrastTarget: z.enum(CONTRAST_TARGET_NAMES).default('aa')
      .describe('The contrast floor every text pair is solved to. "aa" is the legal minimum and the right default, "aaa" is the enhanced level, "max" pushes everything apart and suits terminal and high-glare looks. A target the anchor cannot reach moves the anchor rather than failing the theme, and the move is reported back to you.'),
  }).strict().default({})
    .describe('Where the surfaces sit and how hard they separate. This replaced the fixed lightness table: it is the field that decides whether a dark theme is OLED-black or soft charcoal.'),

  type: z.object({
    sansFamily: z.enum(FONT_ENUM).describe('Body and UI text.'),
    displayFamily: z.enum(FONT_ENUM).describe('Headings and the wordmark.'),
    monoFamily: z.enum(FONT_ENUM).describe('Code, terminal output and tool arguments. "mono" unless there is a reason.'),
    scale: z.enum(['compact', 'default', 'spacious']).describe('Overall text size.'),
    displayWeight: z.enum(['regular', 'medium', 'bold', 'black']).describe('Weight for headings.'),
    letterSpacing: z.enum(['tight', 'normal', 'wide']).describe('Tracking. "wide" suits display and technical looks; "tight" suits dense editorial ones.'),
    lineHeight: z.enum(['tight', 'default', 'loose']).default('default')
      .describe('Body leading. "loose" is what makes a serif editorial look breathe; "tight" suits monospace and dense technical looks.'),
    measure: z.enum(['narrow', 'default', 'wide', 'full']).default('default')
      .describe('Maximum line length for prose. "narrow" is roughly 58 characters and is the single strongest signal of an editorial look; "full" removes the cap for dense technical layouts.'),
  }).strict(),

  density: densitySchema,
  motion: motionSchema,

  surfaces: surfacesMapSchema.default({})
    .describe('Per-surface recipes. Every key is optional and inherits, field by field, from `default`, which itself inherits from a plain bordered panel. This map is where a look is actually invented: two themes with the same palette and different surfaces are two different products, while two themes with different palettes and no surfaces are the same product in two colours.'),
}).strict();

export type ThemeSpecV2 = z.infer<typeof themeSpecV2Schema>;

/**
 * The parser for anything claiming to be a theme.
 *
 * Discriminated on `specVersion` so a malformed v2 reports v2 field paths
 * instead of a wall of union alternatives — the difference between a model
 * fixing its own output in one turn and giving up.
 */
export const themeSpecSchema = z.discriminatedUnion('specVersion', [
  themeSpecV1Schema,
  themeSpecV2Schema,
]);

export type ThemeSpec = z.infer<typeof themeSpecSchema>;

/** v1 corner buckets, in the pixel radii v2 authors directly. */
const V1_RADIUS = { sharp: 2, soft: 8, round: 16, pill: 28 } as const;
/** v1 border buckets, in the pixel widths v2 authors directly. */
const V1_BORDER_WIDTH = { hairline: 1, normal: 1.5, bold: 2.5 } as const;

/**
 * Rewrites a v1 spec as the v2 spec that means the same thing.
 *
 * One derivation path rather than two. A second code path for v1 would have to
 * be kept in contrast-correct lockstep with the first forever, and the moment
 * it drifts the older half of the user's gallery starts failing the guarantee
 * silently.
 *
 * It also fixes v1's central defect on the way past: `elevation` and
 * `surfaceTexture` emitted no tokens at all, so a v1 "glass floating" theme was
 * indistinguishable from a flat one. Here they become real shadows and a real
 * backdrop filter.
 */
export function upgradeSpec(spec: ThemeSpec): ThemeSpecV2 {
  if (spec.specVersion === 2) return spec;

  const radius = V1_RADIUS[spec.shape.radius];
  const width = V1_BORDER_WIDTH[spec.shape.borderWeight];

  const shadows = spec.shape.elevation === 'flat'
    ? []
    : spec.shape.elevation === 'raised'
      ? [{ y: 1, blur: 3, color: { role: 'shadow' as const }, alpha: 0.14 }]
      : [
        { y: 2, blur: 6, color: { role: 'shadow' as const }, alpha: 0.16 },
        { y: 10, blur: 28, spread: -6, color: { role: 'shadow' as const }, alpha: 0.22 },
      ];

  const glass = spec.surfaceTexture === 'glass';

  return themeSpecV2Schema.parse({
    specVersion: 2,
    name: spec.name,
    summary: spec.summary,
    mode: spec.mode,
    palette: spec.palette,
    surface: { lightAnchor: 'paper', darkAnchor: 'near-black', step: 6, contrastTarget: 'aa' },
    type: { ...spec.type, lineHeight: 'default', measure: 'default' },
    density: spec.density,
    motion: spec.motion,
    surfaces: {
      default: {
        border: { width, color: { role: 'border' } },
        corner: { radius },
        shadows,
        fill: glass
          ? [{ kind: 'solid', stops: [{ color: { role: 'light', tier: 1, alpha: 0.72 } }] }]
          : [{ kind: 'solid', stops: [{ color: { role: 'light', tier: 1 } }] }],
        backdrop: glass ? { blur: 14, saturate: 1.5 } : null,
      },
      popover: glass ? { backdrop: { blur: 20, saturate: 1.7 } } : undefined,
    },
  });
}
