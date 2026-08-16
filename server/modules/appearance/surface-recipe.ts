import { z } from 'zod';

/**
 * The per-surface visual vocabulary — the part of the theme system that lets a
 * model invent a look rather than pick the nearest preset.
 *
 * A v1 spec was entirely global: one radius, one border weight, one elevation
 * bucket for the whole app. That is why every generated theme came out as a
 * hue rotation of the default. Structure, not colour, is what separates
 * brutalism from neumorphism from glass, and structure is exactly what a global
 * spec cannot express.
 *
 * The primitives here are deliberately low-level and compositional. Nothing in
 * this file names a style; `brutalist` is not an enum value, it is what you get
 * from zero radius, a 3px border and a hard zero-blur offset shadow. A named
 * bucket can only ever produce the looks someone thought of in advance.
 */

/**
 * Roles a colour reference may point at.
 *
 * References are roles, never literals, because a shadow authored as literal
 * black is theme-blind: it looks correct on a dark theme and like soot on a
 * paper one. `shadow` and `light` are the two poles the ramp derives for depth
 * effects, so a neumorphic mirrored pair stays coherent in both ramps.
 */
export const COLOR_ROLES = [
  'surface',
  'accent',
  'support',
  'foreground',
  'border',
  'shadow',
  'light',
  'ink',
  // The semantic three. They were derived and emitted as `--positive` and
  // friends from the beginning, and a recipe could not name them — so a theme
  // that wanted its "saved" toast to actually be its own green, or a caret to
  // cycle through the palette's full set, had to reach for the accent and
  // approximate. Adding them costs nothing: they are already solved against the
  // page, and referencing a colour the theme already publishes cannot introduce
  // a contrast failure the theme did not already have.
  'positive',
  'warning',
  'destructive',
] as const;

export type ColorRole = (typeof COLOR_ROLES)[number];

export const colorRefSchema = z.object({
  role: z.enum(COLOR_ROLES)
    .describe('Which derived role this colour comes from. "surface" is the page/panel body, "ink" is maximum-contrast text, "foreground" is solved body text, "shadow"/"light" are the two depth poles the ramp derives (use these for shadows — never assume black), "accent" is the primary action colour, "support" is the secondary hue from the palette scheme, "border" is the solved separator colour, and "positive"/"warning"/"destructive" are the semantic colours this theme already publishes, solved against the page.'),
  tier: z.number().int().min(0).max(12).optional()
    .describe('Position on the 13-step lightness ladder, where 0 is the page background and 12 is maximum contrast against it. Tier is direction-free: tier 2 is "two steps away from the background" in a dark theme and in a light theme alike, so one recipe reads correctly in both ramps. Omit to use the role\'s solved tier.'),
  alpha: z.number().min(0).max(1).optional()
    .describe('Opacity 0-1. Omit for fully opaque. Translucent fills are how glass is built; the ink solver composites the result over the page background before checking contrast, so translucency cannot make text unreadable.'),
  chroma: z.number().min(0).max(1).optional()
    .describe('Multiplies the saturation of this reference, 0-1. Omit to leave it alone. Every role derives from the one surface hue in the palette, so without this a tinted theme has no way to reach a neutral: 0 gives the grey at the same lightness, which is how a stone texture sits beside an earth one in a theme whose surface hue is brown. It can only remove colour, never add it — a role reference stays a reference to the theme.'),
}).strict();

export type ColorRef = z.infer<typeof colorRefSchema>;

/** Blend modes worth exposing. Excludes the ones that mostly produce mud. */
export const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light',
  'color-dodge', 'color-burn', 'difference', 'exclusion', 'luminosity',
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

/** Where a radial or conic gradient is centred. */
export const FILL_ORIGINS = [
  'center', 'top', 'bottom', 'left', 'right',
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
] as const;

export type FillOrigin = (typeof FILL_ORIGINS)[number];

