import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveTokens } from '@/modules/appearance/derive.js';
import { isSubstantialChange } from '@/modules/appearance/proposal-gate.js';
import { serializeStylesheet } from '@/modules/appearance/serialize.js';
import { themeSpecV2Schema, type ThemeSpecV2 } from '@/modules/appearance/theme-spec.js';

/**
 * The texture channel a model draws for itself, and the gate that makes it get
 * shown before it lands.
 *
 * Both exist because of one report: "I tried asking it to make it look like
 * Minecraft, it came out hideous." That was not a taste failure. A blocky earth
 * surface needs a pixel tile, textures were a fixed app-owned set, so the model
 * approximated with gradients — asked for something it had no primitive for.
 * And the change went straight to `theme_apply` despite `theme_propose`
 * existing precisely for requests of that size.
 */

const base = (surfaces: ThemeSpecV2['surfaces']): ThemeSpecV2 => themeSpecV2Schema.parse({
  specVersion: 2,
  name: 'Blockwork',
  summary: 'Cubic earth and stone: flat pixel tiles and hard square edges.',
  mode: 'adaptive',
  palette: {
    surfaceHue: 28, surfaceChroma: 'rich',
    accentHue: 96, accentChroma: 'vivid',
    scheme: 'analogous', statusHueShift: 0,
  },
  type: {
    sansFamily: 'mono', displayFamily: 'mono', monoFamily: 'mono',
    scale: 'default', displayWeight: 'black', letterSpacing: 'normal',
    lineHeight: 'default', measure: 'wide',
  },
  density: 'default',
  motion: 'instant',
  surfaces,
});

/** Three browns, scattered rather than patterned — the earth block. */
const DIRT = {
  palette: [
    { role: 'surface' as const, tier: 3 },
    { role: 'surface' as const, tier: 5 },
    { role: 'shadow' as const, tier: 4 },
    { role: 'surface' as const, tier: 1 },
  ],
  grid: [
    '01302130', '30012301', '12330012', '03121300',
    '21003231', '30210103', '01330210', '13002130',
  ],
};

