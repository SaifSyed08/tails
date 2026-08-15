import type { FrameRange, InstalledPet, PetStateName } from './marketplace-api';

/**
 * Choosing which of a pet's animations to play.
 *
 * A Codex sheet has nine or eleven labelled rows — `idle`, `running-left`,
 * `waving` and the rest — and callers ask for them by name. Two things need
 * smoothing over:
 *
 * - **Aliases.** `walk`, `talk` and `sleep` are what the app used to call
 *   things, and what a hand-written manifest may still declare. They map onto
 *   real states rather than being stored, so nothing has to migrate.
 * - **Absence.** A sheet that is not a Codex sheet has one state, and asking it
 *   to run should get idle rather than nothing. Falling back is always better
 *   than freezing: a still pet reads as broken.
 *
 * The alternatives are listed most-specific-first, so `walk` prefers a real
 * `running-right` row and only then a generic `running`.
 */

/** What each name may fall back to, in order. */
const FALLBACKS: Partial<Record<PetStateName, readonly PetStateName[]>> = {
  walk: ['running-right', 'running'],
  talk: ['waving', 'review'],
  sleep: ['waiting'],
  running: ['running-right', 'running-left'],
  'running-right': ['running', 'running-left'],
  'running-left': ['running', 'running-right'],
  'look-right-side': ['waving', 'review'],
  'look-left-side': ['look-right-side', 'waving', 'review'],
  waving: ['review', 'look-right-side'],
  jumping: ['waving'],
  failed: ['review'],
  waiting: ['idle'],
  review: ['waving'],
};

/** The state a pet will actually play for a request, always something real. */
export function resolveStateName(pet: InstalledPet, wanted: PetStateName): PetStateName {
  const states = pet.definition.states;
  if (states[wanted]) return wanted;

  for (const candidate of FALLBACKS[wanted] ?? []) {
    if (states[candidate]) return candidate;
  }

  return 'idle';
}

export function resolveStateRange(pet: InstalledPet, wanted: PetStateName): FrameRange {
  return pet.definition.states[resolveStateName(pet, wanted)] ?? pet.definition.states.idle;
}

/** True when the pet really has this animation, rather than falling back to another. */
export const hasState = (pet: InstalledPet, name: PetStateName): boolean =>
  Boolean(pet.definition.states[name]);

/**
 * The running animation for a direction of travel.
 *
 * Codex sheets carry `running-left` and `running-right` as separate rows, drawn
 * facing each way, so a pet being dragged leftwards should play the left row —
 * not the right one mirrored. Mirroring was a workaround for not knowing these
 * existed.
 */
export const runningState = (direction: 'left' | 'right'): PetStateName =>
  (direction === 'left' ? 'running-left' : 'running-right');
