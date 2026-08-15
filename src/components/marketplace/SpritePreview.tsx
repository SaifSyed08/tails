import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';

import type { FrameGrid, FrameRange } from './marketplace-api';

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
 */
export function SpritePreview({
  spriteUrl,
  grid,
  range,
  height = 96,
  paused = false,
  className,
}: SpritePreviewProps) {
  const reduced = useReducedMotion();

  const lastFrame = Math.max(0, grid.columns * grid.rows - 1);
  const start = clamp(range?.start ?? 0, 0, lastFrame);
  const end = clamp(range?.end ?? grid.columns - 1, start, lastFrame);
  const frameCount = end - start + 1;

  const startColumn = start % grid.columns;
  const startRow = Math.floor(start / grid.columns);
  const rowSpan = Math.floor(end / grid.columns) - startRow + 1;

  const scale = height / Math.max(1, grid.height);
  const cellWidth = grid.width * scale;
  const cellHeight = grid.height * scale;

  const fps = range?.fps ?? grid.fps ?? 8;
  const framesPerSweep = rowSpan === 1 ? frameCount : grid.columns;
  const sweepSeconds = framesPerSweep / Math.max(0.5, fps);
  const totalSeconds = frameCount / Math.max(0.5, fps);

  const still = reduced || paused || frameCount < 2;
  const originX = rowSpan === 1 ? -startColumn * cellWidth : 0;

  const style: Record<string, string> = {
    width: `${cellWidth}px`,
    height: `${cellHeight}px`,
    backgroundImage: `url(${spriteUrl})`,
    backgroundSize: `${grid.columns * cellWidth}px ${grid.rows * cellHeight}px`,
    backgroundRepeat: 'no-repeat',
    // Sprites are pixel art; smoothing them on a non-integer scale is the
    // difference between crisp and mush.
    imageRendering: 'pixelated',
    '--sprite-x-from': `${originX}px`,
    '--sprite-x-to': `${originX - framesPerSweep * cellWidth}px`,
    '--sprite-y-from': `${-startRow * cellHeight}px`,
    '--sprite-y-to': `${-(startRow + rowSpan) * cellHeight}px`,
  };

  if (still) {
    style.backgroundPosition = `${-startColumn * cellWidth}px ${-startRow * cellHeight}px`;
  } else {
    style.animation = [
      `tails-sprite-x ${sweepSeconds}s steps(${framesPerSweep}) infinite`,
      ...(rowSpan > 1 ? [`tails-sprite-y ${totalSeconds}s steps(${rowSpan}) infinite`] : []),
    ].join(', ');
  }

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
