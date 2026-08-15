import { cn } from '@/lib/utils';

import type { FrameRange, InstalledPet } from './marketplace-api';
import { SpritePreview } from './SpritePreview';

/**
 * The lit box a pet stands in.
 *
 * Shared by the card grid, the spotlight and the detail sheet so a pet looks
 * like the same product wherever it is shown — a shop where the thumbnail and
 * the product page frame the goods differently reads as two shops.
 *
 * The floor line is the whole trick: sprite cells have generous empty space
 * below the feet, so a preview centred in a box appears to hover. Bottom-
 * aligning against a drawn edge puts every pet on the same ground regardless of
 * how its artist packed the cell.
 */

type PetStageProps = {
  pet: InstalledPet;
  /** Rendered cell height in CSS pixels. The width follows the cell's aspect ratio. */
  height: number;
  /** Which frames to play. Defaults to the pet's idle loop. */
  range?: FrameRange;
  className?: string;
};

export function PetStage({ pet, height, range, className }: PetStageProps) {
  return (
    <div
      className={cn(
        'relative flex items-end justify-center overflow-hidden bg-gradient-to-b from-muted/70 via-muted/30 to-transparent',
        className,
      )}
    >
      <div className="absolute inset-x-6 bottom-4 h-px bg-border" aria-hidden="true" />
      <SpritePreview
        spriteUrl={pet.spriteUrl}
        grid={pet.definition.frame}
        range={range ?? pet.definition.states.idle}
        height={height}
        className="relative mb-4"
      />
    </div>
  );
}
