import { z } from 'zod';

import {
  CONTRAST_TARGET_NAMES,
  SURFACE_ANCHOR_NAMES,
} from '@/modules/appearance/palette.js';
import {
  BLEND_MODES,
  colorRefSchema,
  surfacesMapSchema,
} from '@/modules/appearance/surface-recipe.js';

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

/**
 * The named font stacks a theme may choose between.
 *
 * A closed set rather than a free-form family name, for the same reason
 * textures are app-owned: an arbitrary name either hits the network via
 * `@font-face` or falls back to something nobody chose.
 *
 * **Nothing here is bundled.** No font file ships with the app and there is no
 * `@font-face` anywhere in it, so every one of these is a *preference list* and
 * what the user actually sees is the first entry installed on their machine.
 * That is fine, and it is also the thing that made generated themes look worse
 * than the default: the original stacks led with faces that exist on almost no
 * Windows install (Inter, Poppins, Optima, Gill Sans, Futura) and then fell
 * through to whatever was left. One of them — `slab` — named `'Courier Bold'`,
 * which is not a family at all in any font system, so it was dead weight in the
 * list.
 *
 * So each stack now has to reach a real, fully hinted face on a stock Windows
 * 11 and a stock macOS before it reaches the generic. The aspirational names
 * stay at the front for machines that do have them; what changed is that the
 * *last reachable* entry is a deliberate choice rather than an accident. Where
 * two stacks could fall through to the same face they are given different
 * Windows-shipped ones, because two "different" type choices resolving to the
 * same font is a knob that does nothing.
 */
