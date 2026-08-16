/**
 * What a pet says while Claude thinks.
 *
 * The spinner can show a generic verb ("Pondering", "Working") or a line in the
 * pet's own voice, and the second is the whole point of having a pet on screen:
 * it is the difference between a progress indicator and a companion waiting
 * with you. These are the starting lines for the pets that arrive with a voice
 * anyone already knows.
 *
 * ## Rules
 *
 * - **Already punctuated.** Nothing appends an ellipsis. A line ending in "..."
 *   reads as waiting; a line ending in "!" reads as a shout; the pet decides
 *   which, and that choice is what stops these reading like verbs.
 * - **A handful, not a dozen.** Four to six per pet. The rotation puts a pet
 *   line in roughly one slot in three, so a small set stays recognisable where
 *   twelve would just be noise.
 * - **Only pets with a voice to borrow.** Seeded by id, and deliberately not
 *   for every installed pet: a line in the wrong mouth is worse than a verb.
 *   Real people someone has made a sprite of get nothing — putting words in
 *   their mouth is not ours to do.
 *
 * ## Why these are a fallback and not a migration
 *
 * They fill in for a pet whose phrases have never been set, rather than being
 * written into the database at install. That way editing them stores a real
 * value that always wins, clearing them back to nothing restores these, and a
 * later edit to this file reaches every pet that has not been customised. No
 * migration, and nothing to undo if the wording turns out to be wrong.
 */

/** Two sprites of the same hedgehog are installed, and he is the same hedgehog. */
const SONIC = [
  'collecting rings...',
  'gotta go fast!',
  'pondering at the speed of sound...',
  'juiced and jacked, thinking about it.',
  'waiting for the chaos emeralds to load...',
];

const SEEDS: Record<string, string[]> = {
  sonic: SONIC,
  'sonic-art': SONIC,
  pika: [
    'pika pika..',
    'pikaaa?',
    'charging up...',
    'chuuuu...',
    'pika pi!',
  ],
  clawd: [
    'thinking very hard about this one...',
    'consulting the context window...',
    'a moment, i am reasoning.',
    'holding several ideas at once...',
    'nearly there, probably.',
  ],
  clippit: [
    'it looks like you are waiting. would you like help waiting?',
    'searching the office for an answer...',
    'i have 40 suggestions. narrowing down...',
    'clipping along...',
    'this would be faster in a spreadsheet, honestly.',
  ],
};

/**
 * The seeded lines for a pet, or none.
 *
 * Matched on the pet's id, because that is what the person who packaged the pet
 * chose and it survives renaming. A pet not in the table gets nothing at all,
 * which is the correct answer: the spinner already has verbs.
 */
export function seededThinkingPhrases(petId: string): string[] {
  return SEEDS[petId] ?? [];
}
