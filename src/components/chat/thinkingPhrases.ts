/**
 * Mixing a pet's own lines into the thinking indicator.
 *
 * Import-free so the repo's test runner can execute it directly.
 */

/** Longest a pet line may be before it stops fitting on one line of the row. */
const MAX_PHRASE_LENGTH = 48;

/** Most lines one pet may contribute, however many it defines. */
const MAX_PHRASES = 8;

/** One pet line per this many slots in the rotation. */
const PHRASE_SPACING = 3;

/**
 * Cleans user-authored lines.
 *
 * These are typed by whoever made the pet and rendered verbatim, so they are
 * treated as hostile input: collapsed to a single line, trimmed, length-capped
 * and count-capped. Nothing here interprets markup — the indicator renders
 * plain text — so this is about the row staying a row.
 */
export function readPetPhrases(phrases: readonly string[] | undefined): string[] {
  if (!phrases) return [];

  return phrases
    .filter((phrase): phrase is string => typeof phrase === 'string')
    .map((phrase) => phrase.replace(/\s+/g, ' ').trim())
    .filter((phrase) => phrase.length > 0)
    .map((phrase) => (phrase.length > MAX_PHRASE_LENGTH
      ? `${phrase.slice(0, MAX_PHRASE_LENGTH - 1).trimEnd()}…`
      : phrase))
    .slice(0, MAX_PHRASES);
}

/**
 * Builds the rotation the indicator walks.
 *
 * Mixed rather than replaced, and spaced rather than clumped. An indicator
 * that only ever says pet lines stops reading as "the agent is working" and
 * starts reading as decoration — the ordinary words are what make the pet
 * lines land as a surprise rather than as the whole joke.
 *
 * The pet's lines cycle, so a pet with two of them still says both throughout
 * a long run instead of falling silent after the first pass.
 */
export function buildThinkingRotation(
  base: readonly string[],
  petPhrases: readonly string[] | undefined,
): string[] {
  const pet = readPetPhrases(petPhrases);
  // Base words are the ones that need the ellipsis; a pet line is written by
  // hand and already punctuated however its author wanted.
  const rotation: string[] = [];
  let petIndex = 0;

  base.forEach((word, index) => {
    rotation.push(`${word}…`);
    if (pet.length > 0 && (index + 1) % (PHRASE_SPACING - 1) === 0) {
      rotation.push(pet[petIndex % pet.length]);
      petIndex += 1;
    }
  });

  return rotation;
}
