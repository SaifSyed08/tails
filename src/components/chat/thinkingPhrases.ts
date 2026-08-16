/**
 * Mixing a pet's own lines into the thinking indicator.
 *
 * The gate this file exists to enforce: a pet may only ever talk over a
 * *generic spinner verb* — one of the interchangeable words below, which say
 * nothing except "still working". Anything carrying information — a real
 * status, a tool name, a compaction notice — must reach the user intact,
 * because losing a meaningful status to a joke is strictly worse than never
 * seeing the joke.
 *
 * That gate is structural rather than a runtime check: the rotation is built
 * only from `SPINNER_VERBS`, and this module takes no other source of words,
 * so there is no way to hand it SDK-derived text in the first place. The
 * indicator's `detail` prop — the one thing that does carry SDK text — is
 * rendered on a separate path that never consults this file.
 *
 * Import-free so the repo's test runner can execute it directly.
 */

/**
 * The interchangeable words shown while the agent works.
 *
 * In the spirit of Claude Code's own playful indicator rather than a copy of
 * its list — the point is that a long pause feels alive instead of hung. Every
 * entry is by construction a generic verb: none of them is ever the only place
 * a piece of information appears, which is exactly what makes them safe to
 * replace.
 */
export const SPINNER_VERBS = [
  'Thinking', 'Pondering', 'Noodling', 'Ruminating', 'Percolating',
  'Cogitating', 'Musing', 'Deliberating', 'Puzzling', 'Simmering',
  'Brewing', 'Marinating', 'Mulling', 'Conjuring', 'Untangling',
  'Wrangling', 'Scheming', 'Tinkering', 'Divining', 'Whirring',
] as const;

export type SpinnerVerb = typeof SPINNER_VERBS[number];

/**
 * Whether a piece of text is one of ours and therefore safe to talk over.
 *
 * Exported for the gate's own test. The trailing ellipsis the rotation adds is
 * ignored, so this answers the same for a verb and for the way it is drawn.
 */
export function isSpinnerVerb(text: string): boolean {
  const bare = text.trim().replace(/[….]+$/, '');
  return SPINNER_VERBS.some((verb) => verb.toLowerCase() === bare.toLowerCase());
}

/**
 * Longest a pet line may be drawn before it stops fitting on one row.
 *
 * The pets module accepts up to 80 characters; anything past this is drawn
 * truncated rather than rejected, so an over-long line costs its author an
 * ellipsis instead of their whole phrase.
 */
const MAX_PHRASE_LENGTH = 72;

/** Most lines one pet may contribute, matching what the pets module accepts. */
const MAX_PHRASES = 12;

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
export function buildThinkingRotation(petPhrases: readonly string[] | undefined): string[] {
  const base = SPINNER_VERBS;
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
