/**
 * Turning repeated whisper passes into text that arrives while you talk.
 *
 * ## The problem, which is not latency
 *
 * Transcribing the audio so far, over and over as more arrives, is easy. The
 * hard part is that each pass may *disagree with the last one*: whisper hears
 * "the tests pass and the build" and then, given another second of audio,
 * decides the fourth word was "a" rather than "the". A UI that shows every
 * pass rewrites itself several times a second, and text that rewrites itself
 * is harder to work with than text that simply arrives late.
 *
 * ## The rule
 *
 * **Only ever show text that has stopped changing.** A word is emitted when it
 * has appeared in the same position across consecutive passes *and* enough
 * later words exist that it is no longer in the volatile tail. Everything else
 * is held back.
 *
 * The consequence is worth being explicit about, because it is a deliberate
 * trade rather than an oversight: the last few words always lag by a pass or
 * two. What the user sees is a sentence assembling itself a few words behind
 * their voice, never a sentence arguing with itself. The correction still
 * happens — it happens before anything is shown, which is the version of
 * "corrective dictation" that does not cost the reader anything.
 */

/**
 * How many consecutive passes must agree before a word can be emitted.
 *
 * Two is enough to catch the common case — a word that changes once more
 * audio arrives — while costing only one extra pass of delay. Three was tried
 * on paper and mostly buys latency.
 */
export const STABLE_PASSES = 2;

/**
 * Words held back from the end of the agreed prefix.
 *
 * Whisper revises the *end* of its output far more than the middle, because
 * the last words are the ones with no following context. Three is a guess
 * informed by watching where revisions land; it is the first number to tune if
 * text still shifts after being shown.
 */
export const TAIL_HOLDBACK = 3;

/**
 * Shortest gap between passes, in milliseconds.
 *
 * A pass on this machine measured 522 ms for a short utterance and 796 ms for
 * fourteen seconds, and cost is near-constant because whisper pads every input
 * to a 30-second window. Below about a second the passes would overlap and the
 * recogniser would simply queue, adding latency and CPU for no extra
 * resolution.
 */
export const MIN_PASS_INTERVAL_MS = 1000;

/** Words compare equal if they differ only in case or trailing punctuation. */
function normalise(word: string): string {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
}

const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

/**
 * How many leading words all the given passes agree on.
 *
 * Compared on the normalised form so that a pass adding a comma, or
 * capitalising after deciding a sentence started, does not read as
 * disagreement and stall the commit.
 */
function agreedPrefixLength(passes: string[][]): number {
  if (passes.length === 0) return 0;

  const shortest = Math.min(...passes.map((pass) => pass.length));
  let agreed = 0;
  while (agreed < shortest) {
    const candidate = normalise(passes[0][agreed]);
    if (!passes.every((pass) => normalise(pass[agreed]) === candidate)) break;
    agreed += 1;
  }
  return agreed;
}

/**
 * Accumulates passes and hands out only the part that has settled.
 *
 * Stateful because "settled" is a statement about history, but the state is
 * three fields and every decision is derived, so it is straightforward to test.
 */
export class StableTranscript {
  private emitted: string[] = [];
  private recent: string[][] = [];

  constructor(
    private readonly stablePasses = STABLE_PASSES,
    private readonly holdback = TAIL_HOLDBACK,
  ) {}

  /** Everything handed out so far, as one string. */
  get committed(): string {
    return this.emitted.join(' ');
  }

  /**
   * Feeds one pass and returns any newly settled text.
   *
   * Returns an empty string for most calls, which is the expected case —
   * nothing settles until the passes agree and the tail has moved on.
   */
  advance(transcript: string): string {
    const pass = words(transcript);
    this.recent.push(pass);
    if (this.recent.length > this.stablePasses) this.recent.shift();

    // A single pass has nothing to agree with; committing from it would be
    // committing to whisper's first guess, which is the thing to avoid.
    if (this.recent.length < this.stablePasses) return '';

    const agreed = agreedPrefixLength(this.recent);
    const safe = Math.max(0, agreed - this.holdback);
    if (safe <= this.emitted.length) return '';

    // Taken from the newest pass: it has the best punctuation and casing, and
    // by construction it agrees with the others on every word up to `safe`.
    const newest = this.recent[this.recent.length - 1];
    const fresh = newest.slice(this.emitted.length, safe);
    this.emitted = newest.slice(0, safe);
    return fresh.join(' ');
  }

  /**
   * Releases everything still held back.
   *
   * Called once when the user stops talking. At that point there is no more
   * context coming, so the tail will never settle on its own and holding it
   * back would silently drop the end of the sentence — the worst possible
   * failure for a dictation feature.
   */
  flush(finalTranscript: string): string {
    const pass = words(finalTranscript);

    // The final pass sees all the audio and is the most accurate, but it may
    // disagree with text already shown. Anything already emitted cannot be
    // taken back, so re-anchor on it: find where the final pass diverges and
    // append only from there.
    const anchor = agreedPrefixLength([this.emitted, pass]);
    const rest = pass.slice(Math.max(anchor, Math.min(this.emitted.length, pass.length)));

    this.emitted = pass;
    this.recent = [];
    return rest.join(' ');
  }

  reset(): void {
    this.emitted = [];
    this.recent = [];
  }
}
