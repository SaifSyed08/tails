import { z } from 'zod';

/**
 * The authored theme surface — everything a model may decide about how the app
 * looks.
 *
 * Every field is an enum or a bounded integer. There are no hex codes, no
 * pixel values, no durations, no font names outside a bundled set, and no CSS
 * of any kind. The model names a vibe in bounded terms; the app decides what
 * colours that produces.
 *
 * Most importantly: **lightness is absent**. It is derived per role from fixed
 * per-mode bands. Because the only way to make text unreadable is to pick two
 * lightnesses close together, and the model cannot pick lightness at all, an
 * unreadable theme is impossible by construction rather than caught by
 * checking. Hue and chroma alone cannot destroy legibility.
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

export const themeSpecSchema = z.object({
  specVersion: z.literal(1),

  name: z.string().min(1).max(40)
    .describe('Short display name for this look, e.g. "Bloom" or "Deep Space".'),

  summary: z.string().min(1).max(140)
    .describe('One sentence on why this look feels the way it does. Shown to the user in the theme gallery.'),

  mode: z.enum(['adaptive', 'light', 'dark'])
    .describe('Prefer "adaptive": it generates matching light and dark ramps and leaves the user\'s dark-mode toggle working. Use "light" or "dark" ONLY when the look is inherently one or the other (a neon look that makes no sense on white), because it disables the user\'s toggle.'),

  palette: z.object({
    surfaceHue: z.number().int().min(0).max(360)
      .describe('Base hue for backgrounds, cards and borders, 0-360. Surfaces usually look best either fully neutral or within ~40 degrees of the accent hue.'),
    surfaceChroma: z.enum(['neutral', 'tinted', 'rich'])
      .describe('How much colour the backgrounds carry. "neutral" is near-grey, "tinted" is a subtle wash, "rich" is unmistakably coloured.'),
    accentHue: z.number().int().min(0).max(360)
      .describe('Hue for buttons, links, focus rings and the primary action colour, 0-360.'),
    accentChroma: z.enum(['muted', 'vivid', 'electric'])
      .describe('Accent intensity. "muted" is restrained and editorial, "vivid" is confident, "electric" is high-energy and works best against dark or neutral surfaces.'),
    scheme: z.enum(['mono', 'analogous', 'complement', 'triad'])
      .describe('How the secondary hue relates to the accent. "mono" reuses it, "analogous" shifts 30 degrees, "complement" opposes it, "triad" shifts 120.'),
    statusHueShift: z.number().int().min(-15).max(15).default(0)
      .describe('Nudges the success/warning/danger hues by up to 15 degrees so they sit with the palette. Kept small on purpose: a danger colour that stops reading as danger is an accessibility failure, not personalisation.'),
  }).strict(),

  type: z.object({
    sansFamily: z.enum(FONT_ENUM).describe('Body and UI text.'),
    displayFamily: z.enum(FONT_ENUM).describe('Headings and the wordmark.'),
    monoFamily: z.enum(FONT_ENUM).describe('Code, terminal output and tool arguments. "mono" unless there is a reason.'),
    scale: z.enum(['compact', 'default', 'spacious']).describe('Overall text size.'),
    displayWeight: z.enum(['regular', 'medium', 'bold', 'black']).describe('Weight for headings.'),
    letterSpacing: z.enum(['tight', 'normal', 'wide']).describe('Tracking. "wide" suits display and technical looks; "tight" suits dense editorial ones.'),
  }).strict(),

  shape: z.object({
    radius: z.enum(['sharp', 'soft', 'round', 'pill'])
      .describe('Corner rounding. "sharp" reads technical and precise, "round"/"pill" read friendly and soft.'),
    borderWeight: z.enum(['hairline', 'normal', 'bold']).describe('Border thickness.'),
    elevation: z.enum(['flat', 'raised', 'floating']).describe('How much shadow separates surfaces from the background.'),
  }).strict(),

  density: z.enum(['tight', 'default', 'airy'])
    .describe('Spacing between things. "tight" fits more on screen, "airy" feels calmer.'),

  motion: z.enum(['instant', 'calm', 'standard', 'playful'])
    .describe('How the interface moves. "instant" is nearly immediate, "playful" overshoots slightly. This is honoured everywhere, including reduced-motion users, who get no animation regardless.'),

  surfaceTexture: z.enum(['flat', 'glass'])
    .describe('"glass" adds translucency and blur to floating surfaces; "flat" is opaque.'),
}).strict();

export type ThemeSpec = z.infer<typeof themeSpecSchema>;

/**
 * The shipped reference looks.
 *
 * Source constants rather than seeded database rows: presets then improve with
 * a release instead of a migration, a user cannot delete or corrupt them, and
 * CI can assert that all of them validate and pass contrast in both ramps —
 * which makes them regression tests for the derivation, not just examples.
 *
 * They deliberately span the space. Three variations on the default would
 * teach the model that themes are small perturbations, which is the wrong
 * lesson.
 */
export const THEME_PRESETS: Record<string, ThemeSpec> = {
  paper: {
    specVersion: 1,
    name: 'Paper',
    summary: 'Warm, quiet and editorial — a serif display over off-white paper.',
    mode: 'adaptive',
    palette: {
      surfaceHue: 44, surfaceChroma: 'tinted',
      accentHue: 24, accentChroma: 'muted',
      scheme: 'analogous', statusHueShift: 0,
    },
    type: {
      sansFamily: 'humanist', displayFamily: 'serif', monoFamily: 'mono',
      scale: 'default', displayWeight: 'bold', letterSpacing: 'normal',
    },
    shape: { radius: 'soft', borderWeight: 'hairline', elevation: 'flat' },
    density: 'default',
    motion: 'calm',
    surfaceTexture: 'flat',
  },

  neon: {
    specVersion: 1,
    name: 'Neon',
    summary: 'Near-black surfaces with one electric cyan accent and sharp, technical edges.',
    mode: 'adaptive',
    palette: {
      surfaceHue: 230, surfaceChroma: 'neutral',
      accentHue: 175, accentChroma: 'electric',
      scheme: 'complement', statusHueShift: 0,
    },
    type: {
      sansFamily: 'geometric', displayFamily: 'display', monoFamily: 'mono',
      scale: 'compact', displayWeight: 'black', letterSpacing: 'wide',
    },
    shape: { radius: 'sharp', borderWeight: 'normal', elevation: 'floating' },
    density: 'tight',
    motion: 'instant',
    surfaceTexture: 'glass',
  },

  bloom: {
    specVersion: 1,
    name: 'Bloom',
    summary: 'Soft pink surfaces, round corners and playful motion.',
    mode: 'adaptive',
    palette: {
      surfaceHue: 330, surfaceChroma: 'rich',
      accentHue: 336, accentChroma: 'vivid',
      scheme: 'analogous', statusHueShift: 4,
    },
    type: {
      sansFamily: 'humanist', displayFamily: 'geometric', monoFamily: 'mono',
      scale: 'default', displayWeight: 'bold', letterSpacing: 'normal',
    },
    shape: { radius: 'round', borderWeight: 'hairline', elevation: 'raised' },
    density: 'airy',
    motion: 'playful',
    surfaceTexture: 'flat',
  },
};

export type PresetId = keyof typeof THEME_PRESETS;
