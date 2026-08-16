import type { PetStateName } from '@/components/marketplace';

/**
 * Where the in-chat pet is, and one frame of him getting somewhere else.
 *
 * Pulled out of the component because this is the part that can be wrong
 * silently. A pet who lands a pixel under the floor, or whose fall never quite
 * terminates, looks like a rendering glitch rather than like arithmetic — and
 * the whole of the "he should have weight" request lives in these few lines, so
 * they are worth being able to check without a browser.
 *
 * Everything is in overlay coordinates: `x` is his left edge, `y` is his height
 * above the floor as a negative number, and 0 is standing on it.
 */

/** Walking speed, in pixels per second. A stroll rather than a scurry. */
export const WALK_SPEED = 120;

/**
 * Downward acceleration, in pixels per second squared.
 *
 * Not earth's — a 72px pet is not a metre tall, and real gravity at this scale
 * reads as a stone dropping. Tuned so a fall from the top of a tall transcript
 * takes a little under half a second: long enough to see, short enough not to
 * be waited on.
 */
export const GRAVITY = 2600;

/** How long he takes to grow to full size after being dropped in, in ms. */
export const GROW_MS = 260;

/** The longest frame gap the physics will honour, in seconds. */
export const MAX_STEP_S = 0.05;

export type Motion = {
  arrival: string;
  x: number;
  /** Height above the floor, as a negative offset. 0 is standing. */
  y: number;
  /** Downward speed, px/s. Non-zero only while falling. */
  vy: number;
  /** Non-null while walking somewhere. */
  target: number | null;
  facing: 'left' | 'right';
  /** Overrides the resting animation: the greeting beats and click reactions. */
  gesture: PetStateName | null;
  /** 0 at the size he was carried at, 1 at the size he stands at. */
  grow: number;
  /** True while a hand is holding him: no gravity, no walking. */
  carried: boolean;
  /** True for a moment after touching down, for the landing squash. */
  squash: boolean;
};

/**
 * One frame.
 *
 * Returns the *same object* when nothing is happening, which is what keeps a
 * settled pet from re-rendering sixty times a second: the caller holds this in
 * React state and an unchanged reference is a skipped render.
 *
 * Falling takes precedence over walking, because a pet in the air has nothing
 * to push off. Any journey he was on is simply resumed from where he lands —
 * the target is left alone rather than cancelled.
 */
export function advanceMotion(motion: Motion, elapsedSeconds: number): Motion {
  // A tab that was in the background hands back a gap of several seconds, and
  // integrating that in one step teleports him. Clamped rather than skipped:
  // the frame still advances, just no further than a slow frame would.
  const elapsed = Math.min(MAX_STEP_S, Math.max(0, elapsedSeconds));
  if (motion.carried) return motion;

  const falling = motion.y < 0 || motion.vy !== 0;
  const growing = motion.grow < 1;
  if (!falling && !growing && motion.target === null) return motion;

  const next = { ...motion };

  if (growing) next.grow = Math.min(1, motion.grow + (elapsed * 1000) / GROW_MS);

  if (falling) {
    next.vy = motion.vy + GRAVITY * elapsed;
    next.y = motion.y + next.vy * elapsed;

    if (next.y >= 0) {
      next.y = 0;
      next.vy = 0;
      next.squash = true;
    }
    return next;
  }

  if (motion.target !== null) {
    const direction = motion.target > motion.x ? 1 : -1;
    const moved = motion.x + direction * WALK_SPEED * elapsed;
    const arrived = direction > 0 ? moved >= motion.target : moved <= motion.target;

    if (arrived) {
      next.x = motion.target;
      next.target = null;
    } else {
      next.x = moved;
      next.facing = direction > 0 ? 'right' : 'left';
    }
  }

  return next;
}