export const FILL_KINDS = ['solid', 'linear', 'radial', 'conic', 'repeating-linear'] as const;

export type FillKind = (typeof FILL_KINDS)[number];

const gradientStopSchema = z.object({
  color: colorRefSchema.describe('The colour at this stop.'),
  position: z.number().min(0).max(100).optional()
    .describe('Stop position as a percentage along the gradient. Omit to let the browser distribute stops evenly.'),
}).strict();

export const fillLayerSchema = z.object({
  kind: z.enum(FILL_KINDS)
    .describe('"solid" is a flat colour and must carry exactly one stop. "linear" is the workhorse. "radial" makes a glow or a spotlight. "conic" makes an iridescent sweep. "repeating-linear" makes stripes — pair it with `band` for the stripe width.'),
  angle: z.number().int().min(0).max(360).optional()
    .describe('Gradient angle in degrees for linear/repeating-linear/conic, CSS convention: 180 points down the surface. Default 180.'),
  origin: z.enum(FILL_ORIGINS).optional()
    .describe('Centre point for radial and conic fills. Default "center".'),
  shape: z.enum(['circle', 'ellipse']).optional()
    .describe('Radial gradient shape. Default "ellipse".'),
  band: z.number().min(1).max(64).optional()
    .describe('Stripe period in pixels for "repeating-linear". Default 8. A 2px band reads as a scanline, a 24px band as an awning.'),
  stops: z.array(gradientStopSchema).min(1).max(6)
    .describe('Colour stops, painted in order. Solid fills take exactly one.'),
  blend: z.enum(BLEND_MODES).optional()
    .describe('How this layer blends with the layers under it. Default "normal". "overlay" and "soft-light" are the ones that read as light rather than paint.'),
}).strict().superRefine((layer, ctx) => {
  // Rejected rather than silently using the first stop: a solid fill with three
  // stops means the author wanted a gradient and picked the wrong kind, and
  // quietly dropping two colours hides that from them.
  if (layer.kind === 'solid' && layer.stops.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['stops'],
      message: 'A "solid" fill takes exactly one stop. Use "linear" or "radial" for more.',
    });
  }
  if (layer.kind !== 'solid' && layer.stops.length < 2) {
    ctx.addIssue({
      code: 'custom',
      path: ['stops'],
      message: `A "${layer.kind}" fill needs at least two stops.`,
    });
  }
});

export const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const;

export type BorderSide = (typeof BORDER_SIDES)[number];

export const borderRecipeSchema = z.object({
  width: z.number().min(0).max(12).optional()
    .describe('Border width in pixels, 0-12. Default 1. Above ~2.5 the look reads as brutalist or toy-like, which may be exactly what you want.'),
  style: z.enum(['none', 'solid', 'dashed', 'dotted', 'double']).optional()
    .describe('Border style. Default "solid".'),
  sides: z.array(z.enum(BORDER_SIDES)).min(1).max(4).optional()
    .describe('Which sides are drawn. Default all four. A single "bottom" is how editorial hairline rules and underlined inputs are built.'),
  color: colorRefSchema.optional()
    .describe('Border colour. Default the solved "border" role, which is guaranteed to clear 3:1 against the page.'),
  variant: z.enum(['flat', 'gradient-ring']).optional()
    .describe('"flat" is a plain border. "gradient-ring" paints the border with a gradient — the specular rim that makes glass read as a physical edge. Requires `ring`.'),
  ring: z.object({
    angle: z.number().int().min(0).max(360).optional()
      .describe('Ring gradient angle in degrees. Default 145, which puts the bright edge top-left as if lit from above.'),
    stops: z.array(gradientStopSchema).min(2).max(6)
      .describe('Ring gradient stops. A convincing glass rim is light at ~0-20% and shadow at ~60-100%.'),
  }).strict().optional()
    .describe('The gradient painted into the border. Only used when variant is "gradient-ring".'),
}).strict().superRefine((border, ctx) => {
  if (border.variant === 'gradient-ring' && !border.ring) {
    ctx.addIssue({
      code: 'custom',
      path: ['ring'],
      message: 'variant "gradient-ring" needs a `ring` gradient. Without one there is nothing to paint into the border.',
    });
  }
});

