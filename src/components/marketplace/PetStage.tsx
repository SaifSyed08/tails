import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';

import type { FrameRange, InstalledPet, PetStateName } from './marketplace-api';
import { PetGlow } from './PetGlow';
import { PetSprite } from './PetSprite';
import { parallaxStyle, usePointerLocal } from './use-pointer-local';
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

/** How far the pet leans toward the pointer, in CSS pixels. Small on purpose. */
const PARALLAX_REACH = 7;

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
  const reduced = useReducedMotion();
  // The stage measures itself when the pointer arrives and publishes the
  // pointer's position within it; the glow and the pet's lean both read it.
  const stageRef = usePointerLocal<HTMLDivElement>(glow && !reduced);

  return (
    <div
      ref={stageRef}
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
      <div className="absolute inset-x-6 bottom-4 z-0 h-px bg-border" aria-hidden="true" />

      {/* The lean lives on a wrapper, not on the sprite: the sprite's own
          `transform` is its facing, and a second one would replace it. */}
      <div
        className={cn(
          'relative z-10 mb-4',
          !reduced && 'transition-transform duration-quick ease-standard',
        )}
        style={glow && !reduced ? parallaxStyle(PARALLAX_REACH) : undefined}
      >
        {range ? (
          <SpritePreview
            spriteUrl={pet.spriteUrl}
            grid={pet.definition.frame}
            range={range}
            height={height}
            facing={facing}
          />
        ) : (
          <PetSprite pet={pet} size={height} state={state} facing={facing} />
        )}
      </div>
    </div>
  );
}
