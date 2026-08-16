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

/**
 * How often a slot goes to the pet, when the pet has anything to say.
 *
 * Better than even, deliberately: the pet is the reason anyone assigned it,
 * and the generic verbs are the ones nobody will miss. The remaining 40% is
 * what keeps the row still reading as "the agent is working" rather than as an
 * idle animation — at 100% the indicator stops being an indicator.
 */
const PET_SLOT_CHANCE = 0.6;

/**
 * How many slots a rotation is built from.
 *
 * Long enough that a lap through it is not recognisable as a loop — at the
 * indicator's pace this is several minutes of work — and short enough to build
 * in one pass when the pet changes.
 */
const ROTATION_SLOTS = SPINNER_VERBS.length * 2;

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
 * Draws from a pool without replacement, reshuffling once it runs dry.
 *
 * A bag rather than an independent roll each time. Independent rolls over five
 * phrases put the same line up three times in a dozen slots — no two in a row,
 * but plainly repetitive — because chance clusters. Drawing without
 * replacement guarantees every line a pet has is used before any of them comes
 * round again, which is what makes a short list stop sounding short.
 */
function createBag(pool: readonly string[], random: () => number) {
  let queue: string[] = [];

  const refill = () => {
    queue = [...pool];
    // Fisher-Yates, on the injected source so a seeded run is reproducible.
    for (let index = queue.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [queue[index], queue[swap]] = [queue[swap], queue[index]];
    }
  };

  return {
    /** Null when everything the pool holds is currently disallowed. */
    take(avoid: readonly string[]): string | null {
      if (pool.length === 0) return null;

      // Twice: once against what is left in the bag, once against a fresh one.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (queue.length === 0) refill();

        // Reaches past a disallowed head rather than reshuffling around it, so
        // the no-repeat rule costs the bag nothing.
        const index = queue.findIndex((entry) => !avoid.includes(entry));
        if (index >= 0) return queue.splice(index, 1)[0] ?? null;

        queue = [];
      }

      return null;
    },
  };
}

/**
 * Builds the rotation the indicator walks.
 *
 * Each slot is decided on its own — roughly three in five go to the pet — so
 * the sequence does not fall into an audible pattern the way a fixed
 * one-in-three cadence did. Nothing ever follows itself: with a handful of
 * phrases, pure chance repeats often enough to look like a bug, and the
 * no-repeat rule costs one extra draw to avoid.
 *
 * `random` is injected rather than reached for, so a seeded run is
 * reproducible and this does not become the one corner the tests cannot see.
 */
export function buildThinkingRotation(
  petPhrases: readonly string[] | undefined,
  random: () => number = Math.random,
): string[] {
  // Verbs are what need the ellipsis; a pet line is written by hand and
  // already punctuated however its author wanted.
  const verbs = SPINNER_VERBS.map((verb) => `${verb}…`);
  const pet = readPetPhrases(petPhrases);
  if (pet.length === 0) return verbs;

  const petBag = createBag(pet, random);
  const verbBag = createBag(verbs, random);
  const rotation: string[] = [];
  let previous = '';

  for (let slot = 0; slot < ROTATION_SLOTS; slot += 1) {
    const wantsPet = random() < PET_SLOT_CHANCE;
    // The last slot also avoids the first one. The indicator walks this list
    // in a cycle, so those two are neighbours too, and a repeat there looks
    // exactly like the indicator having frozen — just once a lap.
    const avoid = slot === ROTATION_SLOTS - 1 && rotation.length > 0
      ? [previous, rotation[0]]
      : [previous];

    // The fallback is what a one-phrase pet hits: rather than say the same
    // line twice, the slot goes back to a verb.
    const entry = (wantsPet ? petBag : verbBag).take(avoid)
      ?? (wantsPet ? verbBag : petBag).take(avoid);
    if (!entry) break;

    rotation.push(entry);
    previous = entry;
  }

  return rotation;
}
