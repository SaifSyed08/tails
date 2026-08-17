import type { SpeechSettings, SpeechVoice } from '@/components/voice/useSpeech';

/**
 * Giving a pet its own voice.
 *
 * `petVoiceSchema` has carried `engine`, `name`, `pitch` and `rate` since pets
 * were introduced, describing `name` as *"a Platform voice name, e.g. a
 * SpeechSynthesis voice"* — and nothing has ever read it. This is the part that
 * does.
 *
 * ## The problem worth solving here
 *
 * A pet is a file someone authored, possibly on another machine and another
 * operating system. A pet from macOS names "Samantha"; Windows has never heard
 * of her. A pet from a German install names "Microsoft Hedda". The named voice
 * is therefore a **preference, not a guarantee**, and the interesting work is
 * degrading from it without either throwing or silently going mute.
 */

/** The voice block as pets carry it. Mirrors `petVoiceSchema`, deliberately loose. */
export type PetVoice = {
  engine: 'none' | 'system';
  name?: string;
  pitch: number;
  rate: number;
};

/**
 * Words that appear in voice names without identifying the voice.
 *
 * Every platform wraps the same speaker in different furniture — Windows says
 * "Microsoft Zira Desktop", Chrome says "Microsoft Zira - English (United
 * States)", and the only word that means anything is "Zira". Matching on the
 * whole string fails between platforms; matching after removing these does not.
 */
const GENERIC_VOICE_WORDS = new Set([
  'microsoft', 'google', 'apple', 'desktop', 'mobile', 'online', 'natural',
  'voice', 'english', 'united', 'states', 'kingdom', 'america', 'american',
  'british', 'australian', 'india', 'female', 'male', 'default', 'enhanced',
  'premium', 'compact', 'siri', 'espeak',
]);

/** The words in a voice name that actually name the speaker. */
function distinctiveWords(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[()\-_,.]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !GENERIC_VOICE_WORDS.has(word)),
  );
}

/**
 * Picks the closest available voice to what a pet asked for.
 *
 * Four steps, each a weaker claim than the last:
 *
 * 1. **Exact name.** The pet was authored against this platform; use it.
 * 2. **Shared distinctive word.** "Zira" and "Microsoft Zira - English (United
 *    States)" both reduce to `zira`, so a pet authored on any platform finds
 *    the same speaker here. Substring matching cannot do this — neither string
 *    contains the other.
 * 3. **Same language.** A pet that wanted an English voice gets an English
 *    voice, which is much better than a German one reading English text.
 * 4. **The platform default**, which is always better than refusing to speak.
 *
 * Returns the voice *name* rather than the object so the caller stays free of
 * platform types, and so this is testable without a browser.
 */
export function matchVoiceName(
  wanted: string | undefined,
  available: SpeechVoice[],
  preferredLang = 'en',
): string | undefined {
  if (available.length === 0) return undefined;

  if (wanted) {
    const exact = available.find((voice) => voice.name === wanted);
    if (exact) return exact.name;

    const needle = distinctiveWords(wanted);
    if (needle.size > 0) {
      const shared = available.find((voice) => {
        for (const word of distinctiveWords(voice.name)) if (needle.has(word)) return true;
        return false;
      });
      if (shared) return shared.name;
    }
  }

  const sameLang = available.find((voice) => voice.lang?.toLowerCase().startsWith(preferredLang));
  if (sameLang) return sameLang.name;

  // Not `available[0]`: the platform's own default is a better guess than
  // whichever voice happens to be first in an unordered list.
  return available.find((voice) => voice.isDefault)?.name;
}

/**
 * Turns a pet's voice block into settings the synthesiser accepts.
 *
 * Returns null when the pet should not speak at all. `engine: 'none'` is an
 * authored choice — a pet that is meant to be silent — and honouring it is the
 * difference between a setting and a suggestion.
 */
export function resolvePetVoice(
  voice: PetVoice | null | undefined,
  available: SpeechVoice[],
): SpeechSettings | null {
  if (!voice || voice.engine === 'none') return null;

  return {
    voiceName: matchVoiceName(voice.name, available) ?? null,
    // Clamping lives in `clampVoiceSettings`, which every path goes through;
    // passing the authored values on unmodified keeps one place responsible.
    rate: voice.rate,
    pitch: voice.pitch,
  };
}
