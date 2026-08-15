import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTRAST_PAIRS,
  contrastRatio,
  deriveTokens,
  pairMinimum,
  relativeLuminance,
  type DerivedTheme,
  type Hsl,
} from '@/modules/appearance/derive.js';
import { SURFACE_ANCHOR_NAMES, type ContrastTarget } from '@/modules/appearance/palette.js';
import { THEME_PRESETS } from '@/modules/appearance/presets.js';
import { serializeStylesheet } from '@/modules/appearance/serialize.js';
import { SURFACE_PARTS } from '@/modules/appearance/surface-recipe.js';
import {
  themeSpecSchema,
  themeSpecV2Schema,
  upgradeSpec,
  type ThemeSpecV2,
} from '@/modules/appearance/theme-spec.js';

const baseSpec = (overrides: Partial<ThemeSpecV2> = {}): ThemeSpecV2 =>
  themeSpecV2Schema.parse({ ...THEME_PRESETS.paper, ...overrides });

/** Asserts every enforced pair in a ramp clears the floor for its target. */
const assertRampPasses = (colors: Record<string, Hsl>, target: ContrastTarget, label: string) => {
  for (const pair of CONTRAST_PAIRS) {
    const foreground = colors[pair.foreground];
    const background = colors[pair.background];
    assert.ok(foreground && background, `${label}: missing ${pair.foreground}/${pair.background}`);

    const minimum = pairMinimum(pair, target);
    const ratio = contrastRatio(foreground, background);
    assert.ok(
      ratio >= minimum,
      `${label}: ${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`,
    );
  }
};

/**
 * Asserts no surface ended up below the AA floor.
 *
 * The derivation reports `surfaces.<part>.fill` precisely when a surface's own
 * fill leaves no colour that reads at 4.5:1 on it, so checking the report
 * checks every part in both ramps in one assertion — and it checks the thing
 * the model is told about rather than a parallel reimplementation of it.
 *
 * `surfaces.<part>.ink.target` is deliberately *not* asserted against: missing
 * a self-imposed AAA on a 40%-opaque scrim is the author asking for something
 * their own fill cannot give, which is reported and allowed. AA is the promise.
 */
const assertEverySurfaceLegible = (derived: DerivedTheme, label: string) => {
  const failures = derived.adjusted.filter((entry) => entry.endsWith('.fill'));
  assert.deepEqual(failures, [], `${label}: surfaces below the AA floor: ${failures.join(', ')}`);
};

const assertSpecPasses = (spec: ThemeSpecV2, label: string) => {
  const target = spec.surface.contrastTarget;
  const derived = deriveTokens(spec);
  assertRampPasses(derived.light.colors, target, `${label} light`);
  if (derived.dark) assertRampPasses(derived.dark.colors, target, `${label} dark`);
  assertEverySurfaceLegible(derived, label);
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
    assert.equal(preset.specVersion, 2, `preset "${id}" must be a v2 spec`);
  }
});

test('every shipped preset passes contrast in both ramps at its own target', () => {
  for (const [id, preset] of Object.entries(THEME_PRESETS)) {
    assertSpecPasses(preset, id);

    // Presets are the worked examples, so they are held to the harder bar: they
    // must actually meet the target they ask for, on every surface, rather than
    // merely clearing AA and reporting a shortfall. A preset that asks for AAA
    // and misses it teaches the model that the target is decorative.
    const missed = deriveTokens(preset).adjusted.filter((entry) => entry.endsWith('.ink.target'));
    assert.deepEqual(missed, [], `${id}: surfaces below the preset's own contrast target`);
  }
});

