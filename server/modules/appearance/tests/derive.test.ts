import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTRAST_PAIRS,
  contrastRatio,
  deriveTokens,
  relativeLuminance,
  type Hsl,
} from '@/modules/appearance/derive.js';
import { serializeStylesheet } from '@/modules/appearance/serialize.js';
import { THEME_PRESETS, themeSpecSchema, type ThemeSpec } from '@/modules/appearance/theme-spec.js';

const baseSpec = (overrides: Partial<ThemeSpec> = {}): ThemeSpec => ({
  ...THEME_PRESETS.paper,
  ...overrides,
});

/** Asserts every enforced pair in a ramp clears its floor. */
const assertRampPasses = (colors: Record<string, Hsl>, label: string) => {
  for (const pair of CONTRAST_PAIRS) {
    const foreground = colors[pair.foreground];
    const background = colors[pair.background];
    assert.ok(foreground && background, `${label}: missing ${pair.foreground}/${pair.background}`);

    const ratio = contrastRatio(foreground, background);
    assert.ok(
      ratio >= pair.minimum,
      `${label}: ${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}:1, needs ${pair.minimum}:1`,
    );
  }
};

test('relative luminance matches known anchors', () => {
  assert.equal(Math.round(relativeLuminance({ h: 0, s: 0, l: 100 })), 1);
  assert.equal(Math.round(relativeLuminance({ h: 0, s: 0, l: 0 })), 0);
  // Black on white is the maximum possible ratio.
  assert.equal(
    Math.round(contrastRatio({ h: 0, s: 0, l: 0 }, { h: 0, s: 0, l: 100 })),
    21,
  );
});

test('every shipped preset validates against the schema', () => {
  for (const [id, preset] of Object.entries(THEME_PRESETS)) {
    const result = themeSpecSchema.safeParse(preset);
    assert.ok(result.success, `preset "${id}" failed validation: ${JSON.stringify(result.error?.issues)}`);
  }
});

test('every shipped preset passes contrast in both ramps', () => {
  for (const [id, preset] of Object.entries(THEME_PRESETS)) {
    const derived = deriveTokens(preset);
    assertRampPasses(derived.light.colors, `${id} light`);
    if (derived.dark) assertRampPasses(derived.dark.colors, `${id} dark`);
  }
});

test('an adaptive theme produces both ramps and they differ', () => {
  const derived = deriveTokens(baseSpec({ mode: 'adaptive' }));
  assert.ok(derived.dark, 'adaptive themes must carry a dark ramp');
  assert.notEqual(
    derived.light.colors.background.l,
    derived.dark?.colors.background.l,
    'light and dark backgrounds must not be identical',
  );
});

test('a light-pinned theme carries no dark ramp', () => {
  const derived = deriveTokens(baseSpec({ mode: 'light' }));
  assert.equal(derived.dark, null);
});

test('derivation is deterministic', () => {
  const spec = baseSpec();
  assert.deepEqual(
    serializeStylesheet(deriveTokens(spec)),
    serializeStylesheet(deriveTokens(spec)),
  );
});

test('no authored hue or chroma combination can break contrast', () => {
  // The whole safety claim in one test: sweep the entire authored colour
  // surface and assert every result is still legible.
  const chromas = ['neutral', 'tinted', 'rich'] as const;
  const accents = ['muted', 'vivid', 'electric'] as const;

  for (let hue = 0; hue < 360; hue += 30) {
    for (const surfaceChroma of chromas) {
      for (const accentChroma of accents) {
        const spec = baseSpec({
          palette: {
            surfaceHue: hue,
            surfaceChroma,
            accentHue: (hue + 180) % 360,
            accentChroma,
            scheme: 'complement',
            statusHueShift: 0,
          },
        });
        const derived = deriveTokens(spec);
        assertRampPasses(derived.light.colors, `hue ${hue} ${surfaceChroma}/${accentChroma} light`);
        if (derived.dark) {
          assertRampPasses(derived.dark.colors, `hue ${hue} ${surfaceChroma}/${accentChroma} dark`);
        }
      }
    }
  }
});

test('status hues stay recognisable despite the allowed shift', () => {
  const derived = deriveTokens(baseSpec({
    palette: { ...THEME_PRESETS.bloom.palette, statusHueShift: 15 },
  }));

  // Danger must remain in the red band even at maximum shift — a pink danger
  // colour is an accessibility failure dressed as personalisation.
  const danger = derived.light.colors.destructive.h;
  assert.ok(danger <= 23 || danger >= 353, `destructive hue drifted to ${danger}`);

  const positive = derived.light.colors.positive.h;
  assert.ok(positive >= 130 && positive <= 160, `positive hue drifted to ${positive}`);
});

test('the schema rejects unknown fields and out-of-range values', () => {
  assert.equal(
    themeSpecSchema.safeParse({ ...THEME_PRESETS.paper, wallpaperUrl: 'https://x/y.png' }).success,
    false,
    'an invented field must be an error the model has to fix',
  );

  assert.equal(
    themeSpecSchema.safeParse({
      ...THEME_PRESETS.paper,
      palette: { ...THEME_PRESETS.paper.palette, surfaceHue: 400 },
    }).success,
    false,
  );

  assert.equal(
    themeSpecSchema.safeParse({
      ...THEME_PRESETS.paper,
      palette: { ...THEME_PRESETS.paper.palette, statusHueShift: 90 },
    }).success,
    false,
    'a large status hue shift must be rejected, not clamped',
  );
});

test('serialized css uses real selectors, never inline style declarations', () => {
  const css = serializeStylesheet(deriveTokens(baseSpec({ mode: 'adaptive' })));

  assert.match(css, /^:root \{/m);
  assert.match(css, /^\.dark \{/m);
  assert.match(css, /--background: [\d.]+ [\d.]+% [\d.]+%;/);
  // Tailwind composes `hsl(var(--x) / alpha)`, which only works if the token
  // holds bare components rather than a wrapped hsl() call.
  assert.doesNotMatch(css, /--[a-z-]+: hsl\(/);
});

test('motion feel reaches the emitted duration tokens', () => {
  const instant = deriveTokens(baseSpec({ motion: 'instant' }));
  const calm = deriveTokens(baseSpec({ motion: 'calm' }));

  const instantSettle = Number.parseInt(instant.light.durations['duration-settle'], 10);
  const calmSettle = Number.parseInt(calm.light.durations['duration-settle'], 10);

  assert.ok(instantSettle < calmSettle, 'an instant theme must move faster than a calm one');
});
