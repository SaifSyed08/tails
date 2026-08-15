import type { InstalledPet, PetStateName } from './marketplace-api';
import { resolveStateRange } from './pet-states';
import { SpritePreview } from './SpritePreview';

/**
 * A pet, at a size, playing a state, facing a direction.
 *
 * The public way to draw a living pet anywhere in the app. Everything below it
 * — which frames a state occupies, which of them are actually drawn, how a
 * sheet is cut into cells, how the loop avoids the empty cell past the end — is
 * settled once underneath, so a caller supplies intent and nothing else.
 *
 * A Codex sheet has nine or eleven labelled animations — `running-left`,
 * `waving`, `jumping` and the rest — so asking for one by name is the whole
 * interface. `resolveStateName` handles the two awkward cases: the legacy
 * `walk`/`talk`/`sleep` aliases, and sheets that are not Codex sheets and have
 * only an idle row.
 */

export type PetFacing = 'right' | 'left';

type PetSpriteProps = {
  pet: InstalledPet;
  /** Rendered height in CSS pixels. The width follows the cell's aspect ratio. */
  size?: number;
  /** Which animation to play. Falls back to `idle` when the pet has no such state. */
  state?: PetStateName;
  /** `right` is the sheet as drawn; `left` mirrors it. Nothing records a pet's natural facing. */
  facing?: PetFacing;
  /** Freezes on the state's first frame. Reduced-motion does this on its own. */
  paused?: boolean;
  /** Overrides the state's frame rate, for a walk that should keep up with a drag. */
  fps?: number;
  className?: string;
};

export function PetSprite({
  pet,
  size = 96,
  state = 'idle',
  facing = 'right',
  paused = false,
  fps,
  className,
}: PetSpriteProps) {
  const { definition } = pet;
  // Frame counts come from the pet's own states, which the server synthesises
  // from the published Codex layout. Nothing is measured, trimmed or guessed
  // here; an unknown state resolves to a real one rather than to nothing.
  const range = resolveStateRange(pet, state);

  return (
    <SpritePreview
      spriteUrl={pet.spriteUrl}
      grid={definition.frame}
      range={fps ? { ...range, fps } : range}
      height={size}
      facing={facing}
      paused={paused}
      className={className}
    />
  );
}
