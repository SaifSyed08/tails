/**
 * Deciding how much of a still-arriving reply is safe to start speaking.
 *
 * ## Why not just speak it when the turn ends
 *
 * Because the turn can take a minute. A spoken conversation where the answer
 * begins a minute after the question is not a conversation. The synthesiser
 * reads about three sentences in the time the model produces ten, so starting
 * early costs nothing and removes nearly all of the wait — by the time the
 * first chunk finishes, the next one has long since arrived.
 *
 * ## Why sentences and not tokens
 *
 * `speechSynthesis` gives no way to append to an utterance in progress. Each
 * call is a separate utterance with its own prosody, so cutting mid-sentence
 * produces two fragments read as two statements, with a falling tone in the
 * middle of a clause. The unit has to be at least a sentence, and three is
 * where it stops sounding chopped: enough for the synthesiser to place its
 * emphasis, short enough that the first sound arrives quickly.
 *
 * ## Why this file is pure
 *
 * All of the difficulty is in *where to cut*, and none of it is in the
 * speaking. Cutting inside a code fence, on a decimal point, or after an
 * abbreviation all produce audible nonsense, and each is a two-line test here
 * rather than something to notice by listening.
 */

/** Sentences to accumulate before handing a chunk to the synthesiser. */
export const CHUNK_SENTENCES = 3;

/**
 * Abbreviations whose full stop does not end a sentence.
 *
 * Short list on purpose: these are the ones that actually turn up in this
 * app's replies. A general solution is a language model's job, and getting it
 * wrong here costs a slightly early breath, not a wrong word.
 */
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|approx|Dr|Mr|Mrs|Ms|Prof|Fig|no|No)\.$/;

/**
 * True when the offset sits inside an unclosed code fence.
 *
 * A fenced block is full of full stops that are not sentence ends, and a chunk
 * cut halfway through one is read aloud as the code it contains — the exact
 * failure `toSpeech` exists to prevent, reintroduced by cutting too early.
 */
function insideFence(text: string, offset: number): boolean {
  let fences = 0;
  let at = text.indexOf('```');
  while (at !== -1 && at < offset) {
    fences += 1;
    at = text.indexOf('```', at + 3);
  }
  return fences % 2 === 1;
}

/**
 * Every sentence boundary in `text`, as offsets just past the punctuation.
 *
 * A boundary needs whitespace or the end of input after it, so `3.5` and
 * `file.ts` are not boundaries — the digit or letter that follows disqualifies
 * them without needing to know what a number or a filename looks like.
 */
function boundaries(text: string): number[] {
  const found: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (!'.!?'.includes(text[i])) continue;

    const after = text[i + 1];
    if (after !== undefined && !/\s/.test(after)) continue;
    if (ABBREVIATIONS.test(text.slice(0, i + 1))) continue;
    if (insideFence(text, i)) continue;

    found.push(i + 1);
  }
  return found;
}

export type Speakable = {
  /** Characters consumed from the reply. Becomes the caller's new watermark. */
  cut: number;
  /** The raw markdown to speak. Still needs `toSpeech`. */
  text: string;
};

/**
 * The next chunk worth speaking, or null if there is not enough yet.
 *
 * `spoken` is how much of `reply` has already been handed over. `final` means
 * the turn has ended, at which point whatever is left must go out however
 * short it is — holding back the last sentence of an answer because it is only
 * one sentence would be the worst possible bug in this feature.
 */
export function nextSpeakable(reply: string, spoken: number, final = false): Speakable | null {
  const pending = reply.slice(spoken);
  if (!pending.trim()) return null;

  const ends = boundaries(pending);

  if (ends.length >= CHUNK_SENTENCES) {
    // Everything complete, not just the first three: if the model got ahead
    // while a chunk was being read, sending one chunk of six sentences beats
    // sending two of three, because the pause between utterances disappears.
    const cut = ends[ends.length - 1];
    return { cut: spoken + cut, text: pending.slice(0, cut) };
  }

  if (final) return { cut: reply.length, text: pending };

  return null;
}