export const CORNER_SHAPES = ['round', 'squircle', 'bevel', 'scoop', 'notch', 'square'] as const;

export type CornerShape = (typeof CORNER_SHAPES)[number];

export const cornerRecipeSchema = z.object({
  radius: z.number().min(0).max(48).optional()
    .describe('Corner radius in pixels, 0-48. Default 10. 0 reads technical, 24+ reads friendly, and radius is what `shape` sculpts — a shape with radius 0 is invisible.'),
  shape: z.enum(CORNER_SHAPES).optional()
    .describe('How the corner is cut. Default "round". "squircle" is the continuous iOS-style curve, "bevel" cuts a flat 45-degree chamfer, "scoop" cuts a concave bite, "notch" cuts a right-angle step, "square" ignores the radius entirely. Everything except "round"/"square" needs Chromium 140+, which the desktop app is; a browser without it degrades to a plain rounded corner.'),
}).strict();

export const shadowLayerSchema = z.object({
  inset: z.boolean().optional()
    .describe('Draw the shadow inside the surface instead of outside. Default false. Inset light-coloured shadows are how a specular rim and a pressed/sunken state are built.'),
  x: z.number().min(-64).max(64).optional()
    .describe('Horizontal offset in pixels. Default 0.'),
  y: z.number().min(-64).max(64).optional()
    .describe('Vertical offset in pixels. Default 0. Positive is down.'),
  blur: z.number().min(0).max(128).optional()
    .describe('Blur radius in pixels. Default 0. Zero blur with a large offset is the hard brutalist drop shadow; large blur with a small offset is ambient depth.'),
  spread: z.number().min(-32).max(32).optional()
    .describe('Spread in pixels. Default 0. A small positive spread with zero offset and zero blur draws a second ring outside the border.'),
  color: colorRefSchema
    .describe('Shadow colour, as a role. Use "shadow" for depth and "light" for the mirrored highlight of a neumorphic pair or a glass specular rim; use "accent" for neon glow. Never assume black — "shadow" already is the theme-correct dark pole.'),
  alpha: z.number().min(0).max(1).optional()
    .describe('Overrides the alpha on `color` for this layer. Convenient when several layers share one colour role at different strengths.'),
}).strict();

export const backdropRecipeSchema = z.object({
  blur: z.number().min(0).max(64).optional()
    .describe('Backdrop blur radius in pixels. Default 16. This is real translucency: it only shows if the fill is partly transparent, so pair it with a fill whose stops carry alpha around 0.5-0.7.'),
  saturate: z.number().min(0.5).max(3).optional()
    .describe('Backdrop saturation multiplier. Default 1.6. Boosting saturation behind the blur is what stops glass looking like fog — it is the single most important number for a convincing glass surface.'),
  brightness: z.number().min(0.5).max(2).optional()
    .describe('Backdrop brightness multiplier. Default 1.'),
  refraction: z.number().min(0).max(1).optional()
    .describe('How much the edge bends what is behind it, 0-1. Default 0. Emitted as a scalar the renderer maps to an inner edge highlight, plus a small contrast boost in the filter chain, because true backdrop refraction does not exist in Chromium 140.'),
}).strict();

export const TEXTURE_KINDS = [
  'none', 'grain', 'paper', 'scanline', 'halftone', 'grid', 'dither', 'pixels',
] as const;

export type TextureKind = (typeof TEXTURE_KINDS)[number];

/** A grid cell names a palette entry by index, or `.` for a hole. */
const PIXEL_ROW = /^[0-7.]{2,16}$/;

