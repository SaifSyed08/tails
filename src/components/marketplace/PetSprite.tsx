import type { InstalledPet, PetStateName } from './marketplace-api';
import { SpritePreview } from './SpritePreview';

/**
 * A pet, at a size, playing a state, facing a direction.
 *
 * The public way to draw a living pet anywhere in the app. Everything below it
 * — which frames a state occupies, which of them are actually drawn, how a
 * sheet is cut into cells, how the loop avoids the empty cell past the end — is
 * settled once underneath, so a caller supplies intent and nothing else.
 *
 * A pet that has no `walk` row falls back to `idle` rather than freezing or
 * playing something arbitrary: most Codex sheets have exactly one labelled
 * state, and a companion that stops moving when asked to walk looks broken in a
 * way that "it walks on the spot" does not.
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
  const range = definition.states[state] ?? definition.states.idle;

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
