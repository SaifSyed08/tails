import type {
  AmbientKind,
  BlendMode,
  OverlayKind,
  TextureKind,
} from '@/modules/appearance/surface-recipe.js';

/**
 * Every image a theme can put on a surface, owned by the app.
 *
 * Themes select a texture by name and never author `url()`. That is not a
 * stylistic preference, it is the entire exfiltration defence: a stylesheet
 * that cannot name a URL cannot make a network request, so no generated theme
 * — however it was prompted — can turn a colour choice into an outbound
 * signal. The freeform CSS validator enforces the same ban on author bytes;
 * this file is the reason that ban costs the model nothing, because everything
 * it would reach for a URL to do is already here.
 *
 * The SVG generators are percent-encoded rather than base64: encoded SVG is
 * smaller than base64 for this content, and it stays readable in devtools,
 * which matters when someone is debugging why a surface looks grey.
 */

/** Percent-encodes an SVG document for use in a `url("data:image/svg+xml,...")`. */
const encodeSvg = (svg: string): string =>
  svg
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[%#<>?[\]^`{|}"]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/**
 * Rounds an alpha to three places.
 *
 * Every generator bakes its strength into its own pixels rather than leaving it
 * to a CSS `opacity` on the layer. That is not a micro-optimisation: a surface
 * has two pseudo-elements and three things that want to be painted on them
 * (texture, lighting overlay, specular ring), and `opacity` applies to a whole
 * element while `background-image` stacks. Baking alpha lets two of those three
 * ride as sibling background layers on one pseudo-element, which is the only
 * arrangement that fits.
 */
const alphaOf = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;

/**
 * A fractal-noise tile.
 *
 * `baseFrequency` is what separates fine photographic grain from coarse paper
 * fibre, so the two textures are one generator at two frequencies rather than
 * two hand-written SVGs that drift apart.
 */
const noiseTile = (frequency: number, octaves: number, tile: number, alpha: number): string => encodeSvg(`
  <svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${tile}">
    <filter id="n">
      <feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="${octaves}" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
    <rect width="100%" height="100%" filter="url(#n)" opacity="${alphaOf(alpha)}"/>
  </svg>
`);

/** A dot grid, the halftone base. */
const halftoneTile = (tile: number, alpha: number): string => encodeSvg(`
  <svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${tile}">
    <g opacity="${alphaOf(alpha)}">
      <circle cx="${tile / 4}" cy="${tile / 4}" r="${tile / 6}" fill="#fff"/>
      <circle cx="${(tile * 3) / 4}" cy="${(tile * 3) / 4}" r="${tile / 6}" fill="#fff"/>
    </g>
  </svg>
`);

/** An ordered 4x4 Bayer-ish dither cell. */
const ditherTile = (alpha: number): string => encodeSvg(`
  <svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">
    <g opacity="${alphaOf(alpha)}">
      <rect width="4" height="4" fill="#000"/>
      <rect x="0" y="0" width="1" height="1" fill="#fff"/>
      <rect x="2" y="1" width="1" height="1" fill="#fff"/>
      <rect x="1" y="2" width="1" height="1" fill="#fff"/>
      <rect x="3" y="3" width="1" height="1" fill="#fff"/>
    </g>
  </svg>
`);

/** White at a given alpha, for the gradient-based textures. */
const ink = (alpha: number): string => `rgb(255 255 255 / ${alphaOf(alpha)})`;

/** A texture as the renderer consumes it: an image plus the tile size to repeat it at. */
export type TexturePaint = { image: string; size: string };

/**
 * The texture table.
 *
 * Scale multiplies the tile size rather than the noise frequency so a theme can
 * ask for coarser grain without changing what the generator draws — only
 * `background-size` moves.
 */
const TEXTURE_PAINTS: Record<
  Exclude<TextureKind, 'none'>,
  (scale: number, alpha: number) => TexturePaint
> = {
  grain: (scale, alpha) => ({
    image: `url("data:image/svg+xml,${noiseTile(0.85, 4, 120, alpha)}")`,
    size: `${Math.round(120 * scale)}px ${Math.round(120 * scale)}px`,
  }),
  paper: (scale, alpha) => ({
    image: `url("data:image/svg+xml,${noiseTile(0.28, 5, 180, alpha)}")`,
    size: `${Math.round(180 * scale)}px ${Math.round(180 * scale)}px`,
  }),
  halftone: (scale, alpha) => ({
    image: `url("data:image/svg+xml,${halftoneTile(12, alpha)}")`,
    size: `${Math.round(12 * scale)}px ${Math.round(12 * scale)}px`,
  }),
  dither: (scale, alpha) => ({
    image: `url("data:image/svg+xml,${ditherTile(alpha)}")`,
    size: `${Math.round(4 * scale)}px ${Math.round(4 * scale)}px`,
  }),
  // Scanline and grid are pure gradients: no data URI needed, and they stay
  // crisp at any device pixel ratio where a raster tile would shimmer.
  scanline: (scale, alpha) => ({
    image: `repeating-linear-gradient(0deg, ${ink(alpha)} 0, ${ink(alpha)} 1px, transparent 1px, transparent 3px)`,
    size: `100% ${Math.max(2, Math.round(3 * scale))}px`,
  }),
  grid: (scale, alpha) => ({
    image: [
      `linear-gradient(0deg, ${ink(alpha)} 0, ${ink(alpha)} 1px, transparent 1px)`,
      `linear-gradient(90deg, ${ink(alpha)} 0, ${ink(alpha)} 1px, transparent 1px)`,
    ].join(', '),
    size: `${Math.round(24 * scale)}px ${Math.round(24 * scale)}px`,
  }),
};

/**
 * Resolves a texture selection to its paint, or null for "none".
 *
 * The opacity is baked into the returned image. Nothing downstream should apply
 * it a second time — see `alphaOf` for why the strength lives in the pixels.
 */
export function readTexturePaint(
  kind: TextureKind,
  scale: number,
  opacity: number,
): TexturePaint | null {
  if (kind === 'none' || opacity <= 0) return null;
  return TEXTURE_PAINTS[kind](scale, opacity);
}

/**
 * Lighting overlays.
 *
 * Built from theme colours supplied as alpha-taking functions rather than from
 * literal white and black: a sheen made of real white is invisible on a paper
 * theme and blows out a pastel one, and taking the alpha as an argument is what
 * lets `strength` be baked into the stops instead of applied afterwards.
 */
export type OverlayPaint = { image: string; blend: BlendMode };

/** Resolved theme colours an overlay may draw with, at any alpha. */
export type OverlayTint = {
  light: (alpha: number) => string;
  shadow: (alpha: number) => string;
};

const OVERLAY_PAINTS: Record<
  Exclude<OverlayKind, 'none'>,
  (angle: number, strength: number, tint: OverlayTint) => OverlayPaint
> = {
  sheen: (angle, strength, tint) => ({
    image: `linear-gradient(${angle}deg, ${tint.light(strength * 0.9)} 0%, transparent 42%, transparent 58%, ${tint.light(strength * 0.55)} 100%)`,
    blend: 'soft-light',
  }),
  topLight: (_angle, strength, tint) => ({
    image: `linear-gradient(180deg, ${tint.light(strength)} 0%, transparent 55%)`,
    blend: 'soft-light',
  }),
  vignette: (_angle, strength, tint) => ({
    image: `radial-gradient(ellipse at center, transparent 45%, ${tint.shadow(strength)} 100%)`,
    blend: 'multiply',
  }),
};

/**
 * Resolves an overlay selection to its paint, or null for "none".
 *
 * As with textures, the strength is in the stops. The returned image is
 * self-sufficient and can sit beside a texture as a second background layer.
 */
export function readOverlayPaint(
  kind: OverlayKind,
  angle: number,
  strength: number,
  tint: OverlayTint,
): OverlayPaint | null {
  if (kind === 'none' || strength <= 0) return null;
  return OVERLAY_PAINTS[kind](angle, strength, tint);
}

/**
 * Ambient motion — the moving half of a background.
 *
 * Two decisions are worth recording because both are load-bearing and neither
 * is obvious.
 *
 * **The animation only ever moves `background-position` or `transform`.** Both
 * are compositor-only properties, so an ambient layer running for the whole
 * session costs no layout, no paint and no main-thread work. Animating
 * `background-image` stops or `filter` instead would look identical for a
 * second and then cost frames forever, on a layer nobody is looking at.
 *
 * **The keyframes are app-owned constants, not generated.** A theme picks a
 * named motion and supplies colour, speed and scale; it cannot author a
 * keyframe. That keeps the whole feature inside the same promise as textures —
 * the app draws, the theme chooses — and it means the four motions can be tuned
 * in one place rather than being frozen into every saved theme's token blob.
 */
export type AmbientPaint = { image: string; size: string; animation: string };

/**
 * The keyframes the ambient animations reference.
 *
 * Emitted into the theme stylesheet by `serialize.ts`, once, and only when a
 * surface actually uses one. Names carry the `t-` prefix that marks everything
 * the theme layer owns.
 *
 * The `--t-ambient-speed` multiplier inside each `animation` value below is what
 * makes "how fast" a live control rather than a re-derivation: the property is
 * never declared, so it resolves to its fallback of `1` until someone sets it
 * on `:root`, and the moment they do every ambient layer in the app retimes
 * without a single token being recompiled.
 */
export const AMBIENT_KEYFRAMES = `
@keyframes t-ambient-drift {
  from { background-position: 0% 50%; }
  to { background-position: 200% 50%; }
}

@keyframes t-ambient-clouds {
  0% { background-position: 0% 20%, 100% 80%; }
  50% { background-position: 100% 60%, 20% 30%; }
  100% { background-position: 0% 20%, 100% 80%; }
}

@keyframes t-ambient-grid {
  from { background-position: 0 0, 0 0; }
  to { background-position: 40px 40px, 40px 40px; }
}

@keyframes t-ambient-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.09); }
}
`.trim();

/** A colour at a given alpha, from a hue the theme chose. */
export type AmbientTint = (hue: number, alpha: number, lightness?: number) => string;

const AMBIENT_PAINTS: Record<
  Exclude<AmbientKind, 'none'>,
  (hue: number, strength: number, scale: number, tint: AmbientTint) => Omit<AmbientPaint, 'animation'>
> = {
  // One wide band sliding sideways. `background-size: 220%` is what gives the
  // position animation somewhere to travel — at 100% there is nothing to slide.
  drift: (hue, strength, scale, tint) => ({
    image: `linear-gradient(100deg, transparent 0%, ${tint(hue, strength)} 25%, ${tint(hue + 40, strength * 0.7)} 50%, transparent 78%)`,
    size: `${Math.round(220 * scale)}% ${Math.round(160 * scale)}%`,
  }),
  // Two soft masses on independent paths. The second is deliberately a
  // different hue and a different size, because two identical blobs moving in
  // step read as a bug rather than as weather.
  clouds: (hue, strength, scale, tint) => ({
    image: [
      `radial-gradient(ellipse 60% 50% at 30% 40%, ${tint(hue, strength)} 0%, transparent 70%)`,
      `radial-gradient(ellipse 50% 60% at 70% 60%, ${tint(hue + 55, strength * 0.75)} 0%, transparent 72%)`,
    ].join(', '),
    size: `${Math.round(170 * scale)}% ${Math.round(170 * scale)}%, ${Math.round(210 * scale)}% ${Math.round(190 * scale)}%`,
  }),
  // A lattice scrolling one cell per cycle, so the loop is seamless. The 40px
  // period is fixed to match the keyframe, and `scale` moves the drawn line
  // spacing rather than the travel distance.
  grid: (hue, strength, scale, tint) => ({
    image: [
      `linear-gradient(0deg, ${tint(hue, strength)} 0, ${tint(hue, strength)} 1px, transparent 1px)`,
      `linear-gradient(90deg, ${tint(hue, strength)} 0, ${tint(hue, strength)} 1px, transparent 1px)`,
    ].join(', '),
    size: `${Math.round(40 * scale)}px ${Math.round(40 * scale)}px, ${Math.round(40 * scale)}px ${Math.round(40 * scale)}px`,
  }),
  pulse: (hue, strength, scale, tint) => ({
    image: `radial-gradient(ellipse 70% 70% at 50% 45%, ${tint(hue, strength)} 0%, transparent 75%)`,
    size: `${Math.round(120 * scale)}% ${Math.round(120 * scale)}%`,
  }),
};

/** Motions whose loop only reads correctly when it eases rather than runs flat. */
const AMBIENT_EASING: Partial<Record<Exclude<AmbientKind, 'none'>, string>> = {
  clouds: 'ease-in-out',
  pulse: 'ease-in-out',
};

/**
 * Resolves an ambient selection to its paint, or null for "none".
 *
 * As with textures and overlays the strength is baked into the colour stops,
 * because the layer's own `opacity` is spent on the presence flag and applying
 * the strength twice is a bug that reads as "the ambience is too subtle" for a
 * week before anyone finds it.
 */
export function readAmbientPaint(
  kind: AmbientKind,
  hue: number,
  strength: number,
  speed: number,
  scale: number,
  tint: AmbientTint,
): AmbientPaint | null {
  if (kind === 'none' || strength <= 0) return null;

  const paint = AMBIENT_PAINTS[kind](hue, strength, scale, tint);
  const easing = AMBIENT_EASING[kind] ?? 'linear';

  return {
    ...paint,
    animation: `t-ambient-${kind} calc(${speed}s * var(--t-ambient-speed, 1)) ${easing} infinite`,
  };
}
