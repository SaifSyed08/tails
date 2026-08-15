import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appliesCleanly,
  EMPTY_APPEARANCE_STATE,
  reduceAppearance,
  serialiseAppearanceState,
  withControlValue,
  type AppearanceEvent,
} from '@/modules/appearance/layer-state.js';

/**
 * The invariant:
 *
 * > Applying appearance state X must produce a rendering indistinguishable from
 * > a fresh app that has only ever had X applied. No residue from anything
 * > applied before it.
 *
 * This is the test the texture bug was the first failure of, and it is written
 * to catch the *class* rather than the case. The user's report was that
 * changing preset left a background texture behind; the two before it were a
 * cursor glow that outlived its theme and a `.dark` class that outlived a
 * pinned theme. Three symptoms, one cause: appearance state accumulated across
 * layers and no operation cleared all of it.
 *
 * So rather than asserting "a texture does not survive", these assert that
 * *nothing* survives, over every ordering of every layer — including
 * combinations nobody has thought of yet, which is where the fourth instance
 * was going to come from.
 */

const themeEvent = (id: string, css: string, pinnedMode: 'light' | 'dark' | null = null): AppearanceEvent => ({
  layer: 'theme', themeId: id, name: id, css, pinnedMode,
});

const cssEvent = (css: string): AppearanceEvent => ({ layer: 'css', css });

const controlsEvent = (title: string, binds: string): AppearanceEvent => ({
  layer: 'controls',
  name: title,
  controls: [{ id: 'k', label: 'Knob', kind: 'slider', binds, value: 3, min: 0, max: 9, step: 1, unit: 'px' }],
});

const proposalEvent = (): AppearanceEvent => ({
  layer: 'proposal',
  variants: [{ label: 'Bolder', note: '', className: 't-proposal-0', name: 'A', summary: '', css: '.t-proposal-0{}' }],
});

/** A texture-bearing theme and a plain one: the user's actual report, in tokens. */
const TEXTURED = themeEvent('textured', ':root {\n  --t-texture-image: url("data:image/svg+xml,grain");\n}');
const PLAIN = themeEvent('plain', ':root {\n  --t-texture-image: none;\n}');

test('a texture does not survive a change of preset', () => {
  // The reported bug, kept as a named case so the report and the test can be
  // read against each other. The general version is below.
  const after = [TEXTURED, PLAIN].reduce(reduceAppearance, EMPTY_APPEARANCE_STATE);
  assert.doesNotMatch(after.themeCss, /grain/);
  assert.equal(
    serialiseAppearanceState(after),
    serialiseAppearanceState(reduceAppearance(EMPTY_APPEARANCE_STATE, PLAIN)),
  );
});

test('a freeform layer does not survive the next theme', () => {
  // The cursor-glow leak. It was fixed once in the service by having `unbind`
  // send a clear; this fixes it in the state machine, so it holds even if a
  // future caller forgets the clear — which is the difference between fixing
  // the case and fixing the class.
  const glow = cssEvent('body::after { background: radial-gradient(circle at var(--pointer-x) var(--pointer-y), red, transparent) }');
  const after = [TEXTURED, glow, PLAIN].reduce(reduceAppearance, EMPTY_APPEARANCE_STATE);

  assert.equal(after.freeformCss, '');
  assert.ok(appliesCleanly([TEXTURED, glow], PLAIN));
});

test('a pinned colour mode does not survive an adaptive theme', () => {
  const pinned = themeEvent('crt', ':root{}', 'dark');
  const adaptive = themeEvent('paper', ':root{}', null);

  const after = [pinned, adaptive].reduce(reduceAppearance, EMPTY_APPEARANCE_STATE);
  assert.equal(after.pinnedMode, null, 'an adaptive theme must hand the colour mode back to the user');
  assert.ok(appliesCleanly([pinned], adaptive));
});

test('dragged knobs do not survive the look they were published for', () => {
  const controls = controlsEvent('Glass', '--glass-blur');
  let state = [TEXTURED, controls].reduce(reduceAppearance, EMPTY_APPEARANCE_STATE);
  state = withControlValue(state, '--glass-blur', '40px');
  assert.deepEqual(state.controlValues, { '--glass-blur': '40px' });

  // A knob wired to a property the next stylesheet never reads is a slider that
  // moves and changes nothing, which is the defect the whole engine was rebuilt
  // to remove.
  const after = reduceAppearance(state, PLAIN);
  assert.deepEqual(after.controlValues, {});
  assert.deepEqual(after.controls, []);
  assert.equal(after.controlsTitle, '');
});

test('every ordering of every layer lands where a fresh app would', () => {
  // The general form, and the reason this file exists rather than three
  // regression tests. Any history at all, followed by a theme, must be
  // indistinguishable from that theme applied to a clean app.
  const layers: AppearanceEvent[] = [
    TEXTURED,
    cssEvent('.t-a { filter: blur(2px) }'),
    controlsEvent('Knobs', '--x'),
    proposalEvent(),
    themeEvent('pinned', ':root{}', 'dark'),
    cssEvent('.t-b { opacity: 0.2 }'),
  ];

  // Every subsequence, in order, as a history. 2^6 of them, which is cheap and
  // covers every combination of layers that could be live when a theme lands.
  for (let mask = 0; mask < 1 << layers.length; mask += 1) {
    const history = layers.filter((_, index) => (mask & (1 << index)) !== 0);
    assert.ok(
      appliesCleanly(history, PLAIN),
      `residue after: ${history.map((event) => `${event.layer}:${event.themeId ?? ''}`).join(' -> ')}`,
    );
  }
});

test('the reset event lands on the built-in floor exactly', () => {
  // `theme_reset` is a theme event carrying an empty stylesheet, so it goes
  // through the same reduction as every other theme rather than being a second
  // implementation of "clear everything" that can drift from the first.
  const reset: AppearanceEvent = { layer: 'theme', themeId: 'builtin', name: 'Default', css: '', pinnedMode: null };
  const history = [TEXTURED, cssEvent('.t-a{color:red}'), controlsEvent('K', '--x'), proposalEvent()];

  const after = [...history, reset].reduce(reduceAppearance, EMPTY_APPEARANCE_STATE);
  assert.equal(
    serialiseAppearanceState(after),
    serialiseAppearanceState(EMPTY_APPEARANCE_STATE),
    'reset must be byte-identical to an app that has never had a theme applied',
  );
});

test('layers that are not the theme compose rather than reset', () => {
  // The invariant is about the *theme* clearing everything under it, not about
  // every event clearing everything. A stylesheet layered after a theme, and
  // knobs published after that, have to survive each other or the feature does
  // not work at all.
  const state = [PLAIN, cssEvent('.t-a{color:red}'), controlsEvent('K', '--x')]
    .reduce(reduceAppearance, EMPTY_APPEARANCE_STATE);

  assert.equal(state.freeformCss, '.t-a{color:red}');
  assert.equal(state.controls.length, 1);
  assert.equal(state.themeId, 'plain');
});

test('an unknown layer is ignored rather than treated as a reset', () => {
  // Forward compatibility in the safe direction: a renderer that has not been
  // taught about a layer a newer server sends must leave the app alone, not
  // blank it.
  const state = reduceAppearance(
    reduceAppearance(EMPTY_APPEARANCE_STATE, PLAIN),
    { layer: 'something-new', css: 'whatever' },
  );
  assert.equal(state.themeId, 'plain');
});
