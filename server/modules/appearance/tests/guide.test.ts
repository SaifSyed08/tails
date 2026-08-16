import assert from 'node:assert/strict';
import test from 'node:test';

import { APPEARANCE_ALLOWED_TOOLS } from '@/modules/appearance/appearance.tools.js';
import { deriveTokens } from '@/modules/appearance/derive.js';
import { APPEARANCE_GUIDE } from '@/modules/appearance/guide.js';
import { serializeStylesheet } from '@/modules/appearance/serialize.js';
import { AMBIENT_KINDS } from '@/modules/appearance/surface-recipe.js';
import {
  POINTER_KINDS,
  TRAIL_KINDS,
  themeSpecV2Schema,
} from '@/modules/appearance/theme-spec.js';

/**
 * The guide has to describe what the engine can actually do.
 *
 * This project has now shipped the same bug three times, in three different
 * disguises: `theme_css` was implemented and named nowhere the model would see
 * it; five typography tokens were derived, serialised and read by nobody; and
 * `data-tails-part` values existed that the renderer never set. Every one of
 * them is the same failure — a capability that exists and is not reachable,
 * because the half of the system that would have to know about it was never
 * told.
 *
 * `theme_list` returns `APPEARANCE_GUIDE`, and that string is now the only
 * channel through which several capabilities are discoverable at all. So it
 * gets a test, the same way the token contract does. A guide that silently
 * falls behind the schema is a fourth instance of the bug waiting to happen,
 * and the whole point of writing it down was to stop that.
 */

/** A spec with every optional group switched on, so nothing is missed by omission. */
const MAXIMAL = themeSpecV2Schema.parse({
  specVersion: 2,
  name: 'Everything',
  summary: 'A spec that exercises every group, so the guide check sees the whole vocabulary.',
  mode: 'adaptive',
  palette: {
    surfaceHue: 210, surfaceChroma: 'tinted',
    accentHue: 190, accentChroma: 'vivid',
    scheme: 'analogous', statusHueShift: 0,
  },
  type: {
    sansFamily: 'grotesk', displayFamily: 'grotesk', monoFamily: 'mono',
    scale: 'default', displayWeight: 'medium', letterSpacing: 'normal',
    lineHeight: 'default', measure: 'default',
  },
  density: 'default',
  motion: 'calm',
  interaction: {
    caretShape: 'block',
    cursor: 'auto',
    pointer: {
      kind: 'halo',
      size: 72,
      opacity: 0.4,
      blend: 'screen',
      replace: false,
      trail: { kind: 'comet', length: 10, size: 14, opacity: 0.4 },
    },
  },
  surfaces: {
    default: {
      backdrop: { blur: 20, saturate: 1.7 },
      ambient: { kind: 'clouds', strength: 0.14, speed: 80 },
    },
  },
});

