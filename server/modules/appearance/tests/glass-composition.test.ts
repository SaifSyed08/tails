import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveTokens } from '@/modules/appearance/derive.js';
import { serializeStylesheet } from '@/modules/appearance/serialize.js';
import { themeSpecV2Schema, type ThemeSpecV2 } from '@/modules/appearance/theme-spec.js';

/**
 * Glass, built out of primitives, with no preset behind it.
 *
 * The engine used to ship a `liquidGlass` preset, and then "make it liquid
 * glass" was used to check whether the engine could produce glass. It could,
 * and the check meant nothing: the answer had been written into the question.
 * Deleting the preset is only half the correction — the other half is a test
 * that the primitives genuinely reach the look, because otherwise deleting it
 * would just be hiding a gap.
 *
 * So the spec below is written the way a model would have to write it, from the
 * four things glass actually is:
 *
 *   1. a translucent fill, so there is something to see through;
 *   2. a wide backdrop blur *with saturation*, which is the term that stops
 *      glass reading as fog;
 *   3. a bright specular ring on the light-facing edge, which is what makes it
 *      read as a physical edge rather than a translucent rectangle;
 *   4. a soft ambient shadow, so it sits above the page instead of in it.
 *
 * Each assertion below names which of the four it is checking. If one of them
 * ever fails, that is a missing primitive and a real bug — and the point of
 * having no preset is that it fails loudly instead of being papered over.
 */

/**
 * A glass spec derived by composition.
 *
 * Nothing here is glass-specific vocabulary: `fill` with alpha, `backdrop`,
 * `border.variant: "gradient-ring"` and a `shadows` list are the same four
 * groups the brutalist and neumorphic looks use for entirely different ends.
 */
const GLASS: ThemeSpecV2 = themeSpecV2Schema.parse({
  specVersion: 2,
  name: 'Composed Glass',
  summary: 'Glass assembled from a translucent fill, a saturating backdrop, a specular ring and an ambient drop.',
  mode: 'adaptive',
  palette: {
    surfaceHue: 218, surfaceChroma: 'tinted',
    accentHue: 196, accentChroma: 'vivid',
    scheme: 'analogous', statusHueShift: 0,
  },
  surface: { lightAnchor: 'paper', darkAnchor: 'deep', step: 5, contrastTarget: 'aa' },
  type: {
    sansFamily: 'grotesk', displayFamily: 'grotesk', monoFamily: 'mono',
    scale: 'default', displayWeight: 'medium', letterSpacing: 'normal',
    lineHeight: 'default', measure: 'default',
  },
  density: 'default',
  motion: 'calm',
  surfaces: {
    default: {
      // (1) Translucency. Two layers: a diagonal wash of light over a
      // half-opaque body, so the pane has depth rather than a flat tint.
      fill: [
        { kind: 'linear', angle: 160, stops: [
          { color: { role: 'light', tier: 6, alpha: 0.24 }, position: 0 },
          { color: { role: 'light', tier: 1, alpha: 0.1 }, position: 55 },
          { color: { role: 'shadow', tier: 2, alpha: 0.12 }, position: 100 },
        ] },
        { kind: 'solid', stops: [{ color: { role: 'light', tier: 1, alpha: 0.55 } }] },
      ],
      // (3) The specular ring: bright at the top-left, shadowed at the
      // bottom-right, painted into the border as a gradient.
      border: {
        width: 1,
        variant: 'gradient-ring',
        ring: { angle: 145, stops: [
          { color: { role: 'light', tier: 12, alpha: 0.75 }, position: 0 },
          { color: { role: 'light', tier: 6, alpha: 0.12 }, position: 40 },
          { color: { role: 'shadow', tier: 4, alpha: 0.35 }, position: 100 },
        ] },
      },
      corner: { radius: 18, shape: 'squircle' },
      // (4) A tight contact shadow under a wide ambient one, with an inset
      // highlight on top so the upper edge catches light.
      shadows: [
        { inset: true, y: 1, blur: 1, color: { role: 'light', tier: 12 }, alpha: 0.4 },
        { y: 2, blur: 8, color: { role: 'shadow', tier: 6 }, alpha: 0.14 },
        { y: 18, blur: 42, spread: -12, color: { role: 'shadow', tier: 8 }, alpha: 0.28 },
      ],
      // (2) Blur plus saturation. Saturation is the number that matters.
      backdrop: { blur: 20, saturate: 1.8, brightness: 1.02, refraction: 0.55 },
      texture: { kind: 'grain', opacity: 0.05, scale: 1, blend: 'overlay' },
      overlay: { kind: 'sheen', angle: 145, strength: 0.14 },
    },
    popover: {
      backdrop: { blur: 30, saturate: 2, refraction: 0.7 },
      shadows: [
        { inset: true, y: 1, blur: 1, color: { role: 'light', tier: 12 }, alpha: 0.5 },
        { y: 24, blur: 60, spread: -16, color: { role: 'shadow', tier: 9 }, alpha: 0.36 },
      ],
    },
  },
});

