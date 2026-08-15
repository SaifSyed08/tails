import type { FrameGrid } from './marketplace-api';

/**
 * Measuring a frame grid from the sprite itself.
 *
 * The server infers a grid from the image's dimensions alone, because reading
 * pixels there would mean decoding lossless WebP in Node. The browser already
 * has a decoder, so this is where a genuine measurement is cheap: draw the
 * sheet to a canvas and look for the fully transparent gutters between cells.
 *
 * That is how the 192x208 Codex cell pitch was established in the first place,
 * and it is the only honest answer available for an undocumented format — the
 * artwork is the specification.
 */

/** Alpha at or below this counts as empty. Lossy encoders leave a little dust in the gutters. */
const EMPTY_ALPHA = 8;

/** Sampling stride. Every other pixel is plenty to find a gutter and quarters the work. */
const STRIDE = 2;

export type GridMeasurement = {
  grid: Omit<FrameGrid, 'fps'>;
  /** Frames per row that actually contain artwork, left to right. */
  rowUsage: number[];
  /** Human-readable account of what was measured, shown next to the result. */
  note: string;
};

/** Positions where a run of non-empty lines begins. */
function contentRunStarts(occupied: boolean[]): number[] {
  const starts: number[] = [];
  for (let index = 0; index < occupied.length; index += 1) {
    if (occupied[index] && !occupied[index - 1]) starts.push(index);
  }
  return starts;
}

/**
 * The most common gap between run starts.
 *
 * The mode rather than the minimum or the mean, because cells are ragged: a
 * sprite whose artwork is narrow makes its gap look larger and one that nearly
 * fills its cell makes the neighbouring gap look smaller. Only the true pitch
 * repeats.
 */
function modalGap(starts: number[]): number | null {
  if (starts.length < 3) return null;

  const counts = new Map<number, number>();
  for (let index = 1; index < starts.length; index += 1) {
    const gap = starts[index] - starts[index - 1];
    counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }

  let best: number | null = null;
  let bestCount = 0;
  for (const [gap, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && gap > best)) {
      best = gap;
      bestCount = count;
    }
  }

  return bestCount >= 2 ? best : null;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The spritesheet could not be loaded.'));
    image.src = url;
  });
}

/**
 * Measures the frame grid of a spritesheet by finding its transparent gutters.
 *
 * Rejects rather than guessing when the sheet has no gutters at all — a sheet
 * of edge-to-edge cells is indistinguishable from a single image, and saying
 * "could not measure" is more useful than returning a number that looks
 * authoritative.
 *
 * Same-origin only: sprites are served from `/api/pets/:id/sprite`, so the
 * canvas is never tainted and `getImageData` is allowed.
 */
export async function measureGrid(spriteUrl: string): Promise<GridMeasurement> {
  const image = await loadImage(spriteUrl);
  const width = image.naturalWidth;
  const height = image.naturalHeight;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser would not give us a canvas to measure with.');

  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, width, height);

  const columnOccupied = new Array<boolean>(width).fill(false);
  const rowOccupied = new Array<boolean>(height).fill(false);

  for (let y = 0; y < height; y += STRIDE) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x += STRIDE) {
      if (data[rowOffset + x * 4 + 3] <= EMPTY_ALPHA) continue;
      columnOccupied[x] = true;
      rowOccupied[y] = true;
    }
  }

  const columnPitch = modalGap(contentRunStarts(columnOccupied));
  const rowPitch = modalGap(contentRunStarts(rowOccupied));

  if (!columnPitch || !rowPitch) {
    throw new Error(
      'No repeating transparent gutters were found, so the cell size could not be measured. '
      + 'Set the grid by hand below.',
    );
  }

  const columns = Math.max(1, Math.round(width / columnPitch));
  const rows = Math.max(1, Math.round(height / rowPitch));
  const cellWidth = Math.round(width / columns);
  const cellHeight = Math.round(height / rows);

  // How many cells in each row hold artwork, so states can be given real
  // lengths instead of the full row with blank frames on the end.
  const rowUsage: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    let used = 0;
    for (let column = 0; column < columns; column += 1) {
      let filled = false;
      const yEnd = Math.min(height, (row + 1) * cellHeight);
      const xEnd = Math.min(width, (column + 1) * cellWidth);
      for (let y = row * cellHeight; y < yEnd && !filled; y += STRIDE * 2) {
        const rowOffset = y * width * 4;
        for (let x = column * cellWidth; x < xEnd; x += STRIDE * 2) {
          if (data[rowOffset + x * 4 + 3] > EMPTY_ALPHA) {
            filled = true;
            break;
          }
        }
      }
      if (filled) used = column + 1;
    }
    rowUsage.push(used);
  }

  return {
    grid: { width: cellWidth, height: cellHeight, columns, rows },
    rowUsage,
    note: `Measured from the sheet's transparent gutters: ${width}x${height} divides into `
      + `${columns}x${rows} cells of ${cellWidth}x${cellHeight}.`,
  };
}
