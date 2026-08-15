import { cn } from '@/lib/utils';

import type { FrameRange, InstalledPet, PetStateName } from './marketplace-api';
import { PetGlow } from './PetGlow';
import { PetSprite } from './PetSprite';
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
  /** Which animation to play. Falls back to `idle` when the pet has no such state. */
  state?: PetStateName;
  /** An explicit frame range, for a caller that is not thinking in states. */
  range?: FrameRange;
  /** Lights the pet from behind — the card's hover response. */
  glow?: boolean;
  /** `right` is the sheet as drawn; `left` mirrors it. */
  facing?: 'right' | 'left';
  className?: string;
};

export function PetStage({
  pet, height, state = 'idle', range, glow = false, facing, className,
}: PetStageProps) {
  return (
    <div
      className={cn(
        'relative flex items-end justify-center overflow-hidden bg-gradient-to-b from-muted/70 via-muted/30 to-transparent',
        className,
      )}
    >
      {/* Behind the pet, not on it: a wash of the accent colour reads as stage
          lighting, where an outline or a filter on the sprite itself would just
          look like a selection. Shared with the catalogue cards so both shelves
          light up the same way. */}
      <PetGlow active={glow} />
      <div className="absolute inset-x-6 bottom-4 h-px bg-border" aria-hidden="true" />
      {range ? (
        <SpritePreview
          spriteUrl={pet.spriteUrl}
          grid={pet.definition.frame}
          range={range}
          height={height}
          facing={facing}
          className="relative mb-4"
        />
      ) : (
        <PetSprite
          pet={pet}
          size={height}
          state={state}
          facing={facing}
          className="relative mb-4"
        />
      )}
    </div>
  );
}
