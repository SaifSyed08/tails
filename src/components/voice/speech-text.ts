/**
 * Turning a written reply into something worth listening to.
 *
 * ## Why this is not just `speak(message)`
 *
 * Replies in this app are markdown written for the eye: fenced code, file
 * paths, bullet lists, backticked identifiers. Handed straight to a speech
 * synthesiser they become unlistenable — a code block read character by
 * character is thirty seconds of noise, and `**bold**` is pronounced.
 *
 * Splitting into sentences matters for a second reason: `speechSynthesis`
 * queues utterances and starts the first almost immediately, so a reply broken
 * into sentences begins speaking while the rest is still being prepared, and
 * `cancel()` stops at the next boundary rather than mid-word.
 */

/**
 * Longest single utterance, in characters.
 *
 * Chromium's synthesiser becomes unreliable on very long strings — it can stop
 * partway with no error and no `end` event — and a long utterance is also one
 * that cannot be interrupted promptly. Sentences are usually far shorter; this
 * only bites on someone pasting a wall of prose.
 */
export const MAX_UTTERANCE_CHARS = 240;

/**
 * Replaces a fenced code block with a short spoken marker.
 *
 * Naming the language when it is given is worth the four extra words: "a
 * TypeScript code block" tells the listener whether they need to go and look.
 */
function announceCodeBlocks(text: string): string {
  return text.replace(/```(\w+)?[^\n]*\n[\s\S]*?```/g, (_, lang: string | undefined) => (
    lang ? `. (a ${lang} code block). ` : '. (a code block). '
  ));
}

/**
 * Strips markdown that should be seen rather than heard.
 *
 * Inline code keeps its contents — a backticked `cwd` or filename is usually
 * the most load-bearing word in the sentence, so it is unwrapped rather than
 * skipped. Link text is kept and the URL dropped, because reading a URL aloud
 * is never what anyone wanted.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*>\s?/gm, '')
    // A leading bullet becomes a pause, so a list does not run together into
    // one breathless sentence.
    .replace(/^\s*[-*+]\s+/gm, '. ')
    .replace(/^\s*\d+\.\s+/gm, '. ')
    .replace(/^\s*([-*_]\s*){3,}$/gm, '');
}

/** Splits on sentence enders, keeping the punctuation with its sentence. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/);
}

/** Breaks an over-long sentence at a comma, or failing that at a word. */
function softWrap(sentence: string): string[] {
  if (sentence.length <= MAX_UTTERANCE_CHARS) return [sentence];

  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > MAX_UTTERANCE_CHARS) {
    const window = rest.slice(0, MAX_UTTERANCE_CHARS);
    const at = Math.max(window.lastIndexOf(', '), window.lastIndexOf(' '));
    const cut = at > 40 ? at : MAX_UTTERANCE_CHARS;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * The speakable form of a reply, as a queue of utterances.
 *
 * Returns an empty array for anything with nothing to say — a message that was
 * only a code block should produce silence rather than the word "code block"
 * on its own.
 */
export function toSpeech(markdown: string): string[] {
  if (!markdown.trim()) return [];

  const prose = stripMarkdown(announceCodeBlocks(markdown))
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    // Collapse the run of separators that dropping a block or a bullet leaves.
    .replace(/(\.\s*){2,}/g, '. ')
    .trim();

  const chunks = sentences(prose)
    .flatMap(softWrap)
    .map((part) => part.trim())
    .filter((part) => /[a-z0-9]/i.test(part));

  // Nothing but markers means the reply was entirely code; say nothing.
  return chunks.every((part) => /^\.?\s*\(a .*code block\)\.?$/.test(part)) ? [] : chunks;
}

/**
 * Clamps a pet's authored voice settings to what the platform accepts.
 *
 * `petVoiceSchema` allows rate 0.1–3 and pitch 0–2. The Web Speech API accepts
 * rate 0.1–10 and pitch 0–2, so pitch already agrees and rate only needs its
 * floor enforced — but going through one function means a pet definition can
 * never hand the synthesiser a value that makes it throw.
 */
export function clampVoiceSettings(rate: number, pitch: number): { rate: number; pitch: number } {
  const safe = (value: number, min: number, max: number, fallback: number) => (
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  );
  return { rate: safe(rate, 0.1, 3, 1), pitch: safe(pitch, 0, 2, 1) };
}
