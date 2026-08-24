import assert from 'node:assert/strict';
import test from 'node:test';

import { LIMITS, readScene, SCENE_KINDS } from '@/modules/scene/scene-spec.js';
import { AppError } from '@/shared/utils.js';

function refuse(input: unknown): { path: string; message: string }[] {
  try {
    readScene(input);
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    return error.details as { path: string; message: string }[];
  }
  return assert.fail('expected the scene to be refused');
}

test('a named scene needs nothing but its name', () => {
  // Every parameter has a default, so "make it rain" is one word and a shape
  // that validates. A vocabulary you have to fill in completely is one a model
  // reaches for less.
  const scene = readScene({ layer: 'behind', scene: { kind: 'rain' } });
  assert.equal(scene.scene.kind, 'rain');
  assert.equal(scene.layer, 'behind');
});

test('every kind in the union is reachable', () => {
  // Guards the quiet failure: a kind offered to the model, described in the
  // tool schema, and refused by the validator.
  const samples: Record<string, { input: unknown; layer: 'behind' | 'corner' }> = {
    clouds: { input: { kind: 'clouds' }, layer: 'behind' },
    stars: { input: { kind: 'stars' }, layer: 'behind' },
    grid: { input: { kind: 'grid' }, layer: 'behind' },
    rain: { input: { kind: 'rain' }, layer: 'behind' },
    meadow: { input: { kind: 'meadow' }, layer: 'behind' },
    voxel: { input: { kind: 'voxel' }, layer: 'behind' },
    snake: { input: { kind: 'snake' }, layer: 'corner' },
    pong: { input: { kind: 'pong' }, layer: 'corner' },
    custom: { input: { kind: 'custom', title: 'A toy', html: '<b>hi</b>' }, layer: 'corner' },
  };

  for (const kind of SCENE_KINDS) {
    const sample = samples[kind];
    assert.ok(sample, `no sample for ${kind}`);
    assert.equal(readScene({ layer: sample.layer, scene: sample.input }).scene.kind, kind);
  }
});

test('a kind the app cannot draw is refused', () => {
  for (const kind of ['minecraft', 'threejs', 'iframe', 'video', '']) {
    assert.ok(refuse({ layer: 'behind', scene: { kind } }).length > 0, kind);
  }
});

test('a game behind the interface is refused, not quietly moved', () => {
  // It would be unclickable there, and a request silently relocated is a
  // request that was not honoured — the agent should learn which half it got
  // wrong rather than watch the app do something else.
  const issues = refuse({ layer: 'behind', scene: { kind: 'snake' } });
  assert.deepEqual(issues.map((issue) => issue.path), ['layer']);
  assert.match(issues[0].message, /corner/);
});

test('a sky in a corner card is refused too', () => {
  const issues = refuse({ layer: 'corner', scene: { kind: 'clouds' } });
  assert.deepEqual(issues.map((issue) => issue.path), ['layer']);
  assert.match(issues[0].message, /behind/);
});

test('custom scenes go either way, because they can be either thing', () => {
  const html = '<canvas id="c"></canvas>';
  assert.equal(readScene({ layer: 'behind', scene: { kind: 'custom', title: 'Stars', html } }).layer, 'behind');
  assert.equal(readScene({ layer: 'corner', scene: { kind: 'custom', title: 'Toy', html } }).layer, 'corner');
});

test('a custom scene has to say what it is', () => {
  // The frame is labelled, so a sandboxed page can never be mistaken for the
  // app's own UI. A blank title would defeat that.
  assert.ok(refuse({ layer: 'corner', scene: { kind: 'custom', title: '', html: 'x' } }).length > 0);
});

test('an enormous page is refused rather than truncated', () => {
  // Half a document is not a smaller document; it is a broken one, and it would
  // render as a blank frame with no explanation anywhere.
  const issues = refuse({
    layer: 'corner',
    scene: { kind: 'custom', title: 'Big', html: 'x'.repeat(LIMITS.customHtml + 1) },
  });
  assert.deepEqual(issues.map((issue) => issue.path), ['scene.html']);
});

test('an empty page is refused', () => {
  assert.ok(refuse({ layer: 'corner', scene: { kind: 'custom', title: 'Nothing', html: '' } }).length > 0);
});

test('markup in a custom scene is left exactly as written', () => {
  // Nothing here sanitises, and that is the design rather than an oversight:
  // the sandbox is the boundary, and a validator that also policed what the
  // code meant would be a second, weaker boundary that eventually disagrees
  // with the real one. See the renderer for what makes the frame safe.
  const html = '<script>document.body.innerHTML = "<b>hi</b>"</script>';
  const scene = readScene({ layer: 'corner', scene: { kind: 'custom', title: 'Toy', html } });
  assert.equal(scene.scene.kind === 'custom' ? scene.scene.html : '', html);
});

test('a value outside a scene\'s vocabulary is refused', () => {
  assert.ok(refuse({ layer: 'behind', scene: { kind: 'clouds', speed: 'warp' } }).length > 0);
  assert.ok(refuse({ layer: 'behind', scene: { kind: 'clouds', palette: '#ff00ff' } }).length > 0);
  assert.ok(refuse({ layer: 'sideways', scene: { kind: 'clouds' } }).length > 0);
});
