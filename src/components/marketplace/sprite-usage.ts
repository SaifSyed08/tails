import { useEffect } from 'react';

import { petsApi, type InstalledPet } from './marketplace-api';

/**
 * Measuring which cells of a spritesheet hold artwork.
 *
 * ## Why the browser does this and then gives the answer away
 *
 * Codex sheets have ragged rows — the two on this machine use 6 and 7 of their
 * 8 first-row cells — so a state claiming a whole row ends in empty frames and
 * the pet vanishes for a frame, once per loop.
 *
 * Only a browser can see that: the server reads image *headers* to avoid
 * decoding megabytes of lossless WebP per pet, and a header says nothing about
 * alpha. But the browser is the wrong place to *decide* what to do about it,
 * because there is more than one browser here — the marketplace and the
 * always-on-top desktop window are separate documents, and when the trim lived
 * in the renderer only one of them got it. The pet blinked on the desktop and
 * not in the app.
 *
 * So this measures and posts the result, and the server hands every surface the
 * trimmed ranges (`pet.playable`). One measurement, one rule, one answer.
 */

/** Alpha at or below this counts as empty; lossy encoders leave dust in the gutters. */
const EMPTY_ALPHA = 8;

/** Sampling stride in pixels. A cell that reads as blank at every 4th pixel is blank. */
const STRIDE = 4;

/** Ids already measured — or attempted — this session, so a gallery decodes each sheet once. */
const reported = new Set<string>();

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The spritesheet could not be loaded.'));
    image.src = url;
  });
}

/**
 * Scans a sheet's alpha channel, one character per cell.
 *
 * Returns null on any failure. A pet that cannot be measured keeps playing its
 * declared ranges, which is exactly what it did before any of this existed.
 */
export async function measureCellUsage(
  spriteUrl: string,
  columns: number,
  rows: number,
): Promise<string | null> {
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

    // Cell size from the real image rather than from the grid's declared pixel
    // size, so a grid whose cell dimensions are slightly off still scans the
    // right regions.
    const cellWidth = width / columns;
    const cellHeight = height / rows;
    let usage = '';

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

        usage += filled ? '1' : '0';
      }
    }

    return usage;
  } catch {
    return null;
  }
}

/**
 * Measures a pet's sheet once, if nobody has, and tells the server.
 *
 * Called by `PetSprite`, so simply drawing a pet anywhere in the app is what
 * eventually teaches every other surface how to draw it. Deliberately silent:
 * this is an optimisation of someone else's future render, and a failed POST
 * must never disturb the pet on screen.
 */
export function useReportCellUsage(pet: InstalledPet): void {
  const { id } = pet.definition;
  const { columns, rows } = pet.definition.frame;
  const { spriteUrl } = pet;
  const hasCellUsage = Boolean(pet.hasCellUsage);

  useEffect(() => {
    if (hasCellUsage || reported.has(id)) return;
    reported.add(id);

    void measureCellUsage(spriteUrl, columns, rows).then((usage) => {
      if (!usage) return;
      return petsApi.reportCellUsage(id, usage).catch(() => {
        // A pet whose measurement did not save just gets measured again next
        // launch. Nothing on screen depends on it having worked.
      });
    });
  }, [id, spriteUrl, columns, rows, hasCellUsage]);
}
