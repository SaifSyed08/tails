import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';

import type { CatalogueEntry } from './marketplace-api';
import { parseCellAspect, resolveCellBox, resolveStripGrid } from './sprite-geometry';

/**
 * A remote pet, shown before it is installed.
 *
 * The catalogue offers two images and they are not interchangeable: a
 * **poster**, which is one 192x208 cell, and a **preview**, which is a
 * 5472x104 strip of every frame laid out in a row. Dropping the second into an
 * image element is what made these cards show a line of tiny sprites instead of
 * a pet — the strip is animation source material, not a picture.
 *
 * So the poster is what a card shows at rest, and the strip is fetched only
 * when the pointer arrives and then played through the same one-cell geometry
 * as an installed pet. That costs about 30KB per card instead of 160KB, and
 * nothing downloads the 1.7MB spritesheet until the pet is actually installed.
 *
 * The strip's frame count is stated nowhere, so it is derived from the image's
 * real width and the cell aspect in the publisher's validation report. If that
 * does not divide cleanly the strip is not played at all: a preview that drifts
 * sideways every loop is worse than a still one.
 */

type CataloguePreviewProps = {
  entry: CatalogueEntry;
  /** Rendered height in CSS pixels. */
  size: number;
  /** Set while the pointer is over the card. */
  hovered: boolean;
  className?: string;
};

/**
 * How many of the strip's opening frames are the idle loop.
 *
 * From the published layout: row 0 is six frames, and — unlike the
 * spritesheet, where v2's idle gains a seventh "Neutral look" cell — the strip
 * is built from the six-frame variant in both versions. That is why a v1 strip
 * is 57 frames and a v2 strip is 73 rather than 74.
 */
const STRIP_IDLE_FRAMES = 6;

/** Their player's speed: `duration = max(frames * 260ms, 1400ms)`. */
const CODEX_FRAME_MS = 260;

export function CataloguePreview({ entry, size, hovered, className }: CataloguePreviewProps) {
  const reduced = useReducedMotion();
  const [strip, setStrip] = useState<{ url: string; width: number; height: number } | null>(null);

  const wantsStrip = hovered && !reduced && entry.stripUrl !== null;

  // Loaded on hover rather than with the page: fifty filmstrips at 160KB is
  // eight megabytes of animation nobody asked to watch.
  useEffect(() => {
    if (!wantsStrip || strip || !entry.stripUrl) return undefined;

    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      setStrip({ url: image.src, width: image.naturalWidth, height: image.naturalHeight });
    };
    image.src = entry.stripUrl;

    return () => {
      cancelled = true;
    };
  }, [wantsStrip, strip, entry.stripUrl]);

  const aspect = parseCellAspect(entry.validation?.cellSize) ?? 192 / 208;
  const stripGrid = strip ? resolveStripGrid(strip.width, strip.height, aspect) : null;

  if (wantsStrip && strip && stripGrid) {
    const box = resolveCellBox(stripGrid, size);
    // Only the idle segment. The strip is every frame of every row in one line
    // — 57 of them for a v1 sheet, 73 for a v2 — so playing it as one loop
    // marches through running, waving, jumping and the rest at twelve frames a
    // second, which is what made these previews look like they were flickering.
    // Row 0 comes first in the concatenation, so the idle loop is simply the
    // opening frames.
    const frames = Math.min(STRIP_IDLE_FRAMES, box.columns);
    const seconds = (frames * CODEX_FRAME_MS) / 1000;

    return (
      <div
        className={cn('shrink-0', className)}
        style={{
          width: `${box.cellWidth}px`,
          height: `${box.cellHeight}px`,
          backgroundImage: `url(${strip.url})`,
          backgroundSize: `${box.sheetWidth}px ${box.sheetHeight}px`,
          backgroundRepeat: 'no-repeat',
          imageRendering: 'pixelated',
          // Same construction as `SpritePreview`: the last step lands on the
          // final frame rather than one cell past it, so the loop never shows
          // the empty space beyond the strip.
          ['--sprite-x-from' as string]: '0px',
          ['--sprite-x-to' as string]: `${-(frames - 1) * box.cellWidth}px`,
          animation: frames > 1
            ? `tails-sprite-x ${seconds}s steps(${frames}, jump-none) infinite`
            : undefined,
        }}
        role="img"
        aria-label={`${entry.displayName}, animated preview`}
      />
    );
  }

  if (!entry.posterUrl) return null;

  return (
    <img
      src={entry.posterUrl}
      alt=""
      loading="lazy"
      className={cn('shrink-0', className)}
      style={{ height: `${size}px`, width: 'auto', imageRendering: 'pixelated' }}
    />
  );
}
