/**
 * The instruction a spoken message carries that a typed one does not.
 *
 * ## Why the medium changes the answer
 *
 * A written reply is skimmable. Headings, bullets and code blocks are how a
 * reader finds the one line they need without reading the other forty. Spoken,
 * every one of those is either silence or noise: a heading is read as a
 * sentence fragment, a bullet list is read as a run-on, and a code block is
 * skipped entirely — so a reply optimised for the eye is, out loud, a minute of
 * material with the useful part buried in the middle of it.
 *
 * The fix is not "be brief" in general. It is a different register: the answer
 * somebody would give if you asked them across a desk.
 *
 * ## Why it is not in the transcript
 *
 * Because the user did not say it. The message bubble shows what was spoken;
 * this rides alongside on the way to the model, exactly as `/personalize`
 * expands into a paragraph the user never sees in their own transcript. Anyone
 * scrolling back should read their own words, not their words plus a paragraph
 * of stage directions the app added.
 *
 * ## The limit is a target, not a rule
 *
 * "A few sentences" rather than a character count. A hard cap produces answers
 * that stop mid-thought when the honest one needed a clause more, and nothing
 * knows in advance which questions those are.
 */
/**
 * One sentence, and it used to be a paragraph.
 *
 * The long version listed everything spoken output cannot do — headings,
 * bullets, tables, code fences — plus what to do instead, plus when to ask a
 * clarifying question. Three problems with that. It was longer than most of
 * the messages it was attached to, so it dominated the prompt it was meant to
 * qualify. Every token of it is paid on every spoken turn. And when a bug
 * leaked the expanded prompt into the transcript, a paragraph of stage
 * directions is what the user saw.
 *
 * Naming the register is enough — "conversational" already implies no
 * headings, because nobody speaks in headings. The instruction the model
 * cannot infer is the one about *length*, so that is the half that stays.
 */
export const SPOKEN_TURN_STEER =
  'Answer in a few conversational sentences with no markdown formatting, since this will be read aloud.';

/**
 * Attaches the steer to a prompt bound for the model.
 *
 * Appended rather than prepended: the instruction is about how to answer, and
 * it reads more naturally — and is followed more reliably — as the last thing
 * before the model responds, after the thing it is meant to shape. Separated by
 * a blank line so it cannot be mistaken for part of the user's sentence.
 */
export function applySpokenSteer(prompt: string, spoken: boolean): string {
  if (!spoken) return prompt;
  return `${prompt}\n\n${SPOKEN_TURN_STEER}`;
}
