import assert from 'node:assert/strict';
import test from 'node:test';

// Shell code, reached by path: it imports nothing, and this is the repo's only
// test runner. Same arrangement as `pet-motion.test.ts`.
import { clientPointToDip } from '../../../../electron/pet-geometry.js';

/**
 * The one conversion between the app's coordinates and the screen's.
 *
 * Tested because its failure mode is invisible at the only zoom most people
 * ever use. At 1.0 the scale term disappears and every wrong version of this
 * function looks right; the bug it exists to prevent only appears once someone
 * has pressed Ctrl+= , and then it grows with distance rather than announcing
 * itself. The numbers below were measured from a real window: a 900x600 window
 * at (119, 89) has content bounds at (127, 145) — an invisible frame 8 across
 * and 56 down — and `contentWidth / innerWidth` came back as the zoom factor at
 * 1.0, 1.25, 1.5 and 0.8.
 */

const CONTENT_ORIGIN = { x: 127, y: 145 };

test('at zoom 1 the conversion is the content origin plus the point', () => {
  const point = clientPointToDip(CONTENT_ORIGIN, 1, 400, 300);
  assert.deepEqual(point, { x: 527, y: 445 });
});

test('zoom scales the offset, not the origin', () => {
  // The origin is a DIP fact about the window and does not move when the page
  // is zoomed; only the distance into the page is in scaled units.
  assert.deepEqual(clientPointToDip(CONTENT_ORIGIN, 1.25, 0, 0), { x: 127, y: 145 });
  assert.deepEqual(clientPointToDip(CONTENT_ORIGIN, 1.5, 400, 300), { x: 727, y: 595 });
  assert.deepEqual(clientPointToDip(CONTENT_ORIGIN, 0.8, 400, 300), { x: 447, y: 385 });
});

test('the error it prevents grows with distance', () => {
  // What "his apparent position always goes to the left as I drag him out"
  // actually was: an error proportional to travel, which is a scale error.
  const near = clientPointToDip(CONTENT_ORIGIN, 1.5, 40, 30);
  const far = clientPointToDip(CONTENT_ORIGIN, 1.5, 400, 300);

  const naiveNear = { x: CONTENT_ORIGIN.x + 40, y: CONTENT_ORIGIN.y + 30 };
  const naiveFar = { x: CONTENT_ORIGIN.x + 400, y: CONTENT_ORIGIN.y + 300 };

  assert.equal(near.x - naiveNear.x, 20);
  assert.equal(far.x - naiveFar.x, 200, 'ten times the distance, ten times the error');
});

test('a broken zoom reading falls back to 1 rather than to the corner', () => {
  // Multiplying by an undefined or zero factor collapses every point onto the
  // window's origin, which reads as the pet flying into the corner.
  for (const bad of [undefined, 0, Number.NaN, -1]) {
    assert.deepEqual(
      clientPointToDip(CONTENT_ORIGIN, bad as number, 400, 300),
      { x: 527, y: 445 },
    );
  }
});
