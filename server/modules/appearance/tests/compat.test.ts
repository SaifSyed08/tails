import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTRAST_PAIRS,
  contrastRatio,
  deriveTokens,
  pairMinimum,
  type DerivedTheme,
  type ThemeTokens,
} from '@/modules/appearance/derive.js';
import { serializeStylesheet } from '@/modules/appearance/serialize.js';
import { themeSpecSchema, upgradeSpec, type ThemeSpecV1 } from '@/modules/appearance/theme-spec.js';

/**
 * Forward compatibility, which is the whole reason both the spec and the derived
 * tokens are stored.
 *
 * Two separate promises are tested here, and they are easy to confuse. A v1
 * **spec** must still parse and still derive, so a theme the user saved a
 * release ago can be opened and edited. A v1 **token blob** must still render,
 * unchanged, so nothing the user saved silently restyles itself when the schema
 * grows. The first is about editing; the second is about not moving the
 * furniture while someone is sitting on it.
 */

const V1_SPEC: ThemeSpecV1 = {
  specVersion: 1,
  name: 'Legacy Neon',
  summary: 'A v1 spec exactly as it would have been written before surfaces existed.',
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
};

test('a v1 spec still parses', () => {
  const result = themeSpecSchema.safeParse(V1_SPEC);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
  assert.equal(result.success && result.data.specVersion, 1);
});

test('a v1 spec still derives, and still passes contrast', () => {
  const derived = deriveTokens(V1_SPEC);

  for (const [label, ramp] of [['light', derived.light], ['dark', derived.dark]] as const) {
    if (!ramp) continue;
    for (const pair of CONTRAST_PAIRS) {
      const ratio = contrastRatio(ramp.colors[pair.foreground], ramp.colors[pair.background]);
      const minimum = pairMinimum(pair, 'aa');
      assert.ok(
        ratio >= minimum,
        `v1 ${label}: ${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`,
      );
    }
  }
});

test('a v1 spec renders through the v2 surface pipeline', () => {
  // Not a separate code path: v1 is rewritten as the v2 spec that means the same
  // thing. A second derivation kept in contrast-correct lockstep with the first
  // forever is a promise nobody keeps.
  const css = serializeStylesheet(deriveTokens(V1_SPEC));
  assert.match(css, /^\[data-tails-part="card"\] \{/m);
  assert.match(css, /--t-fill-color:/);
});

test('upgrading gives v1 the tokens it always described but never emitted', () => {
  // v1's central defect: `elevation` and `surfaceTexture` were validated and
  // then dropped, so "glass floating" and "flat" produced identical CSS. There
  // was literally no glass to ask for.
  const upgraded = upgradeSpec(V1_SPEC);
  assert.equal(upgraded.specVersion, 2);

  const surfaces = deriveTokens(V1_SPEC).dark?.surfaces;
  assert.ok(surfaces);
  assert.notEqual(surfaces.default['t-shadow'], 'none', 'elevation "floating" must emit shadows');
  assert.notEqual(surfaces.default['t-backdrop'], 'none', 'surfaceTexture "glass" must emit a backdrop');
  assert.notEqual(surfaces.popover['t-backdrop'], surfaces.default['t-backdrop'], 'glass popovers blur harder');
  assert.equal(surfaces.default['t-radius'], '2px', 'radius "sharp" must survive the upgrade');
  assert.equal(surfaces.default['t-border-width'], '1.5px 1.5px 1.5px 1.5px', 'borderWeight "normal" must survive');
});

test('a flat v1 theme stays flat', () => {
  const flat = deriveTokens({
    ...V1_SPEC,
    shape: { radius: 'round', borderWeight: 'hairline', elevation: 'flat' },
    surfaceTexture: 'flat',
  });

  assert.equal(flat.light.surfaces.default['t-shadow'], 'none');
  assert.equal(flat.light.surfaces.default['t-backdrop'], 'none');
  assert.equal(flat.light.surfaces.default['t-radius'], '16px');
});

test('a cached v1 token blob still renders exactly as it did', () => {
  // What a `tokens_json` column written before v2 contains: colours, lengths,
  // fonts, durations and easings, and nothing else. The serializer must not
  // require the groups that did not exist yet.
  const legacyTokens = {
    colors: {
      background: { h: 240, s: 10, l: 6 },
      foreground: { h: 40, s: 15, l: 95 },
      border: { h: 240, s: 5, l: 40 },
    },
    lengths: { radius: '0.5rem', 'space-unit': '0.25rem' },
    fonts: { 'font-sans': 'system-ui, sans-serif' },
    durations: { 'duration-quick': '160ms' },
    easings: { 'ease-standard': 'cubic-bezier(0.4, 0, 0.2, 1)' },
  } as unknown as ThemeTokens;

  const legacyTheme: DerivedTheme = {
    light: legacyTokens,
    dark: legacyTokens,
    adjusted: [],
    minRatio: 12,
  };

  const css = serializeStylesheet(legacyTheme);

  assert.match(css, /^:root \{/m);
  assert.match(css, /^\.dark \{/m);
  assert.match(css, /--background: 240 10% 6%;/);
  assert.match(css, /--radius: 0\.5rem;/);
  // No surface rules, rather than empty ones: a v1 theme has no per-part look,
  // and inventing one would be exactly the silent restyle the token cache
  // exists to prevent.
  assert.doesNotMatch(css, /data-tails-part/);
  assert.doesNotMatch(css, /data-tails-surface/);
  assert.doesNotMatch(css, /--t-/);
});

test('the v1 to v2 upgrade is deterministic', () => {
  assert.deepEqual(upgradeSpec(V1_SPEC), upgradeSpec(V1_SPEC));
  assert.equal(
    serializeStylesheet(deriveTokens(V1_SPEC)),
    serializeStylesheet(deriveTokens(V1_SPEC)),
  );
});