/**
 * A texture the model draws itself, as data rather than as markup.
 *
 * This is the answer to "make it look like Minecraft", and to the whole class
 * of request behind it. A blocky earth surface needs a *pixel tile* — a small
 * grid of flat colours with hard edges — and the fixed texture set could only
 * approximate one with gradients. The model was asked for something it had no
 * primitive for and approximated, which is the failure the design doc says to
 * answer by naming the missing primitive.
 *
 * **Why a grid and not authored SVG.** The obvious version of this channel lets
 * the model write SVG markup which we then parse, allowlist and re-serialise —
 * exactly what `freeform-css.ts` does for CSS. It is the wrong trade here, for
 * a reason that is about honesty rather than effort: there is no XML parser in
 * this project, and the rule that file is built on is *parse, never
 * pattern-match*, because a validator that can be fooled is worse than none.
 * Hand-rolling a tokeniser to guard a security boundary would be precisely the
 * mistake it warns against, and the boundary here is a real one — `<script>`,
 * `<foreignObject>`, `<image>`, `<use href>` and `url()` inside a style
 * attribute are all live exfiltration or execution vectors.
 *
 * So the model supplies numbers and colour roles, and *this* code writes the
 * SVG. Nothing authored is ever parsed because nothing authored is ever markup,
 * which is a stronger guarantee than any allowlist and costs a validator
 * nobody has to trust.
 *
 * What it does not cover, stated plainly: organic shapes, curves, glyphs, and
 * anything that wants to be a picture. A grid draws blocks, bricks, weaves,
 * checks, dithers and pixel art. It does not draw a paisley.
 */
export const pixelTextureSchema = z.object({
  palette: z.array(colorRefSchema).min(1).max(8)
    .describe('Up to eight colours, referenced by index from `grid`. Role references rather than literals, so a tile re-tints with the theme instead of freezing today\'s palette — a dirt texture built from "shadow" and "surface" stays dirt in both ramps.'),
  grid: z.array(z.string().regex(PIXEL_ROW, 'A row is 2-16 characters of 0-7 (a palette index) or "." for a hole.')).min(2).max(16)
    .describe('The tile, one string per row, each character a palette index or "." for transparent. All rows must be the same length. Keep it small and let `scale` do the work: an 8x8 tile of three browns reads as earth, and a 16x16 one mostly reads as noise. Irregularity is what stops a tile looking like a grid — vary the cells rather than laying down a pattern.'),
}).strict();

export const textureRecipeSchema = z.object({
  kind: z.enum(TEXTURE_KINDS).optional()
    .describe('Which texture to overlay. Default "none". Seven are app-owned and selected by name; "pixels" is the one you draw yourself, as a grid of palette indices in the `pixels` field. A theme can never supply an image or a URL, which is what makes the whole system incapable of phoning home.'),
  pixels: pixelTextureSchema.optional()
    .describe('The tile, when `kind` is "pixels". Ignored otherwise.'),
  opacity: z.number().min(0).max(1).optional()
    .describe('Texture opacity. Default 0.05. Grain wants 0.03-0.08; above ~0.15 it stops reading as material and starts reading as dirt.'),
  scale: z.number().min(0.25).max(4).optional()
    .describe('Texture scale multiplier. Default 1. Larger is coarser.'),
  blend: z.enum(BLEND_MODES).optional()
    .describe('How the texture blends into the surface. Default "overlay". A pixel tile that is meant to *be* the surface rather than sit on it wants "normal" and an opacity near 1.'),
}).strict().superRefine((texture, ctx) => {
  if (texture.kind === 'pixels' && !texture.pixels) {
    ctx.addIssue({
      code: 'custom',
      path: ['pixels'],
      message: 'kind "pixels" needs a `pixels` grid. Without one there is nothing to draw.',
    });
  }
  if (!texture.pixels) return;

  // Checked here rather than at render time: a ragged grid or an index with no
  // colour behind it is an authoring mistake, and the whole module's rule is
  // that a mistake comes back as a dotted path rather than as a quietly
  // half-drawn tile.
  const width = texture.pixels.grid[0]?.length ?? 0;
  texture.pixels.grid.forEach((row, index) => {
    if (row.length !== width) {
      ctx.addIssue({
        code: 'custom',
        path: ['pixels', 'grid', index],
        message: `Row ${index} is ${row.length} characters; row 0 is ${width}. A tile has to be rectangular.`,
      });
    }
    for (const cell of row) {
      if (cell !== '.' && Number(cell) >= texture.pixels!.palette.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['pixels', 'grid', index],
          message: `Row ${index} names palette index ${cell}, but the palette has ${texture.pixels!.palette.length} entries (0-${texture.pixels!.palette.length - 1}).`,
        });
        break;
      }
    }
  });
});

