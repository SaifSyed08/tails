import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';

/**
 * The light behind a pet.
 *
 * One component for both shelves, because it has been wrong in a different way
 * on each of them:
 *
 * - Sized in percentages, it collapsed to something smaller than the sprite on
 *   the narrow catalogue cards. It is sized in pixels now.
 * - Made transparent at its centre, it stopped being a glow and became a ring.
 *   It is brightest in the middle again, just faint everywhere — a wash, not a
 *   lamp.
 * - Positioned absolutely next to a statically positioned image, it painted
 *   *over* the pet instead of behind it. Everything here is explicitly on
 *   `z-0`, and every surface puts its sprite on `z-10`.
 *
 * It follows the pointer through `--pet-local-x/y`, published by the container
 * via `usePointerLocal` — no listener of its own, and no measurement per frame.
 */

/** The lit area, in CSS pixels. Wider than any card, so the light spills round the pet. */
const GLOW_WIDTH = 280;
const GLOW_HEIGHT = 220;

/** Grid pitch. Coarse enough to read as a backdrop rather than a texture. */
const GRID_SIZE = 16;

type PetGlowProps = {
  /** Usually "is the card hovered". Fades rather than unmounting. */
  active: boolean;
  className?: string;
};

export function PetGlow({ active, className }: PetGlowProps) {
  const reduced = useReducedMotion();

  // Parked in the middle under reduced motion: a gradient chasing the pointer
  // is exactly the movement that setting asks us to stop.
  const position = reduced
    ? '50% 55%'
    : 'var(--pet-local-x, 50%) var(--pet-local-y, 55%)';

  const style: CSSProperties = {
    backgroundImage: [
      // Brightest in the middle and faint the whole way through. `--primary`
      // rather than a colour, so it follows the accent.
      `radial-gradient(${GLOW_WIDTH}px ${GLOW_HEIGHT}px at ${position}, `
        + 'hsl(var(--primary) / 0.14), hsl(var(--primary) / 0.08) 40%, '
        + 'hsl(var(--primary) / 0.03) 62%, transparent 78%)',
      // A pixel grid, which is what these sprites are made of. Held to the
      // border token so it reads as structure rather than decoration.
      `repeating-linear-gradient(to right, hsl(var(--border) / 0.35) 0 1px, transparent 1px ${GRID_SIZE}px)`,
      `repeating-linear-gradient(to bottom, hsl(var(--border) / 0.35) 0 1px, transparent 1px ${GRID_SIZE}px)`,
    ].join(', '),
    // The grid only exists where the light is; past that it would just be graph
    // paper behind a card.
    maskImage: `radial-gradient(${GLOW_WIDTH}px ${GLOW_HEIGHT}px at ${position}, `
      + 'black 0%, black 42%, transparent 74%)',
    WebkitMaskImage: `radial-gradient(${GLOW_WIDTH}px ${GLOW_HEIGHT}px at ${position}, `
      + 'black 0%, black 42%, transparent 74%)',
    opacity: active ? 1 : 0,
  };

  return (
    <div
      aria-hidden="true"
      style={style}
      className={cn(
        // `z-0` and not `absolute` alone: an absolutely positioned element
        // outranks a static sibling in the same stacking context, which is how
        // this ended up painting on top of the catalogue posters.
        'pointer-events-none absolute inset-0 z-0',
        !reduced && 'transition-opacity duration-settle ease-standard',
        className,
      )}
    />
  );
}
