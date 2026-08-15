import assert from 'node:assert/strict';
import test from 'node:test';

import { gridFromValidation } from '@/modules/pets/pets.service.js';
import { inferFrameGrid } from '@/modules/pets/sprite-metrics.js';
// Reaching across into the client is deliberate. The geometry is client-side —
// it turns a grid into CSS pixels — but it is also the thing that was wrong on
// screen, and this repository has one test runner, which globs `server/**`.
// The module is pure arithmetic with no imports, so importing it here costs
// nothing and leaves the rule it encodes covered.
import {
  frameOffset,
  parseCellAspect,
  resolveCellBox,
  resolveStripGrid,
} from '../../../../src/components/marketplace/sprite-geometry.js';

/**
 * One cell, however the grid was arrived at.
 *
 * A pet installed from the catalogue gets an **authored** grid, built from the
 * publisher's `validationReport`; a pet found on disk gets an **inferred** one,
 * measured from the image dimensions. Two routes to the same four numbers, and
 * a units mismatch between them would show up as a pet rendered at the wrong
 * scale — or, in the extreme, as the whole sheet painted into one box.
 */
test('authored and inferred grids produce identical single-cell geometry', () => {
  const inferred = inferFrameGrid({ width: 1536, height: 1872, format: 'webp' });
  const authored = gridFromValidation({
    cellSize: '192x208',
    atlasSize: '1536x1872',
    statesDetected: 9,
  });

  assert.ok(authored, 'the validation report should yield a grid');
  assert.equal(inferred.basis, 'codex-cell-pitch');
  assert.deepEqual(authored, inferred.grid);

  // The same at every size anything actually draws them at.
  for (const height of [24, 32, 96, 104, 128, 208]) {
    assert.deepEqual(
      resolveCellBox(authored, height),
      resolveCellBox(inferred.grid, height),
      `geometry diverges at ${height}px`,
    );
  }

  // And the numbers themselves are the ones that make a cell a cell.
  const box = resolveCellBox(authored, 104);
  assert.equal(box.cellHeight, 104);
  assert.equal(box.cellWidth, 96);
  assert.equal(box.sheetWidth, 96 * 8);
  assert.equal(box.sheetHeight, 104 * 9);
  assert.equal(box.frameCount, 72);
});

test('a frame index becomes an offset inside the sheet, always', () => {
  const box = resolveCellBox({ width: 192, height: 208, columns: 8, rows: 9 }, 104);

  assert.deepEqual(frameOffset(0, box), { x: 0, y: 0 });
  assert.deepEqual(frameOffset(9, box), { x: -96, y: -104 });

  // Past the end, negative, and not a number all clamp into the sheet rather
  // than scrolling the background off the element — which paints nothing, and
  // reads as the pet having vanished.
  assert.deepEqual(frameOffset(999, box), { x: -96 * 7, y: -104 * 8 });
  assert.deepEqual(frameOffset(-5, box), { x: 0, y: 0 });
  assert.deepEqual(frameOffset(Number.NaN, box), { x: 0, y: 0 });
});

/**
 * The catalogue's preview image is a filmstrip.
 *
 * 5472x104, which is 57 frames of 96x104 in a single row. Painting it whole is
 * what made remote pets render as a line of sprites, so the strip has to be
 * read as a grid — and a strip whose width does not divide by the frame width
 * has to be refused rather than animated approximately.
 */
test('a filmstrip resolves to one row of single-cell frames', () => {
  const aspect = parseCellAspect('192x208');
  assert.ok(aspect);

  const grid = resolveStripGrid(5472, 104, aspect);
  assert.deepEqual(grid, { width: 96, height: 104, columns: 57, rows: 1 });

  // The cell drawn from it is one frame wide, not the whole strip.
  const box = resolveCellBox(grid, 104);
  assert.equal(box.cellWidth, 96);
  assert.equal(box.sheetWidth, 5472);

  // Nonsense in, nothing out.
  assert.equal(resolveStripGrid(5473, 104, aspect), null);
  assert.equal(resolveStripGrid(0, 104, aspect), null);
  assert.equal(parseCellAspect('not-a-size'), null);
  assert.equal(parseCellAspect(null), null);
});

test('a degenerate grid still renders one drawable cell', () => {
  // What the single-frame inference tier produces: the whole sheet as one cell.
  const box = resolveCellBox({ width: 1536, height: 1872, columns: 1, rows: 1 }, 104);

  assert.equal(box.frameCount, 1);
  assert.equal(box.sheetWidth, box.cellWidth);
  assert.equal(box.sheetHeight, box.cellHeight);

  // Zeroes and NaN cannot reach a style attribute.
  const broken = resolveCellBox({ width: 0, height: 0, columns: 0, rows: -3 }, 0);
  for (const value of Object.values(broken)) assert.ok(Number.isFinite(value) && value > 0);
});
