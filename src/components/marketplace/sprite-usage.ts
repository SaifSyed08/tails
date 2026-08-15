import { useEffect, useState } from 'react';

import type { FrameGrid, FrameRange } from './marketplace-api';

/**
 * Which cells of a spritesheet actually contain artwork.
 *
 * ## Why this exists
 *
 * Codex sheets have **ragged rows**. Measured from the two real sheets on this
 * machine, row 0 — the row every default `idle` state claims in full — uses 7
 * of its 8 cells in one and 6 of 8 in the other. The preview dutifully animated
 * the empty cells, so every loop had a frame where the pet simply vanished.
 * That is the "for a frame they're gone" flicker: not a timing bug, a real
 * empty cell being played.
 *
 * The server cannot know this. It reads image *headers* to avoid decoding
 * megabytes of lossless WebP per pet, and a header says nothing about alpha.
 * The browser already has a decoder, so the measurement happens here, once per
 * sheet, and is shared by every surface that animates a pet.
 *
 * ## Why it only trims the end, and only within a row
 *
 * Trailing blank cells are the padding at the end of a short animation. A
 * *multi-row* range is played by sweeping whole rows, so shortening its last
 * row would desynchronise the two axes and produce a worse artefact than the
 * one being fixed — those are left exactly as configured.
 *
 * Nothing here is written back to the pet. It changes what is played, never
 * what is stored, so the frame editor still shows the user's real numbers.
 */

export type CellUsage = {
  columns: number;
  rows: number;
  /** Row-major, one flag per cell: true when the cell holds any non-transparent pixel. */
  used: boolean[];
};

/** Alpha at or below this counts as empty; lossy encoders leave dust in the gutters. */
const EMPTY_ALPHA = 8;

/** Sampling stride in pixels. A sprite that reads as blank at every 4th pixel is blank. */
const STRIDE = 4;

/**
 * Measurements are cached forever, keyed by sheet and grid.
 *
 * The promise itself is cached, not the result, so twenty cards mounting at
 * once for the same pet share one decode instead of racing twenty.
 */
const cache = new Map<string, Promise<CellUsage | null>>();

/** Decoding a 2MB sheet blocks the main thread briefly; two at a time keeps the grid interactive. */
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
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
 * Scans a sheet's alpha channel cell by cell.
 *
 * Resolves to null on any failure — a preview that cannot be measured plays the
 * configured range, which is exactly what it did before this existed.
 */
async function measure(spriteUrl: string, columns: number, rows: number): Promise<CellUsage | null> {
  try {
    const image = await loadImage(spriteUrl);
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return null;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;

    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);

    // Cell size comes from the real image rather than from the grid's declared
    // pixel size, so a grid whose cell dimensions are slightly off still scans
    // the right regions.
    const cellWidth = width / columns;
    const cellHeight = height / rows;
    const used: boolean[] = [];

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const xEnd = Math.min(width, Math.round((column + 1) * cellWidth));
        const yEnd = Math.min(height, Math.round((row + 1) * cellHeight));
        let filled = false;

        for (let y = Math.round(row * cellHeight); y < yEnd && !filled; y += STRIDE) {
          const offset = y * width * 4;
          for (let x = Math.round(column * cellWidth); x < xEnd; x += STRIDE) {
            if (data[offset + x * 4 + 3] > EMPTY_ALPHA) {
              filled = true;
              break;
            }
          }
        }

        used.push(filled);
      }
    }

    return { columns, rows, used };
  } catch {
    return null;
  }
}

export function measureCellUsage(
  spriteUrl: string,
  columns: number,
  rows: number,
): Promise<CellUsage | null> {
  const key = `${spriteUrl}|${columns}x${rows}`;
  const existing = cache.get(key);
  if (existing) return existing;

  const pending = withSlot(() => measure(spriteUrl, columns, rows));
  cache.set(key, pending);
  return pending;
}

/**
 * Drops blank cells from the end of a range.
 *
 * Single-row ranges only, and never down to nothing: a range whose cells are
 * all empty is a mis-cut grid, and playing it unchanged keeps that visible
 * instead of silently substituting a frame from somewhere else.
 */
export function trimBlankTail(range: FrameRange, grid: FrameGrid, usage: CellUsage | null): FrameRange {
  if (!usage || usage.columns !== grid.columns || usage.rows !== grid.rows) return range;
  if (Math.floor(range.start / grid.columns) !== Math.floor(range.end / grid.columns)) return range;

  let end = range.end;
  while (end > range.start && usage.used[end] === false) end -= 1;

  return end === range.end ? range : { ...range, end };
}

/**
 * The range a preview should actually play.
 *
 * Returns the configured range immediately and the trimmed one once the sheet
 * has been measured, so nothing waits on a decode to appear on screen.
 */
export function usePlayableRange(
  spriteUrl: string,
  grid: FrameGrid,
  range: FrameRange,
  enabled: boolean,
): FrameRange {
  const [usage, setUsage] = useState<CellUsage | null>(null);
  const { columns, rows } = grid;

  // Depends on the sheet and its shape, not on the grid object: the cell pitch
  // does not change which regions are scanned, and an editor that rebuilds its
  // grid on every keystroke must not restart the measurement each time.
  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    measureCellUsage(spriteUrl, columns, rows).then((measured) => {
      if (!cancelled) setUsage(measured);
    });

    return () => {
      cancelled = true;
    };
  }, [spriteUrl, columns, rows, enabled]);

  return enabled ? trimBlankTail(range, grid, usage) : range;
}
