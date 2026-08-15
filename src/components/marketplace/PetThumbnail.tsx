import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

import type { InstalledPet } from './marketplace-api';
import { frameOffset, resolveCellBox } from './sprite-geometry';

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
  /** `right` is the sheet as drawn; `left` mirrors it. */
  facing?: 'right' | 'left';
  className?: string;
};

export function PetThumbnail({ pet, size = 32, facing = 'right', className }: PetThumbnailProps) {
  const box = resolveCellBox(pet.definition.frame, size);
  const offset = frameOffset(pet.preview.frame, box);

  const style: CSSProperties = {
    width: `${box.cellWidth}px`,
    height: `${box.cellHeight}px`,
    backgroundImage: `url(${pet.spriteUrl})`,
    backgroundSize: `${box.sheetWidth}px ${box.sheetHeight}px`,
    backgroundPosition: `${offset.x}px ${offset.y}px`,
    backgroundRepeat: 'no-repeat',
    // Pixel art: smoothing it at a fractional scale turns it to mush.
    imageRendering: 'pixelated',
    transform: facing === 'left' ? 'scaleX(-1)' : undefined,
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