export const OVERLAY_KINDS = ['none', 'sheen', 'topLight', 'vignette'] as const;

export type OverlayKind = (typeof OVERLAY_KINDS)[number];

export const overlayRecipeSchema = z.object({
  kind: z.enum(OVERLAY_KINDS).optional()
    .describe('A single app-owned lighting gradient. Default "none". "sheen" is a diagonal wipe of light, "topLight" is a soft gradient from the top edge, "vignette" darkens the outer edge.'),
  angle: z.number().int().min(0).max(360).optional()
    .describe('Overlay angle in degrees, used by "sheen". Default 145.'),
  strength: z.number().min(0).max(1).optional()
    .describe('Overlay strength 0-1. Default 0.12. Lighting is convincing at low values and plastic above ~0.35.'),
}).strict();

export const AMBIENT_KINDS = ['none', 'drift', 'clouds', 'grid', 'pulse'] as const;

export type AmbientKind = (typeof AMBIENT_KINDS)[number];

/**
 * Slow background movement — the primitive that used to be missing entirely.
 *
 * "Rose gold with slowly drifting clouds behind the chat" had no word in this
 * vocabulary, so the only way to reach it was hand-written CSS, and a look that
 * needs the escape hatch to express its central idea is a gap in the spec
 * rather than a limit on the engine.
 *
 * It is deliberately *ambient* rather than general animation. There is no
 * keyframe authoring here and no way to move a control: the app owns four
 * motions, they all run on a decoration layer nobody can click, and the
 * renderer's global reduced-motion rule stops all of them dead while leaving
 * the image in place — which is the right degradation, because the gradient was
 * always the look and the movement was always the garnish.
 */
export const ambientRecipeSchema = z.object({
  kind: z.enum(AMBIENT_KINDS).optional()
    .describe('Which ambient motion sits behind this surface. Default "none". "drift" is a wide colour field sliding slowly across; "clouds" is two soft radial masses passing each other, which is the one that reads as weather; "grid" is a technical lattice scrolling diagonally; "pulse" is a single glow breathing in place. This inherits like texture does, so setting it on `default` puts it behind the whole app — including every card — and a part that should stay still needs `ambient: { kind: "none" }` of its own.'),
  hue: z.number().int().min(0).max(360).optional()
    .describe('Hue for the moving colour, 0-360. Omit to use the accent hue. Setting it 30-60 degrees off the accent is what stops an ambient field reading as a wash of the button colour.'),
  strength: z.number().min(0).max(1).optional()
    .describe('How present the movement is, 0-1. Default 0.12. Ambience is convincing below about 0.25 and becomes a screensaver above it — this is peripheral motion, and the moment the user watches it instead of the text it has failed.'),
  speed: z.number().min(2).max(240).optional()
    .describe('Seconds for one full cycle. Default 60. Under about 20 seconds the movement is noticeable rather than ambient; 60-120 is the range where someone senses the screen is alive without ever catching it moving.'),
  scale: z.number().min(0.5).max(4).optional()
    .describe('Size multiplier for the moving shapes. Default 1. Larger is softer and slower-reading because each mass covers more of the screen.'),
  blend: z.enum(BLEND_MODES).optional()
    .describe('How the ambient layer blends into the fill beneath it. Default "screen" on dark grounds and "multiply" on light ones is the usual instinct; "soft-light" is the safest choice for a look that has to work in both ramps.'),
}).strict();

