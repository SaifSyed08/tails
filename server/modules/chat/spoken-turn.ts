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
 * Deliberately expressed as "a few sentences" rather than a character count. A
 * hard cap produces answers that stop mid-thought when the honest answer needed
 * one more clause, and the model has no way to know in advance which questions
 * those are. The one hard instruction is about *formatting*, because that one
 * has no legitimate exception when nobody is looking at a screen.
 */
export const SPOKEN_TURN_STEER = [
  'The user spoke this message aloud and will hear your reply read back by a',
  'speech synthesiser rather than read it on screen. Answer the way you would',
  'if they had asked you out loud: plain conversational sentences, a few of',
  'them, no more than is useful.',
  '',
  'No markdown at all — no headings, no bullet or numbered lists, no bold, no',
  'tables, no code fences. None of those exist out loud; they are either read',
  'as punctuation or skipped.',
  '',
  'If the honest answer needs code, a long path or a list of more than about',
  'three things, say so in a sentence and tell them it is on screen rather',
  'than reciting it. If the question genuinely cannot be answered briefly, ask',
  'a short clarifying question instead of delivering a monologue.',
].join(' ').replace(/\s+/g, ' ');

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
