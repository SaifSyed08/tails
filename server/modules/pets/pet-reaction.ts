import { askHaiku } from '@/modules/pets/haiku.js';

/**
 * A pet reacting to what actually just happened.
 *
 * ## Why this is generated and the idle lines are not
 *
 * The first version picked reactions from a bank too, and it was the wrong shape
 * for the job. A canned "Neat idea!" is not a companion noticing what you asked
 * for — it is a fortune cookie, and it reads as one the second time it appears.
 * The whole appeal of a spectator is that it saw *this*.
 *
 * So a reaction is a live call, cheap and small: the user's message, the tail of
 * the reply, and a character brief. About five seconds after the turn ends,
 * which is a beat late and reads as a beat late rather than as a delay — a
 * spectator who pipes up just after you finish reading is exactly right.
 *
 * Muttering stays prebuilt, because there is nothing to react to: a model call
 * to invent a mood is spending for no information. That split is also what keeps
 * the cost sane — one generation per pet, ever, plus one small call on the
 * fraction of turns that get a reaction at all.
 *
 * ## What it must not become
 *
 * A second assistant. The pet is a spectator; it never answers the question,
 * never corrects the reply, and never carries anything the user needs — the
 * bubble disappears after a few seconds, so anything load-bearing in it is lost.
 * The brief says all three, because a model handed a conversation and asked to
 * speak will otherwise try to help.
 */

/** The longest reaction that fits the bubble. Shorter than a line of prose. */
export const MAX_REACTION = 70;

/** How much of the user's message to show it. */
const ASK_TAIL = 500;

export type ReactionSubject = {
  name: string;
  description: string;
  /** The user's own words for the character, when they have written any. */
  persona: string;
};

/**
 * The character brief.
 *
 * The same three levers as the idle-line generator, for the same measured
 * reason: without "reach for what they are famous for" and "match their volume",
 * every pet comes back as the same eager sidekick, and without a length rule the
 * model writes to whatever the cap is.
 */
export function buildReactionSystem(pet: ReactionSubject): string {
  return [
    `You are ${pet.name}, a small pet sitting in the corner of someone's chat window.`,
    pet.description ? `You are: ${pet.description}` : '',
    pet.persona ? `Your owner describes you as: ${pet.persona}` : '',
    '',
    'You are a SPECTATOR. You watch your owner work with an AI assistant. You never answer their questions, never correct the assistant, and never say anything they need to remember — you are a flourish, and what you say vanishes after a few seconds.',
    '',
    'You will be shown what your owner just asked and what the assistant just replied. Say ONE thing about it.',
    '',
    'Rules:',
    '- First person, as yourself. Never say your own name.',
    '- BRUTALLY short. Three to eight words.',
    `- Never longer than ${MAX_REACTION} characters.`,
    '- React like the character you are: to the request, to how it went, or to the thing itself. Or give your own opinion on it — you are allowed to have one.',
    '- Reach for what you are famous for: your catchphrases, the noise you make, the thing you cannot stop talking about. Put it in your own terms.',
    '- Your VOLUME is your own. If you are excitable, be thrilled. If you boast, boast. If you barely speak, barely speak.',
    '- Funny and entertaining beats accurate. You are not being graded.',
    '- No markdown, no quotes, no emoji, no stage directions, no asterisks.',
    '- English, plain keyboard characters only.',
    '',
    'Reply with the line and nothing else.',
  ].filter(Boolean).join('\n');
}

/**
 * What the pet is shown of the exchange.
 *
 * Trimmed, because an untrimmed request is often a pasted stack trace — and a
 * pet reacting to a file path is reading over your shoulder rather than watching
 * you work.
 */
export function buildReactionPrompt(ask: string): string {
  const asked = ask.trim().replace(/\s+/g, ' ').slice(0, ASK_TAIL);
  return `My owner just asked: ${asked || '(nothing in particular)'}`;
}

/**
 * One reaction, or null.
 *
 * Null is a pet that says nothing this turn, which is a state the feature
 * already handles — so a slow CLI, a missing binary or a model that returns
 * nothing usable all cost a flourish rather than breaking a turn.
 */
export async function reactTo(pet: ReactionSubject, ask: string): Promise<string | null> {
  const line = await askHaiku({
    system: buildReactionSystem(pet),
    prompt: buildReactionPrompt(ask),
    limit: MAX_REACTION,
    // A reaction is a whole spawn of the CLI plus a small generation. Measured
    // at well over the default, which was tuned for nothing in particular and
    // silently aborted every reaction it was asked for.
    timeoutMs: 60_000,
  });
  if (!line) return null;

  // A reaction that came back with a script the bubble cannot draw is worse than
  // silence — see the note in `pet-lines.ts`.
  if (/[^ -ɏ‐-›]/.test(line)) return null;
  return line;
}