export const inkRecipeSchema = z.object({
  tier: z.number().int().min(0).max(12).optional()
    .describe('Force the body-text tier on this surface. Omit — the default — to let the solver pick the lowest tier that clears the theme contrast target, which is what keeps every surface legible. A forced tier is still raised if it fails the target.'),
  mutedTier: z.number().int().min(0).max(12).optional()
    .describe('Force the secondary-text tier on this surface. Omit to solve. Also raised if it fails.'),
  glow: z.number().min(0).max(1).optional()
    .describe('Text glow strength 0-1. Default 0. This is the CRT phosphor bloom a terminal look needs; it emits a text-shadow in the ink colour and is invisible at 0.'),
}).strict();

/**
 * One surface's complete look, with every group optional.
 *
 * Optional rather than defaulted on purpose: a named surface must be able to
 * say "like the default, but with a 3px border" without silently resetting the
 * default's fill. Defaults are applied by merging against a baseline in
 * `derive.ts`, per field, so omission means inherit and never means reset.
 *
 * The two array groups — `fill` and `shadows` — replace wholesale rather than
 * merging element-wise, because merging ordered paint layers by index produces
 * results no author predicted.
 */
export const surfaceRecipeSchema = z.object({
  fill: z.array(fillLayerSchema).min(1).max(4).optional()
    .describe('Paint layers, first on top. Replaces the inherited fill entirely rather than merging. Default is a single solid fill of the surface role.'),
  border: borderRecipeSchema.optional(),
  corner: cornerRecipeSchema.optional(),
  shadows: z.array(shadowLayerSchema).max(6).optional()
    .describe('Up to six box-shadow layers, first on top. Replaces the inherited list entirely. This is the highest-leverage primitive in the whole system: a hard zero-blur offset is brutalism, a mirrored light/dark blurred pair is neumorphism, a large soft dark layer under a tight inset light layer is clay, an inset light hairline is a glass rim, and a wide zero-offset accent layer is neon. Pass an empty array for a surface with no shadow at all.'),
  backdrop: backdropRecipeSchema.nullable().optional()
    .describe('Backdrop filter for translucent surfaces, or null for none. Default null. Only meaningful when the fill carries alpha.'),
  texture: textureRecipeSchema.optional(),
  overlay: overlayRecipeSchema.optional(),
  ambient: ambientRecipeSchema.optional(),
  ink: inkRecipeSchema.optional(),
}).strict();

export type SurfaceRecipe = z.infer<typeof surfaceRecipeSchema>;

/**
 * The parts of the app a recipe can target.
 *
 * A closed list rather than free-form keys: every name here corresponds to a
 * `data-tails-part` attribute the renderer actually sets, so an unknown key is
 * a theme that silently does nothing — the exact failure mode this rebuild
 * exists to remove.
 */
export const SURFACE_PARTS = [
  'default',
  'card',
  'sidebar',
  'popover',
  'header',
  'input',
  'button',
  'code',
  'scrim',
  'bubbleUser',
  'bubbleAssistant',
] as const;

export type SurfacePart = (typeof SURFACE_PARTS)[number];