test('every live-knob property the derivation emits is named in the guide', () => {
  // These are the invisible ones, and the reason this test matters most. A
  // custom property that the stylesheet *reads with a fallback* but never
  // *declares* is a knob that exists purely so a published control can bind it.
  // It appears in no schema, in no `.describe()`, and in no token table — so if
  // the guide does not name it, nothing does, and the capability may as well
  // not exist.
  const css = serializeStylesheet(deriveTokens(MAXIMAL));
  const knobs = new Set(
    [...css.matchAll(/var\((--t-[a-z0-9-]+)\s*,/g)].map((match) => match[1]),
  );

  assert.ok(knobs.size >= 3, 'expected the derivation to publish live knobs; the extraction is probably broken');

  const missing = [...knobs].filter((knob) => !APPEARANCE_GUIDE.includes(knob));
  assert.deepEqual(
    missing,
    [],
    'These properties are bindable by theme_controls and are documented nowhere else — not in the schema, not in a describe(). Add them to the table in guide.ts or the model will never publish a control for them.',
  );
});

test('every kind in the newest vocabulary groups is named in the guide', () => {
  // Enum values do reach the model through the schema's `.describe()` text, so
  // this is a lighter obligation than the one above — but ambient, pointer and
  // trail are *technique* as much as vocabulary, and the guide is where the
  // technique lives. A kind nobody mentions is a kind nobody picks.
  const named: [string, readonly string[]][] = [
    ['ambient', AMBIENT_KINDS],
    ['pointer', POINTER_KINDS],
    ['trail', TRAIL_KINDS],
  ];

  for (const [group, kinds] of named) {
    // `none` and `system` are the off switches; the guide describes them in
    // prose rather than by name, and asserting on them would be asserting on a
    // word rather than on a capability.
    const missing = kinds
      .filter((kind) => kind !== 'none' && kind !== 'system')
      .filter((kind) => !APPEARANCE_GUIDE.includes(`\`${kind}\``));

    assert.deepEqual(missing, [], `${group} kinds missing from guide.ts`);
  }
});

test('every capability that exists only in the guide is named there', () => {
  // The narrow version of the same obligation. These have no `.describe()` a
  // model reads in passing and no token table listing them — a spec field it is
  // never told about is a spec field it never uses, which is this project's
  // recurring bug in its purest form. `pixels` is the newest instance: it was
  // added *because* "make it look like Minecraft" had no primitive behind it,
  // and a texture channel nobody mentions would have reproduced the failure it
  // was built to fix.
  const capabilities: [string, string][] = [
    ['pixels', 'the model-authored texture grid'],
    ['chroma', 'the saturation multiplier on a colour reference'],
    ['palette', 'the colour list a pixel tile indexes into'],
    ['grid', 'the pixel tile itself'],
    ['pixel', 'the hard-edged square trail'],
    ['minesweeper', 'the beveled click grid'],
    ['--t-trail-radius', 'the token that squares a trail segment off'],
  ];

  const missing = capabilities
    .filter(([token]) => !APPEARANCE_GUIDE.includes(`\`${token}\``))
    .map(([token, what]) => `${token} (${what})`);

  assert.deepEqual(missing, [], 'These are reachable in the schema and documented nowhere the model reads.');
});

test('the guide states that the proposal step is enforced, not advised', () => {
  // It was advice, and it was ignored: "make it look like Minecraft" went
  // straight to applying. Now `theme_apply` refuses a structural change with no
  // proposal behind it, and the guide has to say so — a rule the model
  // discovers by hitting it wastes a turn every time.
  assert.match(APPEARANCE_GUIDE, /enforced, not\s+advised/);
  assert.ok(
    APPEARANCE_GUIDE.includes('named style is always substantial'),
    'the guide must say that a named style — Minecraft, an era, a brand — always needs a proposal.',
  );
});

test('every tool the agent may call is named in the guide', () => {
  const missing = APPEARANCE_ALLOWED_TOOLS
    .map((tool) => tool.replace('mcp__tails-appearance__', ''))
    // `theme_list` is the tool that *returns* the guide, so it naming itself
    // would be noise rather than guidance.
    .filter((tool) => tool !== 'theme_list')
    .filter((tool) => !APPEARANCE_GUIDE.includes(tool));

  assert.deepEqual(missing, [], 'A tool the model may call without asking, that the guide never mentions, is the theme_css mistake again.');
});

test('the guide states the rules that are actually enforced, and only those', () => {
  // The validator gave up almost everything it used to check. If the guide
  // still describes the old walls, the model designs around restrictions that
  // no longer exist — which is the same lost capability as an undocumented
  // feature, arriving from the other direction.
  for (const enforced of ['url()', 'data-tails-critical', 'content']) {
    assert.ok(APPEARANCE_GUIDE.includes(enforced), `the guide must state that ${enforced} is refused`);
  }

  for (const removed of ['opacity floor', 'property allowlist', 'rooted', 'z-index cap']) {
    assert.ok(
      !APPEARANCE_GUIDE.includes(removed),
      `the guide still describes "${removed}" as a rule; it is guidance now, and describing it as a wall costs the looks it used to block.`,
    );
  }
});
