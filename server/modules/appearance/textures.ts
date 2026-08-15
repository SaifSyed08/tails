import type { BlendMode, OverlayKind, TextureKind } from '@/modules/appearance/surface-recipe.js';

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
 * A fractal-noise tile.
 *
 * `baseFrequency` is what separates fine photographic grain from coarse paper
 * fibre, so the two textures are one generator at two frequencies rather than
 * two hand-written SVGs that drift apart.
 */
const noiseTile = (frequency: number, octaves: number, tile: number): string => encodeSvg(`
  <svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${tile}">
    <filter id="n">
      <feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="${octaves}" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
    <rect width="100%" height="100%" filter="url(#n)"/>
  </svg>
`);

/** A dot grid, the halftone base. */
const halftoneTile = (tile: number): string => encodeSvg(`
  <svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${tile}">
    <circle cx="${tile / 4}" cy="${tile / 4}" r="${tile / 6}" fill="#fff"/>
    <circle cx="${(tile * 3) / 4}" cy="${(tile * 3) / 4}" r="${tile / 6}" fill="#fff"/>
  </svg>
`);

/** An ordered 4x4 Bayer-ish dither cell. */
const ditherTile = (): string => encodeSvg(`
  <svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">
    <rect width="4" height="4" fill="#000"/>
    <rect x="0" y="0" width="1" height="1" fill="#fff"/>
    <rect x="2" y="1" width="1" height="1" fill="#fff"/>
    <rect x="1" y="2" width="1" height="1" fill="#fff"/>
    <rect x="3" y="3" width="1" height="1" fill="#fff"/>
  </svg>
`);

/** A texture as the renderer consumes it: an image plus the tile size to repeat it at. */
export type TexturePaint = { image: string; size: string };

/**
 * The texture table.
 *
 * Scale multiplies the tile size rather than the noise frequency so a theme can
 * ask for coarser grain without the generator re-running — the data URI is a
 * constant and only `background-size` moves.
 */
const TEXTURE_PAINTS: Record<Exclude<TextureKind, 'none'>, (scale: number) => TexturePaint> = {
  grain: (scale) => ({
    image: `url("data:image/svg+xml,${noiseTile(0.85, 4, 120)}")`,
    size: `${Math.round(120 * scale)}px ${Math.round(120 * scale)}px`,
  }),
  paper: (scale) => ({
    image: `url("data:image/svg+xml,${noiseTile(0.28, 5, 180)}")`,
    size: `${Math.round(180 * scale)}px ${Math.round(180 * scale)}px`,
  }),
  halftone: (scale) => ({
    image: `url("data:image/svg+xml,${halftoneTile(12)}")`,
    size: `${Math.round(12 * scale)}px ${Math.round(12 * scale)}px`,
  }),
  dither: (scale) => ({
    image: `url("data:image/svg+xml,${ditherTile()}")`,
    size: `${Math.round(4 * scale)}px ${Math.round(4 * scale)}px`,
  }),
  // Scanline and grid are pure gradients: no data URI needed, and they stay
  // crisp at any device pixel ratio where a raster tile would shimmer.
  scanline: (scale) => ({
    image: 'repeating-linear-gradient(0deg, #fff 0, #fff 1px, transparent 1px, transparent 3px)',
    size: `100% ${Math.max(2, Math.round(3 * scale))}px`,
  }),
  grid: (scale) => ({
    image: [
      'linear-gradient(0deg, #fff 0, #fff 1px, transparent 1px)',
      'linear-gradient(90deg, #fff 0, #fff 1px, transparent 1px)',
    ].join(', '),
    size: `${Math.round(24 * scale)}px ${Math.round(24 * scale)}px`,
  }),
};

/** Resolves a texture selection to its paint, or null for "none". */
export function readTexturePaint(kind: TextureKind, scale: number): TexturePaint | null {
  if (kind === 'none') return null;
  return TEXTURE_PAINTS[kind](scale);
}

/**
 * Lighting overlays.
 *
 * Written against two colour placeholders the caller substitutes with resolved
 * theme colours, rather than hard-coded white and black: a sheen made of literal
 * white is invisible on a paper theme and blows out a pastel one.
 */
export type OverlayPaint = { image: string; blend: BlendMode };

const OVERLAY_PAINTS: Record<
  Exclude<OverlayKind, 'none'>,
  (angle: number, light: string, shadow: string) => OverlayPaint
> = {
  sheen: (angle, light) => ({
    image: `linear-gradient(${angle}deg, ${light} 0%, transparent 42%, transparent 58%, ${light} 100%)`,
    blend: 'soft-light',
  }),
  topLight: (_angle, light) => ({
    image: `linear-gradient(180deg, ${light} 0%, transparent 55%)`,
    blend: 'soft-light',
  }),
  vignette: (_angle, _light, shadow) => ({
    image: `radial-gradient(ellipse at center, transparent 45%, ${shadow} 100%)`,
    blend: 'multiply',
  }),
};

/** Resolves an overlay selection to its paint, or null for "none". */
export function readOverlayPaint(
  kind: OverlayKind,
  angle: number,
  light: string,
  shadow: string,
): OverlayPaint | null {
  if (kind === 'none') return null;
  return OVERLAY_PAINTS[kind](angle, light, shadow);
}