export const surfacesMapSchema = z.object({
  default: surfaceRecipeSchema.optional()
    .describe('The base recipe every other surface inherits from, and the look of the page itself. Start here; only add named surfaces where they must genuinely differ.'),
  card: surfaceRecipeSchema.optional().describe('Panels, tool rows, message cards.'),
  sidebar: surfaceRecipeSchema.optional().describe('The conversation list rail.'),
  popover: surfaceRecipeSchema.optional().describe('Menus, dropdowns and floating panels. The natural home for glass.'),
  header: surfaceRecipeSchema.optional().describe('The app title bar.'),
  input: surfaceRecipeSchema.optional().describe('Text fields and the composer. Sunken insets read as "type here" better than borders do.'),
  button: surfaceRecipeSchema.optional().describe('Primary and secondary buttons.'),
  code: surfaceRecipeSchema.optional().describe('Code blocks and terminal output.'),
  scrim: surfaceRecipeSchema.optional().describe('The dimming layer behind a modal.'),
  bubbleUser: surfaceRecipeSchema.optional().describe('The user\'s chat message bubble.'),
  bubbleAssistant: surfaceRecipeSchema.optional().describe('The assistant\'s chat message bubble.'),
}).strict();

export type SurfacesMap = z.infer<typeof surfacesMapSchema>;

/** A fill layer with every optional field filled in. */
export type ResolvedFillLayer = {
  kind: FillKind;
  angle: number;
  origin: FillOrigin;
  shape: 'circle' | 'ellipse';
  band: number;
  stops: { color: ColorRef; position: number | null }[];
  blend: BlendMode;
};

/** A border with every optional field filled in. */
export type ResolvedBorder = {
  width: number;
  style: 'none' | 'solid' | 'dashed' | 'dotted' | 'double';
  sides: BorderSide[];
  color: ColorRef;
  variant: 'flat' | 'gradient-ring';
  ring: { angle: number; stops: { color: ColorRef; position: number | null }[] } | null;
};

/** A shadow layer with every optional field filled in. */
export type ResolvedShadow = {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: ColorRef;
  alpha: number | null;
};

/** A fully-resolved recipe: what derivation actually reads. */
export type ResolvedSurfaceRecipe = {
  fill: ResolvedFillLayer[];
  border: ResolvedBorder;
  corner: { radius: number; shape: CornerShape };
  shadows: ResolvedShadow[];
  backdrop: { blur: number; saturate: number; brightness: number; refraction: number } | null;
  texture: {
    kind: TextureKind;
    opacity: number;
    scale: number;
    blend: BlendMode;
    pixels: { palette: ColorRef[]; grid: string[] } | null;
  };
  overlay: { kind: OverlayKind; angle: number; strength: number };
  ambient: {
    kind: AmbientKind;
    hue: number | null;
    strength: number;
    speed: number;
    scale: number;
    blend: BlendMode;
  };
  ink: { tier: number | null; mutedTier: number | null; glow: number };
};

/**
 * The look a theme gets when it says nothing at all.
 *
 * A plain opaque card: one solid fill, a hairline border, a modest radius, no
 * shadow, no texture. Every omitted field in every recipe resolves to this, so
 * "surfaces: { default: {} }" is a valid, complete, sane theme.
 */
export const BASELINE_RECIPE: ResolvedSurfaceRecipe = {
  fill: [{
    kind: 'solid',
    angle: 180,
    origin: 'center',
    shape: 'ellipse',
    band: 8,
    // `light` rather than `surface` because a panel sits above the page in a
    // light theme and in a dark one alike, and the `surface` ladder points at
    // the ink pole — which is black when the page is paper.
    stops: [{ color: { role: 'light', tier: 1 }, position: null }],
    blend: 'normal',
  }],
  border: {
    width: 1,
    style: 'solid',
    sides: [...BORDER_SIDES],
    color: { role: 'border' },
    variant: 'flat',
    ring: null,
  },
  corner: { radius: 10, shape: 'round' },
  shadows: [],
  backdrop: null,
  texture: { kind: 'none', opacity: 0.05, scale: 1, blend: 'overlay', pixels: null },
  overlay: { kind: 'none', angle: 145, strength: 0.12 },
  ambient: { kind: 'none', hue: null, strength: 0.12, speed: 60, scale: 1, blend: 'soft-light' },
  ink: { tier: null, mutedTier: null, glow: 0 },
};

