import { useCallback, useEffect, useRef, useState } from 'react';

import { clampVoiceSettings, toSpeech } from '@/components/voice/speech-text';
import { PiperSpeaker, readPiperStatus, type PiperStatus } from '@/components/voice/piper-client';

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
 * milliseconds. It sounds worse.
 *
 * ## Two engines, and which one answers
 *
 * Piper now sits in front of it when installed. The note above was written
 * when the licence question looked closed and it was not — the GPL problem was
 * always espeak-ng being *linked into a bundle*, which is Kokoro's JS
 * distribution and is not Piper, where it is a separate executable this app
 * merely spawns. See `server/modules/voice/piper.ts`.
 *
 * The platform synthesiser stays as the fallback rather than being removed,
 * and it earns that: it is the only engine that works before anything has been
 * downloaded, and "speech is unavailable until you fetch 60 MB" is a worse
 * first run than a voice that sounds dated. Callers do not choose — they ask
 * for speech and get the best engine present.
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
  /**
   * Force the platform synthesiser even when Piper is installed.
   *
   * Exists for pets: a pet authored with `engine: 'system'` and a named
   * platform voice has *chosen* that voice, and silently upgrading it to Piper
   * would take the choice away.
   */
  engine?: 'system' | 'auto';
  /** Which Piper voice. Omit for the default, which is norman. */
  piperVoice?: string;
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
    Piper's availability, read once. Null until the answer arrives, and null
    forever in a browser build with no server behind it — both mean "use the
    platform synthesiser", which is why this is not three states.
  */
  const [piper, setPiper] = useState<PiperStatus | null>(null);
  /*
    Constructed once, lazily.

    `useState` with an initialiser rather than a ref assigned during render:
    the object owns an audio element and a queue, so building a second one per
    render would leak players and lose the queue the previous one was holding.
  */
  const [speaker] = useState<PiperSpeaker | null>(
    () => (typeof window === 'undefined' ? null : new PiperSpeaker(setSpeaking)),
  );

  useEffect(() => {
    let cancelled = false;
    void readPiperStatus().then((status) => {
      if (!cancelled) setPiper(status);
    });
    return () => { cancelled = true; };
  }, []);


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
    // Both engines, unconditionally. Whichever one is talking, "stop" has to
    // mean stop — and after a fallback the wrong one could be mid-sentence.
    speaker?.stop();
    if (!supported) return;
    queueRef.current = [];
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported, speaker]);

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
    const chunks = toSpeech(markdown);
    if (chunks.length === 0) return;

    /*
      Piper, when it is there and the caller has not asked for the platform
      voice by name.

      The whole chunk goes over as *one* request. Each one spawns a process
      that loads a 63 MB voice, so a request per sentence would pay that four
      times for one paragraph and turn 1.7x realtime into slower than speech.
      The chunking that matters already happened in `stream-speech.ts`.
    */
    if (piper?.ready && speaker && settings?.engine !== 'system') {
      if (replace) speaker.stop();
      void speaker.enqueue(chunks.join(' '), settings?.piperVoice).catch(() => {
        // A failed chunk is one silent piece of a reply, not a reason to tear
        // the queue down — the pieces after it are already on their way.
      });
      return;
    }

    if (!supported) return;

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
  }, [supported, piper?.ready, speaker]);

  const speak = useCallback(
    (markdown: string, settings?: SpeechSettings) => say(markdown, settings, true),
    [say],
  );

  const enqueue = useCallback(
    (markdown: string, settings?: SpeechSettings) => say(markdown, settings, false),
    [say],
  );

  return {
    // True when *either* engine can talk. A machine with no platform
    // synthesiser but a downloaded Piper voice can speak, and reporting
    // otherwise would hide a working feature.
    supported: supported || Boolean(piper?.ready),
    voices,
    speaking,
    speak,
    enqueue,
    hush,
  };
}
