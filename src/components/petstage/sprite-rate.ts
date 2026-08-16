import type { PetStateName } from '@/components/marketplace';

/**
 * How fast each animation plays, relative to the rate its sheet was drawn at.
 *
 * Codex's own convention is 260ms a frame, and playing everything at it makes
 * the pets look like they are moving through treacle — but playing everything
 * *faster* than it made the pet look agitated, which is worse. The two are not
 * in tension once you separate what the states are for:
 *
 * - **Moments** — running, jumping, waving, a reaction to a click — happen
 *   because something happened. They are brief and you are watching them, so
 *   they can be brisk.
 * - **Resting states** — idle, and `waiting` while Claude thinks — are what is
 *   on screen essentially all the time, in the corner of the eye of someone
 *   trying to read. They should breathe. Idle is deliberately *slower* than the
 *   authored rate rather than merely un-boosted: a companion who is doing
 *   nothing should look like he is doing nothing.
 *
 * Mirrored in `desktop-window.ts`, which cannot import this — a pet must not
 * animate at two different speeds depending on which surface he is standing on.
 * If you change a number here, change it there.
 */

/** Anything not named below: a moment, and quicker than the sheet's own rate. */
export const ACTIVE_RATE = 1.35;

const RESTING_RATES: Partial<Record<PetStateName, number>> = {
  /** ~306ms a frame. Slower than the 260ms the sprites were drawn at. */
  idle: 0.85,
  /** ~260ms: the authored rate. He is waiting on Claude, not lounging. */
  waiting: 1,
};

export function rateForState(state: PetStateName): number {
  return RESTING_RATES[state] ?? ACTIVE_RATE;
}

/** The frames-per-second to hand a sprite, given its sheet's own rate. */
export function fpsForState(sheetFps: number | undefined, state: PetStateName): number {
  return (sheetFps ?? 8) * rateForState(state);
}