test('a model-authored tile reaches the stylesheet as app-written SVG', () => {
  const surface = deriveTokens(base({
    default: { texture: { kind: 'pixels', opacity: 0.85, scale: 2, blend: 'normal', pixels: DIRT } },
  })).light.surfaces.default;

  const image = surface['t-texture-image'];
  assert.match(image, /^url\("data:image\/svg\+xml,/);

  // `crispEdges` is what makes it a pixel tile rather than a soft check: the
  // rasteriser antialiases every cell boundary without it.
  assert.ok(image.includes('crispEdges'));

  // Nothing the model wrote is in the document. It supplied indices and roles;
  // every byte here came from `textures.ts`, which is a stronger guarantee than
  // any allowlist over authored markup could give.
  assert.doesNotMatch(image, /script|foreignObject|%3Cimage|xlink|href/i);
  assert.doesNotMatch(image, /url\("(?!data:)/);

  // Horizontal runs are merged. 64 cells, and a tile with any structure at all
  // should need appreciably fewer rects than one per cell.
  const rects = (image.match(/%3Crect/g) ?? []).length;
  assert.ok(rects > 0 && rects < 64, `expected merged runs, got ${rects} rects for 64 cells`);
});

test('a tile is drawn in theme colours, so it re-tints instead of freezing', () => {
  const spec = base({
    default: { texture: { kind: 'pixels', opacity: 1, scale: 1, blend: 'normal', pixels: DIRT } },
  });
  const derived = deriveTokens(spec);

  const light = derived.light.surfaces.default['t-texture-image'];
  const dark = derived.dark?.surfaces.default['t-texture-image'] ?? '';

  // The whole reason the palette is role references rather than literals.
  assert.notEqual(light, dark, 'the same tile must resolve differently in the two ramps');
  for (const image of [light, dark]) {
    assert.match(image, /hsl\(/, 'cells must be theme colours, not baked literals');
  }
});

test('chroma is the only way a tinted theme reaches a neutral', () => {
  // Every role derives from the palette's single surface hue, so a brown theme
  // had no way to express grey stone next to brown earth. This is what makes
  // two materials possible in one theme.
  const stone = {
    palette: [
      { role: 'surface' as const, tier: 4, chroma: 0.06 },
      { role: 'surface' as const, tier: 6, chroma: 0.06 },
    ],
    grid: ['0110', '1001', '0101', '1010'],
  };

  const tinted = deriveTokens(base({
    default: { texture: { kind: 'pixels', opacity: 1, scale: 1, blend: 'normal', pixels: DIRT } },
    sidebar: { texture: { kind: 'pixels', opacity: 1, scale: 1, blend: 'normal', pixels: stone } },
  })).light.surfaces;

  const saturation = (image: string): number =>
    Number(/hsl\([\d.]+ ([\d.]+)%25/.exec(image)?.[1] ?? '0');

  assert.ok(saturation(tinted.default['t-texture-image']) > 10, 'earth should stay brown');
  assert.ok(saturation(tinted.sidebar['t-texture-image']) < 3, 'stone should read as grey');
});

test('a ragged grid or a missing palette entry is rejected, not half-drawn', () => {
  const withTexture = (pixels: unknown) => themeSpecV2Schema.safeParse({
    ...base({}),
    surfaces: { default: { texture: { kind: 'pixels', pixels } } },
  });

  assert.equal(withTexture({ palette: [{ role: 'surface' }], grid: ['00', '000'] }).success, false, 'ragged rows');
  assert.equal(withTexture({ palette: [{ role: 'surface' }], grid: ['01', '10'] }).success, false, 'index with no colour behind it');
  assert.equal(withTexture({ palette: [{ role: 'surface' }], grid: ['0x', '00'] }).success, false, 'character outside 0-7 and .');
  assert.equal(withTexture({ palette: [], grid: ['00', '00'] }).success, false, 'empty palette');

  // And `kind: "pixels"` with nothing to draw.
  assert.equal(themeSpecV2Schema.safeParse({
    ...base({}),
    surfaces: { default: { texture: { kind: 'pixels' } } },
  }).success, false);

  assert.ok(withTexture({ palette: [{ role: 'surface' }, { role: 'shadow' }], grid: ['0.1', '1.0'] }).success, 'holes are allowed');
});

test('one tile shared across parts is written once', () => {
  // Every part inherits the default's texture and the serializer emits every
  // part's full token set, so an 8x8 tile was landing in the stylesheet ten
  // times per ramp — 130KB for one image.
  const css = serializeStylesheet(deriveTokens(base({
    default: { texture: { kind: 'pixels', opacity: 0.85, scale: 2, blend: 'normal', pixels: DIRT } },
  })));

  // Two, not one: an adaptive theme resolves the tile's roles separately per
  // ramp, so the light and dark versions are genuinely different images. What
  // matters is that it is two rather than the twenty it was — one write per
  // distinct image instead of one per part per ramp.
  const inlined = (css.match(/url\("data:image\/svg\+xml,%3Csvg[^"]*%3Crect/g) ?? []).length;
  assert.equal(inlined, 2, 'a repeated tile must be hoisted into a shared custom property, once per ramp');
  assert.match(css, /--tex-1:/);
  assert.match(css, /--t-texture-image: var\(--tex-\d\)/);
});

/* ------------------------------------------------------------------ *
 * The proposal gate.
 * ------------------------------------------------------------------ */

test('a structural change is substantial; a recolour is not', () => {
  const plain = base({});
  const blocky = base({
    default: {
      corner: { radius: 0, shape: 'square' },
      texture: { kind: 'pixels', opacity: 0.85, scale: 2, blend: 'normal', pixels: DIRT },
    },
  });

  // The case that prompted this: arriving on the built-in floor and applying a
  // whole visual world in one call.
  assert.equal(isSubstantialChange(blocky, null), true);
  assert.equal(isSubstantialChange(blocky, plain), true);

  // And the case it must not catch, or the gate becomes noise: a refinement.
  const recoloured = themeSpecV2Schema.parse({
    ...blocky,
    palette: { ...blocky.palette, accentHue: 200 },
    type: { ...blocky.type, sansFamily: 'grotesk' },
    density: 'airy',
    motion: 'calm',
  });
  assert.equal(isSubstantialChange(recoloured, blocky), false);
  assert.equal(isSubstantialChange(plain, plain), false);

  // Re-applying the identical spec, round-tripped through the schema. Zod fills
  // a defaulted group in factory order the first time and in declaration order
  // the second, so a naive stringify compares two identical looks as different
  // and the gate fires on the most harmless call there is.
  assert.equal(isSubstantialChange(themeSpecV2Schema.parse({ ...blocky }), blocky), false);
});

test('pinning the colour mode and moving the ramp anchor are structural', () => {
  const plain = base({});
  assert.equal(isSubstantialChange(themeSpecV2Schema.parse({ ...plain, mode: 'dark' }), plain), true);
  assert.equal(
    isSubstantialChange(
      themeSpecV2Schema.parse({ ...plain, surface: { ...plain.surface, lightAnchor: 'mid' } }),
      plain,
    ),
    true,
  );
});

/* ------------------------------------------------------------------ *
 * The pointer kinds Prism needed.
 * ------------------------------------------------------------------ */

test('a trail no longer requires a drawn cursor', () => {
  // It did, and that made a reasonable look unreachable: pixels following the
  // native arrow with nothing glowing under it. The click effect was already
  // independent, which is what made the coupling look like an oversight rather
  // than a decision.
  const spec = themeSpecV2Schema.parse({
    ...base({}),
    interaction: {
      pointer: {
        kind: 'system',
        trail: { kind: 'pixel', length: 12, size: 10, opacity: 0.55 },
        click: { kind: 'minesweeper', size: 104, seconds: 0.42 },
      },
    },
  });
  const tokens = deriveTokens(spec).light.interaction ?? {};

  assert.equal(tokens['t-pointer-image'], 'none', 'no glow was asked for');
  assert.notEqual(tokens['t-trail-image'], 'none', 'the trail must survive the cursor being off');
  assert.notEqual(tokens['t-click-image'], 'none');
});

test('a pixel trail is square, flat and grid-snapped', () => {
  const spec = themeSpecV2Schema.parse({
    ...base({}),
    interaction: { pointer: { kind: 'system', trail: { kind: 'pixel', length: 8, size: 10, opacity: 0.5 } } },
  });
  const tokens = deriveTokens(spec).light.interaction ?? {};

  // Flat fill, not a radial dot: the falloff is what makes a segment read as a
  // circle however square the element is.
  assert.match(tokens['t-trail-image'], /^linear-gradient\(/);
  assert.doesNotMatch(tokens['t-trail-image'], /radial-gradient/);

  // Squares off the element, and is the same signal the renderer reads to
  // quantise positions — a square on a fractional pixel is a blurry square.
  assert.equal(tokens['t-trail-radius'], '0');
  assert.equal(tokens['t-trail-taper'], '0', 'pixels keep their size; only opacity falls off');

  const round = deriveTokens(themeSpecV2Schema.parse({
    ...base({}),
    interaction: { pointer: { kind: 'halo', trail: { kind: 'comet', length: 8, size: 10, opacity: 0.5 } } },
  })).light.interaction ?? {};
  assert.equal(round['t-trail-radius'], '50%');
  assert.match(round['t-trail-image'], /^radial-gradient\(/);
});

test('the minesweeper click is a tiled bevel that presses in', () => {
  const spec = themeSpecV2Schema.parse({
    ...base({}),
    interaction: { pointer: { kind: 'system', click: { kind: 'minesweeper', size: 104, seconds: 0.42 } } },
  });
  const tokens = deriveTokens(spec).light.interaction ?? {};

  // Two mitred quadrilaterals over a face. A gradient cannot make the
  // 45-degree join where the light edge meets the dark one, which is the
  // detail that separates the real bevel from a rounded imitation.
  assert.match(tokens['t-click-image'], /^url\("data:image\/svg\+xml,/);
  assert.equal((tokens['t-click-image'].match(/%3Cpath/g) ?? []).length, 2);
  assert.ok(tokens['t-click-image'].includes('crispEdges'));

  // Tiled rather than stretched, and pressing in rather than expanding out.
  assert.equal(tokens['t-click-tile'], '16px 16px');
  assert.match(tokens['t-click-animation'], /^t-click-press 0\.42s/);

  const ripple = deriveTokens(themeSpecV2Schema.parse({
    ...base({}),
    interaction: { pointer: { kind: 'halo', click: { kind: 'ripple', size: 88, seconds: 0.5 } } },
  })).light.interaction ?? {};
  assert.equal(ripple['t-click-tile'], '100% 100%');
  assert.match(ripple['t-click-animation'], /^t-click-ripple /);
});