export const FONT_FAMILIES = {
  'system-sans': "system-ui, -apple-system, 'Segoe UI Variable Text', 'Segoe UI', Roboto, sans-serif",
  grotesk: "'Inter', 'Inter Variable', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  geometric: "'Poppins', 'Century Gothic', 'Avenir Next', Futura, 'Trebuchet MS', sans-serif",
  humanist: "'Optima', 'Gill Sans', 'Gill Sans MT', Corbel, 'Segoe UI', sans-serif",
  serif: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  slab: "'Rockwell', 'Roboto Slab', 'Bookman Old Style', Cambria, Georgia, serif",
  display: "'Futura', 'Franklin Gothic Medium', 'Trebuchet MS', 'Segoe UI', sans-serif",
  mono: "ui-monospace, 'Cascadia Mono', 'Cascadia Code', 'SF Mono', Consolas, 'Source Code Pro', Menlo, monospace",
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
    .describe('Hue for buttons, links, focus rings and the primary action colour, 0-360. HSL hue is not the scale people name colours on, and the gap is widest exactly where it gets asked for most: 240 is the canonical CSS "blue" and resolves to indigo once the accent is darkened enough to carry text — ask for blue, get purple. Read these as where each name actually lands: red 0-10, orange 20-35, amber 35-50, yellow 50-60, green 100-150, teal 165-185, cyan 185-195, BLUE 200-220, indigo 225-250, violet 260-280, magenta 300-320, pink 330-345. Check the hex the preview hands back before committing; that is what it is for.'),
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

export const POINTER_KINDS = ['system', 'halo', 'ring', 'dot'] as const;

export type PointerKind = (typeof POINTER_KINDS)[number];

export const TRAIL_KINDS = ['none', 'comet', 'ribbon', 'pixel', 'rainbow', 'fluid'] as const;

export type TrailKind = (typeof TRAIL_KINDS)[number];

/**
 * An app-drawn cursor, and the trail behind it.
 *
 * `cursor: url(...)` is refused by the validator and always will be — a
 * stylesheet that can name a remote image can report where the user is
 * pointing, at the resolution of every hover. So a custom cursor here is not an
 * imported picture. It is either one of the shapes the operating system already
 * draws (the `cursor` field above) or a themed element that follows
 * `--pointer-px` / `--pointer-py`, which is what this group describes.
 *
 * The thing to understand before using `replace`: an app-drawn cursor is
 * painted by the page and therefore lands one frame after the pointer event,
 * while the real cursor is composited by the OS and never lags. On a large soft
 * `halo` a frame of offset is invisible. On a small hard `dot` standing in for
 * the actual pointer it is immediately obvious and feels broken. So the default
 * is a *companion* — the drawn shape rides along with the real cursor still
 * visible — and `replace` is the deliberate opt-in for authors who want the
 * native one gone and have chosen a shape that survives the lag.
 *
 * Even with `replace`, the native cursor comes back over text fields,
 * contenteditable regions and anything marked `[data-tails-critical]`. Those
 * are the places where the pointer's exact position or its shape is carrying
 * information the user needs, and taking it away there is not a style choice.
 */
const trailRecipeSchema = z.object({
  kind: z.enum(TRAIL_KINDS).default('none')
    .describe('The trail behind the pointer. Three are drawn as elements: "comet" tapers to nothing, "ribbon" keeps its width and only fades, "pixel" is hard-edged squares snapped to a grid — reach for that one when the look is flat or 8-bit, because round segments fight a block caret and square corners. Two are drawn on a canvas: "rainbow" is a stacked multi-colour ribbon lagging behind the pointer, "fluid" is soft additive blobs carrying pointer velocity and dissipating. The canvas pair run a frame loop while the pointer moves, so pick them when the trail *is* the look rather than as decoration. All of them retract to nothing when the mouse stops, because a trail that pools into a blob under a stationary cursor is the failure mode of every implementation of this.'),
  length: z.number().int().min(2).max(16).default(8)
    .describe('How many segments, 2-16, which is also how far back the trail reaches. The segments are spaced by distance travelled rather than by time, so a fast flick draws a long trail and a slow drag draws a short one — which is what a trail is supposed to mean.'),
  size: z.number().min(2).max(80).default(12)
    .describe('Diameter of the widest segment in pixels. Usually smaller than the cursor.'),
  opacity: z.number().min(0).max(1).default(0.35)
    .describe('Opacity of the nearest segment, 0-1; the rest fall off from there. The single best knob to publish as a control.'),
  color: colorRefSchema.optional()
    .describe('Trail colour. Omit to follow the cursor colour. Used by the element-drawn kinds; the canvas kinds prefer `palette`.'),
  palette: z.array(colorRefSchema).min(2).max(6).optional()
    .describe('Two to six colours for the canvas kinds. "rainbow" strokes one band per entry — this is what makes it a rainbow rather than one ribbon — and "fluid" cycles its blobs through them. Role references, so the trail re-tints with the theme instead of freezing a palette.'),
}).strict().default({ kind: 'none', length: 8, size: 12, opacity: 0.35 })
  .describe('Motion, so it is switched off entirely for anyone who asked for reduced motion, and it never runs an animation frame loop while the pointer is still.');

const pointerRecipeSchema = z.object({
  kind: z.enum(POINTER_KINDS).default('system')
    .describe('The drawn shape that follows the mouse. "system" draws nothing and leaves the native cursor alone. "halo" is a soft glow — the safest and the one that reads as atmosphere rather than as a replacement pointer. "ring" is a hollow circle. "dot" is a filled disc.'),
  size: z.number().min(4).max(160).default(28)
    .describe('Diameter in pixels, 4-160. A halo wants 40-120 and works because it is soft and large; a dot or ring standing in for the pointer wants 10-20. Rides a live-control multiplier, so this is the value the panel opens showing.'),
  color: colorRefSchema.optional()
    .describe('Colour of the drawn shape. Omit for the accent. Alpha here is fine but `opacity` is the better knob, because a control can bind it directly.'),
  opacity: z.number().min(0).max(1).default(0.45)
    .describe('How present the shape is, 0-1. Default 0.45. A halo above about 0.6 stops being atmosphere and starts obscuring what is under it.'),
  blend: z.enum(BLEND_MODES).default('screen')
    .describe('How the shape blends with the page. "screen" is right on dark grounds, "multiply" on light ones, "normal" if the shape should read as an object rather than as light.'),
  replace: z.boolean().default(false)
    .describe('Hide the native cursor and let the drawn shape stand in for it. Read the note on lag before setting this: it is correct for a large soft shape and a mistake for a small hard one. The native cursor returns over text fields and critical controls regardless.'),
  trail: trailRecipeSchema,
  click: z.object({
    kind: z.enum(['none', 'ripple', 'minesweeper', 'crack']).default('none')
      .describe('What happens where the user clicks. "ripple" expands a ring from the click point and fades it. "minesweeper" briefly lays a grid of beveled tiles around the point — light top-left edge, dark bottom-right — and presses them in, which is the classic Windows dialog bevel and suits a flat, squared-off look. "crack" presses pixels in along a fracture radiating from the click, with the bevel inverted so each one reads as a dent rather than a button. Off by default: feedback on every click in the app is a strong choice, and the wrong one for anything that wants to feel quiet.'),
    size: z.number().min(8).max(240).default(72)
      .describe('How far the effect reaches, in pixels. Around 60-100 reads as acknowledgement; past ~150 it reads as a splash and starts competing with whatever the click actually did. For "minesweeper" this is the width of the patch of tiles, so it decides how many appear.'),
    color: colorRefSchema.optional()
      .describe('Ripple colour. Omit to follow the cursor colour.'),
    seconds: z.number().min(0.15).max(2).default(0.45)
      .describe('How long one ripple takes. Default 0.45. Longer than about 0.8 and two quick clicks overlap into a mess.'),
  }).strict().default({ kind: 'none', size: 72, seconds: 0.45 })
    .describe('Click feedback. Motion, so it is off entirely under reduced motion, and it adds no listener when the kind is "none".'),
// Zod's `.default()` wants a complete output object, so a group whose own
// fields are all defaulted still has to be spelled out at the group level. The
// nested one is read back off its schema rather than written twice, because two
// copies of a default is one copy that eventually stops matching.
}).strict().default(() => ({
  kind: 'system' as const,
  size: 28,
  opacity: 0.45,
  blend: 'screen' as const,
  replace: false,
  trail: trailRecipeSchema.parse(undefined),
  click: { kind: 'none' as const, size: 72, seconds: 0.45 },
}))
  .describe('An app-drawn cursor and its trail. Off by default; "system" means the native pointer and nothing else.');

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
  }).strict().default({
    lightAnchor: 'paper', darkAnchor: 'near-black', step: 6, contrastTarget: 'aa',
  })
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

  interaction: z.object({
    caretColor: colorRefSchema.optional()
      .describe('The text insertion caret. Omit for the accent colour. This is the smallest change with the largest effect on whether a look feels *inhabited*: a phosphor-green caret is most of what sells a terminal.'),
    caretCycle: z.array(colorRefSchema).min(2).max(4).optional()
      .describe('Cycle the caret through two to four colours instead of holding one. Hard steps rather than a crossfade, because a caret that fades between colours reads as a rendering fault. Two to four is the whole range: a caret is a few pixels wide and nobody can distinguish six colours at that size.'),
    caretCycleSeconds: z.number().min(0.4).max(20).default(4)
      .describe('Seconds for one full cycle through `caretCycle`. Default 4. Under about 1.5 seconds it competes with the blink and reads as a fault.'),
    caretShape: z.enum(['auto', 'bar', 'block', 'underscore']).default('auto')
      .describe('Caret geometry. "block" is the fat terminal cursor and "underscore" is the DOS one. Blink rate is the operating system\'s and cannot be set from here — a look that needs a specific blink needs a different primitive, not this one. Needs Chromium 139+, which the desktop app is; elsewhere it degrades to a bar.'),
    selectionFill: colorRefSchema.optional()
      .describe('Background of selected text. Omit for the accent at low alpha. Keep it translucent — an opaque selection hides the glyphs it is meant to highlight.'),
    selectionInk: colorRefSchema.optional()
      .describe('Colour of selected text itself. Omit to leave the text its own colour, which is usually right when the fill is translucent.'),
    cursor: z.enum(['auto', 'default', 'crosshair', 'cell', 'copy', 'progress', 'help'])
      .default('auto')
      .describe('The native mouse pointer over the application body, chosen from the shapes the operating system already draws. "auto" is almost always correct. `cursor` inherits, so anything else here changes the pointer over every surface that has not set its own — a crosshair is a strong, committed choice and a slightly hostile one.'),
    pointer: pointerRecipeSchema,
  }).strict().default(() => ({
    caretShape: 'auto' as const,
    caretCycleSeconds: 4,
    cursor: 'auto' as const,
    pointer: pointerRecipeSchema.parse(undefined),
  }))
    .describe('Caret, text selection and pointer. Small surface, disproportionate effect: these are the details that separate a themed app from a recoloured one, and none of them were reachable before.'),

  window: z.object({
    backdrop: z.enum(['opaque', 'acrylic', 'mica']).default('opaque')
      .describe('Whether the application window itself is see-through. "opaque" is the normal case and the default. "acrylic" makes the desktop behind the app visible through a heavy blur; "mica" is the quieter, wallpaper-tinted variant. This is the only property in the whole spec that reaches outside the page — it is an operating-system window effect, not CSS — so it is the only one that can do nothing on a platform that does not support it. Windows 11 only; everywhere else it degrades to opaque, silently and by design, because a look that merely fails to be translucent is still a working look.'),
    tint: colorRefSchema.optional()
      .describe('Colour laid over the blurred desktop, and effectively mandatory when `backdrop` is not "opaque": without one the app is transparent onto arbitrary wallpaper and text contrast becomes whatever happens to be behind the window. Keep the alpha high enough that the desktop reads as texture rather than as content — around 0.6-0.85 for a dark tint.'),
  }).strict().default(() => ({ backdrop: 'opaque' as const }))
    .describe('The application window itself, as opposed to anything drawn inside it.'),

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
