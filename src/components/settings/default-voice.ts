// Relative rather than `@/`, deliberately. The ladder below is covered by a
// node test under `server/`, which runs on the server tsconfig — where `@/*`
// resolves to `server/*`, not `src/*`. The voice module's own tests get away
// with the alias because everything they cross is a *type* import and is erased
// before resolution; `resolvePetVoice` is a value and has to resolve for real.
import { resolvePetVoice, type PetVoice } from '../voice/pet-voice';
import type { SpeechSettings, SpeechVoice } from '../voice/useSpeech';

/**
 * The app's fallback voice, and how it composes with a pet's own.
 *
 * ## Why this lives under `settings/` and not under `voice/`
 *
 * The voice module owns *speaking* — the synthesiser, the voice list, the
 * chunking, and the cross-platform name matching. It does not own preferences,
 * and this is a preference: the user's answer to "what should I sound like when
 * nothing else has said". Putting it there would also mean two agents editing
 * one module. If the voice module later grows a home for settings, this belongs
 * in it; nothing here is chat-specific or settings-specific except its owner.
 *
 * What it must never grow is a voice matcher. See `resolveVoice`.
 */

export type DefaultVoice = {
  /**
   * The platform voice name exactly as the user picked it, or null for "let the
   * platform decide". Stored verbatim and matched at playback — see
   * `resolveVoice`.
   */
  name: string | null;
  pitch: number;
  rate: number;
  /** An ElevenLabs voice, when one has been chosen. Mirrors the server's shape. */
  elevenVoiceId: string | null;
};

export const DEFAULT_VOICE: DefaultVoice = {
  name: null, pitch: 1, rate: 1, elevenVoiceId: null,
};

/**
 * Which voice actually speaks, given a pet and the user's default.
 *
 * The order is **the pet's own voice → the app default → the platform default**,
 * and the first line is the one that carries the decision worth stating:
 *
 * A pet set to `engine: 'none'` is *choosing* silence, and silence is not an
 * empty field to be filled in. Falling through to the default there would take
 * a pet someone deliberately quietened and give it a voice, which is the one
 * outcome that would make the default feel broken rather than helpful. It is
 * also the distinction the pets module already draws: `null` means "nothing
 * stored, ask the manifest" and `'none'` means "quiet on purpose".
 *
 * Everything below that is `resolvePetVoice` twice, and that is deliberate.
 * Matching a stored name to an available voice is subtle enough to be worth
 * exactly one implementation — "Microsoft Zira Desktop" and "Microsoft Zira -
 * English (United States)" are the same speaker and share no substring — so the
 * default is expressed as a voice block and handed to the same resolver rather
 * than compared here.
 */
export function resolveVoice(
  petVoice: PetVoice | null | undefined,
  fallback: DefaultVoice,
  available: SpeechVoice[],
): SpeechSettings | null {
  if (petVoice?.engine === 'none') return null;

  const own = resolvePetVoice(petVoice, available);
  if (own) return own;

  /*
    The chosen cloud voice, above the local fallback and below the pet's own.

    Above, because picking one is an explicit act and the local default is
    whatever was there already. Below, because a pet that names its own voice
    has been given a character, and overriding that with an app-wide setting
    would make every companion sound the same — which is most of the point of
    having them.

    It still carries the platform name and the two numbers. Nothing uses them
    while the cloud voice answers, and they are what the fallback needs the
    moment it does not.
  */
  if (fallback.elevenVoiceId) {
    return {
      engine: 'system',
      ...(fallback.name ? { voiceName: fallback.name } : {}),
      pitch: fallback.pitch,
      rate: fallback.rate,
      elevenVoiceId: fallback.elevenVoiceId,
    };
  }

  // No pet, or a pet with nothing stored. `name: null` reaches `matchVoiceName`
  // as `undefined`, which is already its "pick something sensible" path — the
  // platform's own default, or failing that a voice in the right language — so
  // the third tier needs no code of its own.
  return resolvePetVoice(
    {
      engine: 'system',
      ...(fallback.name ? { name: fallback.name } : {}),
      pitch: fallback.pitch,
      rate: fallback.rate,
    },
    available,
  );
}

type DefaultVoiceResponse = { voice: DefaultVoice };

export async function readDefaultVoice(): Promise<DefaultVoice> {
  const response = await fetch('/api/preferences/default-voice', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`The default voice could not be read (${response.status}).`);
  return (await response.json() as DefaultVoiceResponse).voice;
}

/** Resolves to what was stored, which is the clamped form. */
export async function saveDefaultVoice(voice: DefaultVoice): Promise<DefaultVoice> {
  const response = await fetch('/api/preferences/default-voice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ voice }),
  });
  if (!response.ok) throw new Error(`That voice could not be saved (${response.status}).`);
  return (await response.json() as DefaultVoiceResponse).voice;
}