test('glass composes from primitives, with no preset behind it', () => {
  const surface = deriveTokens(GLASS).light.surfaces.default;

  // (1) Translucent fill. The bottom layer carries alpha, so it is *not*
  // collapsed into an opaque `--t-fill-color` the way an opaque solid would be
  // — the whole stack stays in `--t-fill-image` and the element paints no
  // background colour of its own, which is what leaves a backdrop to filter.
  assert.equal(surface['t-fill-color'], 'transparent', 'a translucent pane must not emit an opaque fill colour');
  assert.match(surface['t-fill-image'], /hsl\([^)]+\/\s*0\.55\)/, 'the authored 0.55 alpha must survive into the fill');

  // (2) Backdrop blur *and* saturation. Saturation is the term that separates
  // glass from fog and the one most likely to be quietly dropped.
  assert.match(surface['t-backdrop'], /blur\(/, 'glass needs a backdrop blur');
  assert.match(surface['t-backdrop'], /saturate\(1\.8\)/, 'glass needs backdrop saturation, not just blur');

  // (3) The specular ring. It rides as the last background layer clipped to the
  // border box, with the border colour transparent, because `border-image`
  // squares off the corners of a squircle and a masked pseudo-element cannot
  // inherit `corner-shape`.
  assert.equal(surface['t-border-color'], 'transparent', 'a gradient ring replaces the flat border colour');
  assert.match(surface['t-fill-clip'], /border-box$/, 'the ring layer must clip to the border box');
  // Counted off `--t-fill-blend`, whose values are bare keywords, because
  // splitting `--t-fill-image` on commas would count gradient stops as layers.
  const layers = surface['t-fill-blend'].split(', ').length;
  assert.equal(layers, 3, 'two authored fill layers plus the ring');
  assert.equal(surface['t-fill-clip'].split(', ').length, layers);
  assert.equal(surface['t-fill-origin'].split(', ').length, layers);

  // (4) A soft ambient shadow: something with a large blur, not just the tight
  // contact shadow that any raised card has.
  // Every length in the stack, not every other one: a pattern that consumes
  // the following offset as well skips alternate matches, and the widest blur
  // is exactly the one that lands in a skipped slot.
  const blurs = [...surface['t-shadow'].matchAll(/(\d+(?:\.\d+)?)px/g)]
    .map((match) => Number(match[1]));
  assert.ok(
    blurs.some((blur) => blur >= 24),
    `glass needs a wide ambient shadow; the widest blur emitted was ${Math.max(0, ...blurs)}px`,
  );

  // Refraction is folded into the two tokens that already exist rather than
  // emitting one of its own: a contrast lift in the filter chain and an inset
  // specular rim prepended to the shadow stack.
  assert.match(surface['t-backdrop'], /contrast\(/);
  assert.match(surface['t-shadow'], /^inset /);
  assert.equal(surface['t-ring-image'], undefined, 'the ring must not also be published as a token of its own');
  assert.equal(surface['t-refraction'], undefined);
});

test('a glass popover blurs harder than the page it floats over', () => {
  // Per-surface recipes are the reason glass is composable at all: one blur for
  // the whole app is the v1 vocabulary, and it cannot express a pane above a
  // pane.
  const surfaces = deriveTokens(GLASS).light.surfaces;
  assert.notEqual(surfaces.popover['t-backdrop'], surfaces.default['t-backdrop']);
  assert.match(surfaces.popover['t-backdrop'], /saturate\(2\)/);
});

test('the composed glass stylesheet names no remote resource', () => {
  // The grain texture is an app-owned data URI. Every url() the generator
  // itself writes must be one, or the derivation is making exactly the request
  // the freeform validator exists to stop.
  const css = serializeStylesheet(deriveTokens(GLASS));
  assert.match(css, /--t-texture-image: url\("data:image\/svg\+xml,/);
  assert.doesNotMatch(css, /url\("(?!data:)/);
});