test('the presets differ structurally, not just in hue', () => {
  // The presets are the model's worked examples. If they are all the same shape
  // in different colours, that is what the model learns a theme is.
  const shapes = Object.entries(THEME_PRESETS).map(([id, preset]) => {
    const surface = deriveTokens(preset).light.surfaces.default;
    return {
      id,
      signature: [
        surface['t-shadow'].split('),').length,
        surface['t-corner-shape'],
        surface['t-radius'],
        surface['t-border-width'],
        surface['t-backdrop'] === 'none' ? 'opaque' : 'backdrop',
        surface['t-texture-image'] === 'none' ? 'plain' : 'textured',
      ].join('/'),
    };
  });

  const unique = new Set(shapes.map((entry) => entry.signature));
  assert.equal(
    unique.size,
    shapes.length,
    `presets share a structural signature: ${JSON.stringify(shapes, null, 1)}`,
  );
});

test('every emitted surface carries the complete token set', () => {
  // v1's central defect was validating fields it then dropped. This asserts the
  // opposite property directly: every part, in every ramp, defines every token,
  // with a usable value rather than an empty string.
  const expected = Object.keys(deriveTokens(THEME_PRESETS.paper).light.surfaces.default);
  assert.ok(expected.length >= 20, 'the surface token set looks suspiciously small');

  for (const [id, preset] of Object.entries(THEME_PRESETS)) {
    const derived = deriveTokens(preset);
    for (const ramp of [derived.light, derived.dark]) {
      if (!ramp) continue;
      for (const part of SURFACE_PARTS) {
        const tokens = ramp.surfaces[part];
        assert.ok(tokens, `${id}: part "${part}" emitted no tokens`);
        for (const name of expected) {
          assert.ok(
            typeof tokens[name] === 'string' && tokens[name].trim() !== '',
            `${id}/${part}: token --${name} is missing or empty`,
          );
        }
      }
    }
  }
});

