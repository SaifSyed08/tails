/**
 * How a spritesheet becomes one cell on screen.
 *
 * ## Why this is its own module
 *
 * Every surface that draws a pet needs the same four numbers, and every one of
 * them was computing them itself. That is how the catalogue shelf ended up
 * painting a **5472x104 filmstrip** — 57 frames — into a 28-pixel-tall box: not
 * a wrong formula, but a surface that never applied one, because "put the sheet
 * in an `<img>`" looks reasonable right up until you see the result. A pet
 * rendered as a row of tiny sprites is the visible form of that mistake.
 *
 * So the arithmetic lives here, once, and it is deliberately boring:
 *
 * - the element is **exactly one cell**, scaled so its height is what the
 *   caller asked for;
 * - the background is the whole sheet, scaled by the same factor, so a
 *   background offset of one cell moves exactly one frame;
 * - a frame index becomes an offset in that scaled space.
 *
 * It has no imports on purpose. It is pure arithmetic shared by the React
 * components, by the desktop pet window (a separate document with no bundler),
 * and by the test suite, and none of those should have to drag the others in.
 */

/** The parts of a frame grid that affect geometry. Structural, so any grid shape fits. */
export type SpriteGrid = {
  /** Cell width in source pixels. */
  width: number;
  /** Cell height in source pixels. */
  height: number;
  columns: number;
  rows: number;
};

export type CellBox = {
  /** The element's size: one cell, at the requested height. */
  cellWidth: number;
  cellHeight: number;
  /** `background-size`: the whole sheet at the same scale. */
  sheetWidth: number;
  sheetHeight: number;
  scale: number;
  /** Cells in the sheet, clamped to something drawable. */
  columns: number;
  rows: number;
  frameCount: number;
};

const positive = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * The box for one cell of `grid`, drawn `displayHeight` pixels tall.
 *
 * Every field is derived from the same scale factor, which is the property that
 * matters: a caller cannot size the element from one number and the background
 * from another. Degenerate grids are clamped rather than rejected, because a
 * pet with a nonsense grid should still render *something* — one wrong-looking
 * frame is debuggable, `NaN` in a style attribute is not.
 */
export function resolveCellBox(grid: SpriteGrid, displayHeight: number): CellBox {
  const cellSourceWidth = positive(grid.width, 1);
  const cellSourceHeight = positive(grid.height, 1);
  const columns = Math.max(1, Math.floor(positive(grid.columns, 1)));
  const rows = Math.max(1, Math.floor(positive(grid.rows, 1)));

  const scale = positive(displayHeight, 1) / cellSourceHeight;
  const cellWidth = cellSourceWidth * scale;
  const cellHeight = cellSourceHeight * scale;

  return {
    cellWidth,
    cellHeight,
    sheetWidth: columns * cellWidth,
    sheetHeight: rows * cellHeight,
    scale,
    columns,
    rows,
    frameCount: columns * rows,
  };
}

/**
 * Where to put the background so that `frame` is the cell on screen.
 *
 * Row-major, and clamped into the sheet: a frame index past the end would
 * otherwise scroll the background off the element and paint nothing, which
 * reads as "the pet disappeared" rather than as "that range is wrong".
 */
export function frameOffset(frame: number, box: CellBox): { x: number; y: number } {
  const index = Math.min(Math.max(0, Math.floor(frame) || 0), box.frameCount - 1);
  return {
    // `+ 0` collapses negative zero, which frame 0 produces and which serialises
    // into style attributes as `-0px`. Harmless to a browser, confusing in a
    // diff, and enough to make an equality check between two identical
    // geometries fail.
    x: -(index % box.columns) * box.cellWidth + 0,
    y: -Math.floor(index / box.columns) * box.cellHeight + 0,
  };
}

/**
 * The geometry of a single-row filmstrip, worked out from the image itself.
 *
 * The catalogue serves preview reels as one long row whose frame count is not
 * stated anywhere — only the cell *aspect* is known, from the publisher's
 * validation report. Dividing the strip's real width by the frame width implied
 * by that aspect gives the count, and a strip that does not divide cleanly is
 * refused rather than animated approximately: a preview that drifts sideways
 * looks worse than a still one.
 */
export function resolveStripGrid(
  naturalWidth: number,
  naturalHeight: number,
  cellAspect: number,
): SpriteGrid | null {
  if (!(naturalWidth > 0) || !(naturalHeight > 0) || !(cellAspect > 0)) return null;

  const frameWidth = naturalHeight * cellAspect;
  const rounded = Math.round(naturalWidth / frameWidth);

  // Measured in pixels, not in frames: a strip 57 frames long only has to be
  // one pixel too wide for a fractional-frame tolerance to wave it through, and
  // the resulting animation slides sideways a little more every loop.
  if (rounded < 1 || Math.abs(naturalWidth - rounded * frameWidth) > 0.5) return null;

  return {
    width: frameWidth,
    height: naturalHeight,
    columns: rounded,
    rows: 1,
  };
}

/** Parses the `"192x208"` shape the catalogue states its cell size in. */
export function parseCellAspect(cellSize: string | null | undefined): number | null {
  const match = /^(\d{1,5})x(\d{1,5})$/i.exec(cellSize?.trim() ?? '');
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}
