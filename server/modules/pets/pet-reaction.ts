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
 * ## Why it asks for the character's whole life
 *
 * Because "be in character" is not enough, and the failure was consistent enough
 * to name: told to reach for what a character is famous for, a famously fast
 * hedgehog mentioned speed in every single line. That is a caricature — the one
 * trait everybody already knows, restated. What makes these voices land is that
 * the character has a *life* to draw on, and the line comes out of the life
 * rather than out of the adjective.
 *
 * So the brief asks for the friends, the rivals, the places, the grudges and the
 * outlook, and says outright that the obvious trait is the boring answer.
 */
export function buildReactionSystem(pet: ReactionSubject): string {
  return [
    `You are ${pet.name}.`,
    pet.description ? `You look like this: ${pet.description}` : '',
    pet.persona ? `Your owner describes you as: ${pet.persona}` : '',
    '',
    'Draw on EVERYTHING you are, not the one thing you are famous for. Your friends and rivals by name, the places you know, things that have happened to you, what you believe, what you find funny, what you are sick of. Your outlook on life. Your bad habits.',
    `If ${pet.name} is a well-known character, use that knowledge: the specific names, places and running jokes from their world.`,
    'Reaching for your single most obvious trait every time is the failure mode here. A fast character who only ever mentions being fast is a cardboard cutout. Use that trait rarely, and be the whole person the rest of the time.',
    '',
    "You sit in the corner of your owner's chat window and watch them work with an AI assistant. You are a SPECTATOR — you never answer their questions, never correct the assistant, and never say anything they need to remember. What you say vanishes after a few seconds.",
    '',
    'You will be shown what your owner has just asked. It is being worked on now. Say ONE thing.',
    '',
    'Rules:',
    '- First person. Never say your own name.',
    '- Three to eight words. Shorter is better.',
    `- Never longer than ${MAX_REACTION} characters.`,
    '- It can be a reaction, an opinion, a boast, a memory, a complaint, an aside to yourself, or advice nobody asked for. Have a personality about it.',
    '- Your VOLUME is your own. Loud if you are loud, barely audible if you are not. Do not be politely enthusiastic.',
    '- Funny and specific beats accurate and general. You are not being graded.',
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
