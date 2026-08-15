import assert from 'node:assert/strict';
import test from 'node:test';

import { validateControls } from '@/modules/appearance/controls.js';

/**
 * The live-control contract.
 *
 * A control is a promise that dragging it changes something immediately. Two
 * ways that promise can be broken, and both are checked here: the value it
 * writes can be something CSS refuses (in which case the knob moves and nothing
 * happens), or it can be something CSS *accepts* that should never have been
 * allowed near the document — which for this system means `url()`, reached from
 * the one direction that never passes through the stylesheet validator.
 */

const slider = (overrides: Record<string, unknown> = {}) => ({
  id: 'glass.blur',
  label: 'Blur',
  kind: 'slider',
  binds: '--glass-blur',
  min: 0,
  max: 60,
  step: 1,
  unit: 'px',
  value: 20,
  ...overrides,
});

test('a well-formed control set is accepted with its defaults filled in', () => {
  const result = validateControls({
    controls: [
      slider(),
      { id: 'glass.ring', label: 'Ring', kind: 'toggle', binds: '--glass-ring', on: '1px', off: '0', value: true },
      { id: 'glass.tint', label: 'Tint', kind: 'colour', binds: '--glass-tint', value: '#88ccff' },
      {
        id: 'glass.corner',
        label: 'Corner',
        kind: 'select',
        binds: '--t-corner-shape',
        options: [{ label: 'Round', value: 'round' }, { label: 'Squircle', value: 'superellipse(4)' }],
        value: 'superellipse(4)',
      },
    ],
  });

  assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.issues, null, 1));
  assert.equal(result.ok && result.payload.title, 'Adjust');
  assert.equal(result.ok && result.payload.controls.length, 4);
});

test('ENFORCED: a control value cannot smuggle url() onto the document', () => {
  // Controls write custom properties straight onto :root at runtime, so nothing
  // in the stylesheet validator ever sees them. Checking them with the same
  // code is what keeps the url() ban whole rather than merely mostly true.
  for (const control of [
    { id: 'a', label: 'A', kind: 'colour', binds: '--a', value: 'url("https://example.test/x.png")' },
    { id: 'b', label: 'B', kind: 'toggle', binds: '--b', on: 'image-set("https://example.test/x.png" 1x)', off: 'none', value: true },
    {
      id: 'c',
      label: 'C',
      kind: 'select',
      binds: '--c',
      options: [{ label: 'Off', value: 'none' }, { label: 'On', value: 'url(https://example.test/y)' }],
      value: 'none',
    },
  ]) {
    const result = validateControls({ controls: [control] });
    assert.equal(result.ok, false, `${control.id}: expected a rejection`);
  }

  // The unit is part of the emitted value, so a unit that is not a unit is
  // caught at both ends of the range rather than at neither.
  assert.equal(validateControls({ controls: [slider({ unit: 'px);background:url(x' })] }).ok, false);
});

test('a control must bind a custom property, written in full', () => {
  for (const binds of ['glass-blur', '-glass-blur', '--', 'backdrop-filter', '--a b']) {
    assert.equal(
      validateControls({ controls: [slider({ binds })] }).ok,
      false,
      `${binds} should not be accepted as a binding`,
    );
  }
  assert.ok(validateControls({ controls: [slider({ binds: '--t-backdrop-scale' })] }).ok);
});

test('a control set that would open showing something untrue is rejected', () => {
  // Every one of these is a panel that lies about the look on screen, which is
  // worse than no panel: the user drags to "fix" a value that was never wrong.
  assert.equal(validateControls({ controls: [slider({ min: 60, max: 0 })] }).ok, false);
  assert.equal(validateControls({
    controls: [{
      id: 'x',
      label: 'X',
      kind: 'select',
      binds: '--x',
      options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
      value: 'c',
    }],
  }).ok, false);

  const duplicate = validateControls({ controls: [slider(), slider({ label: 'Blur again' })] });
  assert.equal(duplicate.ok, false);
  assert.ok(!duplicate.ok && duplicate.issues.some((issue) => issue.message.includes('share the id')));
});

test('an empty set is valid, because that is how the panel is removed', () => {
  const result = validateControls({ controls: [] });
  assert.ok(result.ok);
  assert.equal(result.ok && result.payload.controls.length, 0);
});

test('every problem is reported at once, with a path', () => {
  // Two controls, two independent faults, one response. A model that has to
  // discover its mistakes one round trip at a time never converges — the same
  // reason the stylesheet validator collects instead of throwing.
  const result = validateControls({
    controls: [
      { id: 'one', label: 'One', kind: 'colour', binds: '--one', value: 'url("https://example.test/a.png")' },
      { id: 'two', label: 'Two', kind: 'colour', binds: '--two', value: 'src("https://example.test/b.png")' },
    ],
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issues.length, 2);
  for (const issue of result.issues) assert.match(issue.path, /^controls\[\d+\]\./);
});