test('a texture selection reaches the stylesheet as an app-owned image', () => {
  const css = serializeStylesheet(deriveTokens(THEME_PRESETS.paper));
  assert.match(css, /--t-texture-image: url\("data:image\/svg\+xml,/);
  // Every url() the app itself writes must be a data URI. A remote one would
  // mean the generator is making the request the freeform validator exists to
  // stop. Only the quoted, top-level form is checked: the unquoted `url(%23n)`
  // inside an encoded SVG is a fragment reference within that document.
  for (const match of css.matchAll(/url\("([^"]*)"\)/g)) {
    assert.ok(match[1].startsWith('data:'), `generated css references ${match[1]}`);
  }
  assert.doesNotMatch(css, /url\("(?!data:)/);
});

test('texture and overlay strength is baked in, not left to an opacity token', () => {
  const surfaces = deriveTokens(THEME_PRESETS.paper).light.surfaces;
  // The renderer paints texture and overlay as two background layers on one
  // pseudo-element, where a per-layer opacity does not exist. The presence flag
  // must stay 0/1 so applying it can never square the strength.
  assert.equal(surfaces.default['t-texture-opacity'], '1');
  assert.equal(surfaces.default['t-overlay-opacity'], '1');
  assert.match(surfaces.default['t-texture-image'], /opacity=%220\.055%22/);
  assert.equal(surfaces.code['t-texture-opacity'], '0');
  assert.equal(surfaces.code['t-texture-image'], 'none');
});

// The gradient ring used to be asserted against the `liquidGlass` preset, which
// no longer exists — deliberately, since a shipped glass preset is what let the
// engine be tested with the answer written into the question. The same
// construction is now proved in `glass-composition.test.ts`, against a spec
// built out of primitives.

test('an ambient recipe emits a moving layer and the keyframes it references', () => {
  // The primitive that was missing entirely: "drifting clouds behind the chat"
  // had no word in the spec, so it was reachable only through hand-written CSS.
  const spec = baseSpec({
    surfaces: { default: { ambient: { kind: 'clouds', strength: 0.16, speed: 90, hue: 320 } } },
  });
  const surface = deriveTokens(spec).light.surfaces.default;

  assert.match(surface['t-ambient-image'], /radial-gradient/);
  assert.match(surface['t-ambient-animation'], /^t-ambient-clouds /);
  // Speed rides a `calc()` against an undeclared property so a published
  // control can retime every ambient layer in the app with one `:root` write.
  assert.match(surface['t-ambient-animation'], /var\(--t-ambient-speed, 1\)/);

  const css = serializeStylesheet(deriveTokens(spec));
  assert.match(css, /@keyframes t-ambient-clouds/);

  // A theme with no ambience carries no keyframes: they are app-owned
  // constants, and four unused blocks in every stylesheet is noise in the one
  // artefact a human reads when a theme looks wrong.
  assert.doesNotMatch(serializeStylesheet(deriveTokens(THEME_PRESETS.paper)), /@keyframes/);
});

test('caret, selection and pointer are themed rather than left to the browser', () => {
  const spec = baseSpec({
    interaction: {
      caretColor: { role: 'accent' },
      caretShape: 'block',
      selectionFill: { role: 'accent', alpha: 0.35 },
      cursor: 'auto',
    },
  });
  const css = serializeStylesheet(deriveTokens(spec));

  assert.match(css, /--t-caret-shape: block;/);
  assert.match(css, /--t-caret-color: hsl\(/);
  assert.match(css, /--t-selection-fill: hsl\([^)]+\/ 0\.35\);/);
  // Selected text keeps its own colour unless the theme says otherwise: a
  // translucent fill leaves the glyph readable, and forcing a colour there is
  // how a selection ends up less legible than the text it highlights.
  assert.match(css, /--t-selection-ink: currentColor;/);
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
  for (const preset of Object.values(THEME_PRESETS)) {
    assert.equal(
      serializeStylesheet(deriveTokens(preset)),
      serializeStylesheet(deriveTokens(preset)),
      `${preset.name} derived differently on a second run`,
    );
    assert.deepEqual(deriveTokens(preset), deriveTokens(preset));
  }
});

test('derivation does not mutate the spec it was given', () => {
  // The presets are module constants shared by every request; a derivation that
  // wrote back into one would poison every later theme in the process.
  const before = JSON.stringify(THEME_PRESETS.bloom);
  deriveTokens(THEME_PRESETS.bloom);
  assert.equal(JSON.stringify(THEME_PRESETS.bloom), before);
});

test('no authored hue or chroma combination can break contrast', () => {
  const chromas = ['neutral', 'tinted', 'rich'] as const;
  const accents = ['muted', 'vivid', 'electric'] as const;

  for (let hue = 0; hue < 360; hue += 30) {
    for (const surfaceChroma of chromas) {
      for (const accentChroma of accents) {
        assertSpecPasses(baseSpec({
          palette: {
            surfaceHue: hue,
            surfaceChroma,
            accentHue: (hue + 180) % 360,
            accentChroma,
            scheme: 'complement',
            statusHueShift: 0,
          },
        }), `hue ${hue} ${surfaceChroma}/${accentChroma}`);
      }
    }
  }
});

test('no anchor and target combination can break contrast', () => {
  // The claim the fixed lightness table used to make by refusing to let anyone
  // choose. Now every reachable surface position, in both ramps, at every
  // target, has to survive being solved.
  const targets = ['aa', 'aaa', 'max'] as const;

  for (const lightAnchor of SURFACE_ANCHOR_NAMES) {
    for (const darkAnchor of SURFACE_ANCHOR_NAMES) {
      for (const contrastTarget of targets) {
        assertSpecPasses(baseSpec({
          surface: { lightAnchor, darkAnchor, step: 6, contrastTarget },
        }), `${lightAnchor}/${darkAnchor} @ ${contrastTarget}`);
      }
    }
  }
});

test('no step size can collapse the ladder', () => {
  for (let step = 2; step <= 14; step += 1) {
    assertSpecPasses(baseSpec({
      surface: { lightAnchor: 'mid', darkAnchor: 'true-black', step, contrastTarget: 'aa' },
    }), `step ${step}`);
  }
});

test('a true-black anchor reaches true black, and a paper one does not', () => {
  const oled = deriveTokens(baseSpec({
    mode: 'dark',
    surface: { lightAnchor: 'paper', darkAnchor: 'true-black', step: 6, contrastTarget: 'aa' },
  }));
  assert.equal(oled.light.colors.background.l, 0, 'true-black must actually be 0% lightness');

  const paper = deriveTokens(baseSpec({ mode: 'light' }));
  assert.ok(paper.light.colors.background.l > 90, 'a paper anchor must stay near white');
});

test('an unreachable target moves the anchor and says so', () => {
  // Mid-grey cannot carry 11:1 text. The old engine could not express the
  // request at all; the new one grants what it can and reports the correction
  // as a dotted path the model can act on.
  const derived = deriveTokens(baseSpec({
    mode: 'light',
    surface: { lightAnchor: 'mid', darkAnchor: 'near-black', step: 6, contrastTarget: 'max' },
  }));

  assert.ok(
    derived.adjusted.includes('surface.lightAnchor'),
    `expected the anchor correction to be reported, got ${JSON.stringify(derived.adjusted)}`,
  );
  assertRampPasses(derived.light.colors, 'max', 'mid @ max');
});

test('a mid anchor takes dark ink in the light ramp and light ink in the dark ramp', () => {
  const derived = deriveTokens(baseSpec({
    mode: 'adaptive',
    surface: { lightAnchor: 'mid', darkAnchor: 'mid', step: 5, contrastTarget: 'aa' },
  }));

  assert.ok(
    derived.light.colors.foreground.l < derived.light.colors.background.l,
    'mid-grey newsprint takes dark ink',
  );
  assert.ok(
    (derived.dark?.colors.foreground.l ?? 0) > (derived.dark?.colors.background.l ?? 100),
    'mid-grey charcoal takes light ink',
  );
});

test('an accent-filled surface gets ink from whichever pole works', () => {
  // The failure this catches: in a dark theme the ladder runs toward white, and
  // white on a bright accent button is about 2:1. The ink solver has to be able
  // to leave the ladder.
  const derived = deriveTokens(THEME_PRESETS.brutalist);
  for (const ramp of [derived.light, derived.dark]) {
    if (!ramp) continue;
    assert.notEqual(ramp.surfaces.button['t-ink'], ramp.surfaces.button['t-fill-color']);
  }
  assertEverySurfaceLegible(derived, 'brutalist');
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

  assert.equal(
    themeSpecSchema.safeParse({
      ...THEME_PRESETS.paper,
      surfaces: { nosuchpart: {} },
    }).success,
    false,
    'a surface name the renderer does not set must be an error, not a silent no-op',
  );
});

test('malformed recipes report the failing field, not the whole union', () => {
  const result = themeSpecV2Schema.safeParse({
    ...THEME_PRESETS.paper,
    surfaces: { card: { shadows: [{ blur: 4 }] } },
  });

  assert.equal(result.success, false);
  const paths = result.error?.issues.map((issue) => issue.path.join('.')) ?? [];
  assert.ok(
    paths.some((path) => path === 'surfaces.card.shadows.0.color'),
    `expected a path to the missing shadow colour, got ${JSON.stringify(paths)}`,
  );
});

test('a solid fill with several stops is rejected rather than truncated', () => {
  const result = themeSpecV2Schema.safeParse({
    ...THEME_PRESETS.paper,
    surfaces: {
      card: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface' } }, { color: { role: 'accent' } }] }],
      },
    },
  });

  assert.equal(result.success, false);
  assert.ok(
    result.error?.issues.some((issue) => issue.path.join('.') === 'surfaces.card.fill.0.stops'),
  );
});

test('a gradient ring without a gradient is rejected', () => {
  const result = themeSpecV2Schema.safeParse({
    ...THEME_PRESETS.paper,
    surfaces: { card: { border: { variant: 'gradient-ring' } } },
  });

  assert.equal(result.success, false);
  assert.ok(
    result.error?.issues.some((issue) => issue.path.join('.') === 'surfaces.card.border.ring'),
  );
});

test('a named surface inherits from default field by field', () => {
  const spec = baseSpec({
    surfaces: {
      default: { border: { width: 4, color: { role: 'accent' } }, corner: { radius: 20 } },
      // Only the width is restated; the colour and the radius must survive.
      card: { border: { width: 1 } },
    },
  });

  const surfaces = deriveTokens(spec).light.surfaces;
  assert.equal(surfaces.card['t-border-width'], '1px 1px 1px 1px');
  assert.equal(surfaces.card['t-border-color'], surfaces.default['t-border-color']);
  assert.equal(surfaces.card['t-radius'], '20px');
});

test('serialized css uses real selectors, never inline style declarations', () => {
  const css = serializeStylesheet(deriveTokens(baseSpec({ mode: 'adaptive' })));

  assert.match(css, /^:root \{/m);
  assert.match(css, /^\.dark \{/m);
  assert.match(css, /^\[data-tails-part="card"\] \{/m);
  assert.match(css, /^\.dark \[data-tails-part="card"\] \{/m);
  assert.match(css, /^\[data-tails-surface="raised"\] \{/m);
  assert.match(css, /--background: [\d.]+ [\d.]+% [\d.]+%;/);
  // Tailwind composes `hsl(var(--x) / alpha)`, which only works if the role
  // token holds bare components rather than a wrapped hsl() call.
  assert.doesNotMatch(css, /--(background|foreground|primary|border): hsl\(/);
});

test('every part in the contract gets its own scoped rule', () => {
  const css = serializeStylesheet(deriveTokens(THEME_PRESETS.neon));
  for (const part of SURFACE_PARTS) {
    if (part === 'default') continue;
    assert.ok(
      css.includes(`[data-tails-part="${part}"] {`),
      `no rule emitted for data-tails-part="${part}"`,
    );
  }
});

test('motion feel reaches the emitted duration tokens', () => {
  const instant = deriveTokens(baseSpec({ motion: 'instant' }));
  const calm = deriveTokens(baseSpec({ motion: 'calm' }));

  const instantSettle = Number.parseInt(instant.light.durations['duration-settle'], 10);
  const calmSettle = Number.parseInt(calm.light.durations['duration-settle'], 10);

  assert.ok(instantSettle < calmSettle, 'an instant theme must move faster than a calm one');
});

test('the type and density knobs all reach a token', () => {
  // Each of these was emitted by v1 and consumed by nobody. The contract now
  // names a consumer for every one, so the test that they still move is the
  // test that the contract is not quietly rotting.
  const compact = deriveTokens(baseSpec({
    type: { ...THEME_PRESETS.paper.type, scale: 'compact', letterSpacing: 'wide', displayWeight: 'black', lineHeight: 'tight', measure: 'narrow' },
    density: 'tight',
  })).light.lengths;
  const spacious = deriveTokens(baseSpec({
    type: { ...THEME_PRESETS.paper.type, scale: 'spacious', letterSpacing: 'tight', displayWeight: 'regular', lineHeight: 'loose', measure: 'full' },
    density: 'airy',
  })).light.lengths;

  for (const token of ['font-size-base', 'letter-spacing-base', 'display-weight', 'line-height-base', 'measure', 'space-unit']) {
    assert.notEqual(compact[token], spacious[token], `--${token} does not follow the spec`);
  }
});

test('the ink glow knob emits a text shadow only when asked for', () => {
  assert.notEqual(deriveTokens(THEME_PRESETS.terminal).light.surfaces.default['t-ink-shadow'], 'none');
  assert.equal(deriveTokens(THEME_PRESETS.editorial).light.surfaces.default['t-ink-shadow'], 'none');
});

test('upgrading a v2 spec is the identity', () => {
  for (const preset of Object.values(THEME_PRESETS)) {
    assert.deepEqual(upgradeSpec(preset), preset);
  }
});
