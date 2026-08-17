import { useCallback, useEffect, useRef, useState } from 'react';

import { clampVoiceSettings, toSpeech } from '@/components/voice/speech-text';

/**
 * Voice output, on the platform's own synthesiser.
 *
 * ## Why `speechSynthesis` and not a neural model
 *
 * Kokoro 82M was the obvious candidate and it does not survive contact with
 * this app's licence: the only maintained JS distribution statically embeds a
 * compiled espeak-ng, which is GPL-3.0, into the bundle — the combined-work
 * pattern that led Piper's own maintainers to relicense. Its time to first
 * audio on a CPU is also somewhere between one and three seconds, which is the
 * wrong side of usable for a reply you are waiting on.
 *
 * The platform synthesiser is local, ships with the operating system, costs
 * zero bytes and zero licence exposure, and starts speaking in tens of
 * milliseconds. It sounds worse. That is a real trade and the right way round
 * for a first implementation — and `petVoiceSchema` already describes exactly
 * this: `engine: 'none' | 'system'` with a voice name, pitch and rate.
 */

export type SpeechVoice = {
  /** The platform's own identifier, stored in settings and in a pet's voice. */
  name: string;
  lang: string;
  /** True for the voice the platform would pick on its own. */
  isDefault: boolean;
};

export type SpeechSettings = {
  voiceName?: string | null;
  rate?: number;
  pitch?: number;
};

export type SpeechController = {
  /** False when the platform has no synthesiser at all. */
  supported: boolean;
  /** Voices to choose from in settings. Empty until the platform reports them. */
  voices: SpeechVoice[];
  speaking: boolean;
  /** Reads a markdown reply aloud. Replaces anything already being spoken. */
  speak: (markdown: string, settings?: SpeechSettings) => void;
  /**
   * Adds to what is being spoken instead of replacing it.
   *
   * This is what makes a reply speakable while it is still arriving. `speak`
   * cancels first — correct for "here is the answer", wrong for "here is the
   * next three sentences of it", which would cut off the previous three every
   * time the model produced more.
   */
  enqueue: (markdown: string, settings?: SpeechSettings) => void;
  /** Stops immediately. Safe to call when nothing is speaking. */
  hush: () => void;
};

/**
 * Reads the voice list.
 *
 * On Chromium `getVoices()` returns an empty array on first call and fills in
 * asynchronously, signalled by `voiceschanged`. A settings panel that reads it
 * once at mount therefore shows an empty dropdown forever, which is the bug
 * this subscription exists to prevent.
 */
function readVoices(): SpeechVoice[] {
  return window.speechSynthesis.getVoices().map((voice) => ({
    name: voice.name,
    lang: voice.lang,
    isDefault: voice.default,
  }));
}

export function useSpeech(): SpeechController {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const [voices, setVoices] = useState<SpeechVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);

  /*
    Utterances are held here for the lifetime of the queue. Chromium garbage-
    collects a `SpeechSynthesisUtterance` that nothing references even while it
    is still being spoken, which truncates playback partway through with no
    error — keeping the array alive is the documented workaround.
  */
  const queueRef = useRef<SpeechSynthesisUtterance[]>([]);

  useEffect(() => {
    if (!supported) return undefined;

    const sync = () => setVoices(readVoices());
    sync();
    window.speechSynthesis.addEventListener('voiceschanged', sync);

    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', sync);
      // Leaving the page must not leave the machine talking.
      window.speechSynthesis.cancel();
    };
  }, [supported]);

  const hush = useCallback(() => {
    if (!supported) return;
    queueRef.current = [];
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  /**
   * The shared body of `speak` and `enqueue`.
   *
   * `replace` is the only difference, and it is the whole difference: one
   * cancels what is playing, the other lets it finish first.
   */
  const say = useCallback((
    markdown: string,
    settings: SpeechSettings | undefined,
    replace: boolean,
  ) => {
    if (!supported) return;

    const chunks = toSpeech(markdown);
    if (chunks.length === 0) return;

    // A new reply supersedes the old one; queueing behind it would mean
    // hearing an answer to a question two turns ago.
    if (replace) {
      window.speechSynthesis.cancel();
      queueRef.current = [];
    }

    const { rate, pitch } = clampVoiceSettings(settings?.rate ?? 1, settings?.pitch ?? 1);
    const chosen = settings?.voiceName
      ? window.speechSynthesis.getVoices().find((v) => v.name === settings.voiceName)
      : undefined;

    const utterances = chunks.map((text) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = rate;
      utterance.pitch = pitch;
      if (chosen) utterance.voice = chosen;
      return utterance;
    });

    /*
      The flag is cleared by whichever utterance turns out to be last, checked
      at the moment it ends rather than decided now. With chunks arriving while
      earlier ones are still playing, "the last one" is not knowable in advance
      — binding it up front is what would make the indicator go dark in the
      middle of a reply that is still being read.
    */
    for (const utterance of utterances) {
      const settle = () => {
        queueRef.current = queueRef.current.filter((entry) => entry !== utterance);
        if (queueRef.current.length === 0) setSpeaking(false);
      };
      utterance.addEventListener('end', settle);
      utterance.addEventListener('error', settle);
    }

    queueRef.current = [...queueRef.current, ...utterances];
    setSpeaking(true);
    for (const utterance of utterances) window.speechSynthesis.speak(utterance);
  }, [supported]);

  const speak = useCallback(
    (markdown: string, settings?: SpeechSettings) => say(markdown, settings, true),
    [say],
  );

  const enqueue = useCallback(
    (markdown: string, settings?: SpeechSettings) => say(markdown, settings, false),
    [say],
  );

  return { supported, voices, speaking, speak, enqueue, hush };
}
