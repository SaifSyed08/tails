import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';

import type { FrameGrid, FrameRange } from './marketplace-api';
import { resolveCellBox } from './sprite-geometry';
import { usePlayableRange } from './sprite-usage';

/**
 * The keyframes every sprite preview shares.
 *
 * Two of them, one per axis, both reading custom properties set inline on the
 * element. That indirection is what lets one static rule animate any grid: the
 * alternative is a generated `@keyframes` block per pet per state, injected and
 * cleaned up as cards mount, which is a lot of moving parts for a background
 * position.
 *
 * Rendered once by `<MarketplacePage>`; it is exported rather than injected so
 * nothing has to reach into `document.head` and nothing leaks on unmount.
 */
export const SPRITE_KEYFRAMES = `
@keyframes tails-sprite-x {
  from { background-position-x: var(--sprite-x-from); }
  to { background-position-x: var(--sprite-x-to); }
}
@keyframes tails-sprite-y {
  from { background-position-y: var(--sprite-y-from); }
  to { background-position-y: var(--sprite-y-to); }
}
`;

type SpritePreviewProps = {
  spriteUrl: string;
  grid: FrameGrid;
  /** Which frames to play. Defaults to the whole first row. */
  range?: FrameRange;
  /** Rendered cell height in CSS pixels; the width follows the cell's aspect ratio. */
  height?: number;
  paused?: boolean;
  /**
   * Which way the pet faces.
   *
   * `right` is however the sheet was drawn — nothing records a pet's natural
   * direction, so this is "as authored" rather than a claim about east. `left`
   * mirrors it, which is what a pet being dragged leftwards needs.
   */
  facing?: 'right' | 'left';
  /**
   * Whether to stop at the last cell that holds artwork.
   *
   * On by default: Codex rows are ragged, so a range covering a whole row
   * usually ends in empty cells and playing them is a visible hole in the loop.
   * The frame editor turns it off, because there the blank cells are the thing
   * being diagnosed and hiding them would hide the problem.
   */
  trimBlankFrames?: boolean;
  className?: string;
};

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));

/**
 * Plays a run of spritesheet frames with a CSS `steps()` animation.
 *
 * The sheet is the element's background and the element is one cell wide, so
 * animating `background-position` in discrete steps walks the frames with no
 * JavaScript per frame and no re-render — which matters when a gallery has a
 * dozen of these running at once.
 *
 * Two cases are exact, and they are the two that occur in practice:
 *
 * - a range inside a single row — one X animation;
 * - a range covering whole rows — X sweeps each row while Y steps down them.
 *
 * A multi-row range that starts partway along a row cannot be expressed this
 * way and plays approximately; `describeRangeFit` reports that so the editor
 * can say so rather than leaving the user to wonder.
 *
 * Two things here exist purely to stop the loop showing a cell it should not:
 * the `jump-none` timing (see the comment on the custom properties below) and
 * `trimBlankFrames`, which drops the empty padding at the end of a ragged row.
 * Together they are the fix for pets vanishing for one frame per loop.
 */
export function SpritePreview({
  spriteUrl,
  grid,
  range,
  height = 96,
  paused = false,
  facing = 'right',
  trimBlankFrames = true,
  className,
}: SpritePreviewProps) {
  const reduced = useReducedMotion();

  const lastFrame = Math.max(0, grid.columns * grid.rows - 1);
  const requested: FrameRange = {
    start: clamp(range?.start ?? 0, 0, lastFrame),
    end: clamp(range?.end ?? grid.columns - 1, clamp(range?.start ?? 0, 0, lastFrame), lastFrame),
    fps: range?.fps,
  };

  const played = usePlayableRange(spriteUrl, grid, requested, trimBlankFrames);
  const start = played.start;
  const end = played.end;
  const frameCount = end - start + 1;

  const startColumn = start % grid.columns;
  const startRow = Math.floor(start / grid.columns);
  const rowSpan = Math.floor(end / grid.columns) - startRow + 1;

  // One shared derivation of "one cell, this tall", so this component and the
  // thumbnail and the desktop window cannot disagree about it.
  const box = resolveCellBox(grid, height);
  const { cellWidth, cellHeight } = box;

  const fps = played.fps ?? grid.fps ?? 8;
  const framesPerSweep = rowSpan === 1 ? frameCount : grid.columns;
  const sweepSeconds = framesPerSweep / Math.max(0.5, fps);
  const totalSeconds = frameCount / Math.max(0.5, fps);

  const still = reduced || paused || frameCount < 2 || framesPerSweep < 2;
  const originX = rowSpan === 1 ? -startColumn * cellWidth : 0;

  const style: Record<string, string> = {
    width: `${cellWidth}px`,
    height: `${cellHeight}px`,
    backgroundImage: `url(${spriteUrl})`,
    backgroundSize: `${box.sheetWidth}px ${box.sheetHeight}px`,
    backgroundRepeat: 'no-repeat',
    // Sprites are pixel art; smoothing them on a non-integer scale is the
    // difference between crisp and mush.
    imageRendering: 'pixelated',
    // Both axes stop *on* the last frame rather than one cell past it. With
    // `steps(n)` the keyframe end has to be the cell after the last, and an
    // animation that loops on a whole-second boundary lands a paint exactly
    // there — showing the empty cell beyond the range for one frame. Ending on
    // the last frame with `jump-none` gives the same n positions, evenly held,
    // and never addresses a cell outside the range.
    '--sprite-x-from': `${originX}px`,
    '--sprite-x-to': `${originX - (framesPerSweep - 1) * cellWidth}px`,
    '--sprite-y-from': `${-startRow * cellHeight}px`,
    '--sprite-y-to': `${-(startRow + rowSpan - 1) * cellHeight}px`,
  };

  if (still) {
    style.backgroundPosition = `${-startColumn * cellWidth}px ${-startRow * cellHeight}px`;
  } else {
    // A single-row range animates X only, so Y has to be planted on the row —
    // without this it defaults to 0 and a walk cycle on row 3 silently plays
    // row 0.
    if (rowSpan === 1) style.backgroundPositionY = `${-startRow * cellHeight}px`;

    style.animation = [
      `tails-sprite-x ${sweepSeconds}s steps(${framesPerSweep}, jump-none) infinite`,
      ...(rowSpan > 1
        ? [`tails-sprite-y ${totalSeconds}s steps(${rowSpan}, jump-none) infinite`]
        : []),
    ].join(', ');
  }

  // Mirrored rather than re-drawn, because no sheet carries a second facing.
  // `scaleX` flips the painted cell only; the frame arithmetic above is
  // untouched, so the walk cycle is identical in both directions.
  if (facing === 'left') style.transform = 'scaleX(-1)';

  return (
    <div
      className={cn('shrink-0', className)}
      style={style as CSSProperties}
      role="img"
      aria-label={still ? 'Sprite frame' : 'Animated sprite preview'}
    />
  );
}

/**
 * Whether a range can be animated exactly by the two-axis `steps()` technique.
 *
 * Exported so the frame editor can warn instead of silently playing something
 * slightly wrong — an animation that drifts by one frame per loop is exactly
 * the kind of bug that gets blamed on the artwork.
 */
export function describeRangeFit(grid: FrameGrid, range: FrameRange): string | null {
  const startColumn = range.start % grid.columns;
  const spansRows = Math.floor(range.end / grid.columns) !== Math.floor(range.start / grid.columns);

  if (spansRows && startColumn !== 0) {
    return 'This range crosses rows without starting at the first column, so the preview only approximates it. '
      + 'Ranges that stay inside one row, or start at column 1, play exactly.';
  }

  return null;
}
