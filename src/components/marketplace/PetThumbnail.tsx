import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

import type { InstalledPet } from './marketplace-api';

/**
 * One still frame of a pet, at any size.
 *
 * The canonical way to show a pet without animating it — a picker row, a
 * conversation header, a menu item. It exists because three surfaces were each
 * cropping a frame out of a spritesheet from `frame.columns` and the idle
 * range, each with its own defensive fallback for when the numbers were not
 * what it expected. The server now names the representative frame
 * (`pet.preview`) and this draws it; nothing downstream has to know how a
 * spritesheet is laid out.
 *
 * For a *moving* pet use `PetStage`, which animates the real idle loop and
 * carries the ragged-row fix with it.
 */

type PetThumbnailProps = {
  pet: InstalledPet;
  /** Rendered height in CSS pixels. The width follows the cell's aspect ratio. */
  size?: number;
  className?: string;
};

export function PetThumbnail({ pet, size = 32, className }: PetThumbnailProps) {
  const { frame } = pet.definition;
  const { column, row } = pet.preview;

  const scale = size / Math.max(1, frame.height);
  const cellWidth = frame.width * scale;

  const style: CSSProperties = {
    width: `${cellWidth}px`,
    height: `${size}px`,
    backgroundImage: `url(${pet.spriteUrl})`,
    backgroundSize: `${frame.columns * cellWidth}px ${frame.rows * size}px`,
    backgroundPosition: `${-column * cellWidth}px ${-row * size}px`,
    backgroundRepeat: 'no-repeat',
    // Pixel art: smoothing it at a fractional scale turns it to mush.
    imageRendering: 'pixelated',
  };

  return (
    <div
      className={cn('shrink-0', className)}
      style={style}
      role="img"
      aria-label={pet.definition.displayName}
    />
  );
}
