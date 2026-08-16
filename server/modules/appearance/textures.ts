import type {
  AmbientKind,
  BlendMode,
  OverlayKind,
  TextureKind,
} from '@/modules/appearance/surface-recipe.js';
import type { PointerKind, TrailKind } from '@/modules/appearance/theme-spec.js';

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
/**
 * A model-authored pixel tile, rendered to SVG by us.
 *
 * The safety property here is structural rather than enforced: the model never
 * supplies markup, only a grid of palette indices and a list of colour roles,
 * so there is nothing authored to parse and nothing to allowlist. Every byte of
 * the document below is written by this function. That is a stronger guarantee
 * than validating authored SVG would be, and it costs no parser — which matters
 * because there is no XML parser in this project and hand-rolling one to guard
 * a security boundary is exactly the mistake `freeform-css.ts` exists to avoid.
 *
 * Horizontal runs are merged into single rects. A 16x16 tile is 256 cells and
 * one rect each would be roughly 15KB of data URI sitting in a custom property;
 * real tiles are mostly runs, so merging typically cuts that by three or four
 * times. `shape-rendering="crispEdges"` is what keeps the result blocky —
 * without it the rasteriser antialiases every cell boundary and a pixel tile
 * arrives looking like a soft check.
 */
function pixelTile(grid: string[], colors: string[]): string {
  const width = grid[0].length;
  const rects: string[] = [];

  grid.forEach((row, y) => {
    let runStart = 0;
    for (let x = 1; x <= width; x += 1) {
      const cell = row[runStart];
      if (x < width && row[x] === cell) continue;
      if (cell !== '.') {
        rects.push(`<rect x="${runStart}" y="${y}" width="${x - runStart}" height="1" fill="${colors[Number(cell)]}"/>`);
      }
      runStart = x;
    }
  });

  return encodeSvg(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${grid.length}" shape-rendering="crispEdges">
      ${rects.join('')}
    </svg>
  `);
}

const TEXTURE_PAINTS: Record<
  Exclude<TextureKind, 'none' | 'pixels'>,
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
  pixels?: { grid: string[]; colors: string[] } | null,
): TexturePaint | null {
  if (kind === 'none' || opacity <= 0) return null;

  if (kind === 'pixels') {
    if (!pixels || pixels.grid.length === 0) return null;
    return {
      image: `url("data:image/svg+xml,${pixelTile(pixels.grid, pixels.colors)}")`,
      // One cell per 4 device pixels at scale 1. A tile drawn at its own cell
      // count would be invisible, and sizing off the grid rather than a fixed
      // number keeps an 8x8 and a 16x16 tile the same physical coarseness.
      size: `${Math.round(pixels.grid[0].length * 4 * scale)}px ${Math.round(pixels.grid.length * 4 * scale)}px`,
    };
  }

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
 * The app-drawn cursor and its trail.
 *
 * Gradients rather than images, and that is forced rather than chosen: a custom
 * cursor is normally `cursor: url(...)`, and `url()` is the one thing this
 * system refuses everywhere, because a stylesheet that can name a remote image
 * can report where the user is pointing at the resolution of every hover. What
 * is left is the shapes CSS can draw, which turns out to be enough — a soft
 * halo, a hollow ring and a filled dot are the three shapes anybody actually
 * wants, and all three are one radial gradient.
 *
 * The colour arrives fully opaque and the *strength* stays on the element as
 * `opacity`. That is the opposite of the rule textures and overlays follow, and
 * the difference is real: those two share one pseudo-element and therefore one
 * `opacity`, so their strength has to live in the pixels. A cursor is its own
 * element with one layer, so its opacity is free — and leaving it free is what
 * lets `theme_controls` publish "how strong" as a slider that binds
 * `--t-pointer-opacity` directly, with no re-derivation.
 */
export function readPointerPaint(kind: PointerKind, color: string): string {
  switch (kind) {
    case 'system':
      return 'none';
    // Soft all the way out. This is the shape a frame of lag is invisible on,
    // which is why it is the default and the only one worth using with
    // `replace`.
    case 'halo':
      return `radial-gradient(circle closest-side, ${color} 0%, transparent 72%)`;
    case 'ring':
      return `radial-gradient(circle closest-side, transparent 0%, transparent 56%, ${color} 62%, ${color} 78%, transparent 84%)`;
    case 'dot':
      return `radial-gradient(circle closest-side, ${color} 0%, ${color} 40%, transparent 52%)`;
  }
}

/**
 * The click ripple.
 *
 * A ring rather than a filled disc. A disc expanding from the click point
 * covers whatever was just clicked at exactly the moment the user is looking at
 * it to see what happened; a ring leaves the middle alone and still reads as
 * "that registered".
 */
export function readClickPaint(color: string): string {
  return `radial-gradient(circle closest-side, transparent 0%, transparent 52%, ${color} 66%, transparent 78%)`;
}

/**
 * A Minesweeper tile: light top-left bevel, dark bottom-right, flat face.
 *
 * Two mitred quadrilaterals rather than four gradient stops, because the corner
 * where the light edge meets the dark one is a 45-degree mitre and a gradient
 * cannot make that join — it is the detail that separates the real Windows
 * bevel from a rounded imitation of it. `crispEdges` keeps the mitre a hard
 * line at any tile size.
 *
 * App-owned, so nothing here is authored: the theme picks the three colours by
 * role and this writes the document.
 */
export function readMinesweeperTile(face: string, light: string, dark: string): string {
  return `url("data:image/svg+xml,${encodeSvg(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">
      <rect width="16" height="16" fill="${face}"/>
      <path d="M0 0h16l-3 3H3v10L0 16Z" fill="${light}"/>
      <path d="M16 0v16H0l3-3h10V3Z" fill="${dark}"/>
    </svg>
  `)}")`;
}

/**
 * A fracture, drawn as pressed-in pixels.
 *
 * The ripple and the bevel grid both fade a shape out; this one is meant to
 * read as damage — pixels along a crack being pushed *into* the surface. So the
 * bevel is inverted relative to `readMinesweeperTile`: shadow on the top-left
 * edge and light on the bottom-right is what the eye reads as a dent, and the
 * same two strips the other way round is what it reads as a button.
 *
 * The arm geometry comes from a fixed-seed generator rather than `Math.random`
 * because the derivation is required to be deterministic — the same spec must
 * produce byte-identical CSS, and a crack that reshuffled on every compile
 * would break that and make every saved theme's cached tokens wrong.
 */
export function readCrackTile(pixel: string, shade: string, light: string): string {
  const SPAN = 48;
  const centre = SPAN / 2;
  const cell = 2;

  // A tiny LCG. Deterministic, seeded once, and the constants are the usual
  // Numerical Recipes pair — this only has to look irregular, not be random.
  let seed = 0x2f6e2b1;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const blocks: string[] = [];
  const arms = 6;

  for (let arm = 0; arm < arms; arm += 1) {
    // Evenly spread, then jittered, so the arms do not read as a snowflake.
    let angle = (arm / arms) * Math.PI * 2 + (next() - 0.5) * 0.7;
    let x = centre;
    let y = centre;
    const reach = centre * (0.55 + next() * 0.45);

    for (let step = 0; step * cell < reach; step += 1) {
      // The walk wanders as it travels, which is what makes it a fracture
      // rather than a spoke.
      angle += (next() - 0.5) * 0.55;
      x += Math.cos(angle) * cell;
      y += Math.sin(angle) * cell;

      const bx = Math.round(x / cell) * cell;
      const by = Math.round(y / cell) * cell;
      if (bx < 0 || by < 0 || bx >= SPAN || by >= SPAN) break;

      blocks.push(
        `<rect x="${bx}" y="${by}" width="${cell}" height="${cell}" fill="${pixel}"/>`
        + `<rect x="${bx}" y="${by}" width="${cell}" height="0.5" fill="${shade}"/>`
        + `<rect x="${bx}" y="${by}" width="0.5" height="${cell}" fill="${shade}"/>`
        + `<rect x="${bx}" y="${by + cell - 0.5}" width="${cell}" height="0.5" fill="${light}"/>`
        + `<rect x="${bx + cell - 0.5}" y="${by}" width="0.5" height="${cell}" fill="${light}"/>`,
      );
    }
  }

  return `url("data:image/svg+xml,${encodeSvg(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SPAN} ${SPAN}" shape-rendering="crispEdges">
      ${blocks.join('')}
    </svg>
  `)}")`;
}

/**
 * One trail segment.
 *
 * Soft dot for the two round kinds — a hard edge repeated eight times reads as
 * beads rather than as motion. `pixel` is the opposite on purpose: a flat fill
 * with no falloff at all, so each segment is a solid square. The squareness
 * comes from the fill being flat; `--t-trail-radius` squares the element off,
 * and the renderer snaps the positions so the squares land on a grid instead of
 * on fractional pixels.
 */
export function readTrailPaint(kind: TrailKind, color: string): string {
  if (kind === 'none') return 'none';
  if (kind === 'pixel') return `linear-gradient(${color}, ${color})`;
  return `radial-gradient(circle closest-side, ${color} 0%, ${color} 34%, transparent 70%)`;
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
