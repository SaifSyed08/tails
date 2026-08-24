import { preferencesRepository } from '@/db/preferences.repository.js';

/**
 * The voice for everything that has not been given one of its own.
 *
 * A chat with no pet, and a pet whose voice has never been set, both had
 * nothing to fall back to — per-pet voices existed and nothing else did. This
 * is that floor.
 *
 * **`name` is stored exactly as the user picked it, and is never resolved
 * here.** A stored voice name is a preference, not a handle: the same speaker
 * is "Microsoft Zira Desktop" to Windows and "Microsoft Zira - English (United
 * States)" to Chromium, two strings that share no substring. Matching one to
 * the other is `matchVoiceName`'s job in the voice module, it is genuinely
 * subtle, and there must not be a second copy of it — least of all one on the
 * server, which cannot see the voice list at all. So this layer stores a string
 * and clamps two numbers, and the renderer resolves.
 */
export type DefaultVoice = {
  /** Null when the user has not picked one, which means the platform's own. */
  name: string | null;
  pitch: number;
  rate: number;
  /**
   * An ElevenLabs voice, when the user has chosen one.
   *
   * Stored beside the platform name rather than instead of it, so turning the
   * cloud voice off returns them to the local one they had rather than to
   * nothing. Also an opaque id and never resolved here — the same rule the
   * comment above states for `name`, and for the stronger reason that only the
   * vendor knows what ids exist.
   */
  elevenVoiceId: string | null;
};

export const DEFAULT_VOICE: DefaultVoice = {
  name: null, pitch: 1, rate: 1, elevenVoiceId: null,
};

const PREFERENCE_KEY = 'voice.default';

/**
 * Clamps to the ranges the pet voice schema already uses.
 *
 * Not the authoritative clamp — `clampVoiceSettings` in the voice module is,
 * and every playback path goes through it on the way to the synthesiser. This
 * one exists so a hand-written request cannot put a value in the database that
 * every reader afterwards has to defend against.
 */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export function normalizeDefaultVoice(value: unknown): DefaultVoice {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';

  return {
    // Empty and absent collapse to the same thing on purpose: "" is what a
    // cleared <select> sends, and storing it would be a voice name no platform
    // will ever report, which reads as "chosen, but missing" rather than "not
    // chosen".
    name: name || null,
    pitch: clamp(record.pitch, 0, 2, DEFAULT_VOICE.pitch),
    rate: clamp(record.rate, 0.1, 3, DEFAULT_VOICE.rate),
    elevenVoiceId: typeof record.elevenVoiceId === 'string' && record.elevenVoiceId.trim()
      ? record.elevenVoiceId.trim()
      : null,
  };
}

export function readDefaultVoice(): DefaultVoice {
  const stored = preferencesRepository.read(PREFERENCE_KEY);
  if (!stored) return DEFAULT_VOICE;

  try {
    return normalizeDefaultVoice(JSON.parse(stored));
  } catch {
    // A row that will not parse is a row from a shape that no longer exists.
    // Falling back beats throwing on every read of the settings panel.
    return DEFAULT_VOICE;
  }
}

/** Returns what was actually stored, which is the normalized form. */
export function writeDefaultVoice(value: unknown): DefaultVoice {
  const voice = normalizeDefaultVoice(value);
  preferencesRepository.write(PREFERENCE_KEY, JSON.stringify(voice));
  return voice;
}