const resolveFill = (layers: z.infer<typeof fillLayerSchema>[]): ResolvedFillLayer[] =>
  layers.map((layer) => ({
    kind: layer.kind,
    angle: layer.angle ?? 180,
    origin: layer.origin ?? 'center',
    shape: layer.shape ?? 'ellipse',
    band: layer.band ?? 8,
    stops: layer.stops.map((stop) => ({ color: stop.color, position: stop.position ?? null })),
    blend: layer.blend ?? 'normal',
  }));

const resolveShadows = (layers: z.infer<typeof shadowLayerSchema>[]): ResolvedShadow[] =>
  layers.map((layer) => ({
    inset: layer.inset ?? false,
    x: layer.x ?? 0,
    y: layer.y ?? 0,
    blur: layer.blur ?? 0,
    spread: layer.spread ?? 0,
    color: layer.color,
    alpha: layer.alpha ?? null,
  }));

/**
 * Layers a partial recipe over a resolved one, field by field.
 *
 * Per-field rather than per-group so `{ border: { width: 3 } }` keeps the
 * inherited border colour. Called twice per surface — baseline, then the
 * theme's `default`, then the named surface — which is what makes the
 * inheritance chain a chain rather than a two-level lookup.
 */
export function mergeRecipe(
  base: ResolvedSurfaceRecipe,
  patch: SurfaceRecipe | undefined,
): ResolvedSurfaceRecipe {
  if (!patch) return base;

  return {
    fill: patch.fill ? resolveFill(patch.fill) : base.fill,
    border: {
      width: patch.border?.width ?? base.border.width,
      style: patch.border?.style ?? base.border.style,
      sides: patch.border?.sides ?? base.border.sides,
      color: patch.border?.color ?? base.border.color,
      variant: patch.border?.variant ?? base.border.variant,
      ring: patch.border?.ring
        ? {
          angle: patch.border.ring.angle ?? 145,
          stops: patch.border.ring.stops.map((stop) => ({
            color: stop.color,
            position: stop.position ?? null,
          })),
        }
        : base.border.ring,
    },
    corner: {
      radius: patch.corner?.radius ?? base.corner.radius,
      shape: patch.corner?.shape ?? base.corner.shape,
    },
    shadows: patch.shadows ? resolveShadows(patch.shadows) : base.shadows,
    // `null` is an authored choice ("no backdrop"), `undefined` is inheritance.
    backdrop: patch.backdrop === undefined
      ? base.backdrop
      : patch.backdrop === null
        ? null
        : {
          blur: patch.backdrop.blur ?? 16,
          saturate: patch.backdrop.saturate ?? 1.6,
          brightness: patch.backdrop.brightness ?? 1,
          refraction: patch.backdrop.refraction ?? 0,
        },
    texture: {
      kind: patch.texture?.kind ?? base.texture.kind,
      opacity: patch.texture?.opacity ?? base.texture.opacity,
      scale: patch.texture?.scale ?? base.texture.scale,
      blend: patch.texture?.blend ?? base.texture.blend,
      pixels: patch.texture?.pixels ?? base.texture.pixels,
    },
    overlay: {
      kind: patch.overlay?.kind ?? base.overlay.kind,
      angle: patch.overlay?.angle ?? base.overlay.angle,
      strength: patch.overlay?.strength ?? base.overlay.strength,
    },
    ambient: {
      kind: patch.ambient?.kind ?? base.ambient.kind,
      hue: patch.ambient?.hue ?? base.ambient.hue,
      strength: patch.ambient?.strength ?? base.ambient.strength,
      speed: patch.ambient?.speed ?? base.ambient.speed,
      scale: patch.ambient?.scale ?? base.ambient.scale,
      blend: patch.ambient?.blend ?? base.ambient.blend,
    },
    ink: {
      tier: patch.ink?.tier ?? base.ink.tier,
      mutedTier: patch.ink?.mutedTier ?? base.ink.mutedTier,
      glow: patch.ink?.glow ?? base.ink.glow,
    },
  };
}
