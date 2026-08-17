import { useCallback, useEffect, useMemo, useRef } from 'react';

import { nextSpeakable } from '@/components/voice/stream-speech';
import type { SpeechSettings } from '@/components/voice/useSpeech';

/**
 * Reads a reply back while it is still being written.
 *
 * Owns exactly one thing: the watermark. How much of this answer has already
 * been spoken, so the next chunk starts where the last one stopped. Where to
 * cut is `stream-speech.ts`; how to make a sound is `useSpeech`; this is the
 * bookkeeping that connects a growing string to a queue that only moves
 * forwards.
 *
 * ## Armed per turn, not per mode
 *
 * Speaking is switched on by *sending a message with your voice*, not by voice
 * mode being on. Typing a question while voice mode happens to be armed should
 * not produce a spoken answer — the user is reading, and the wake word was for
 * the message before this one. `begin()` is called from the send path for
 * exactly that reason.
 */

type Options = {
  /** The assistant's current text for the turn in progress. Grows as it streams. */
  reply: string;
  /** True while the turn is still running. Its falling edge flushes the tail. */
  busy: boolean;
  speak: {
    enqueue: (markdown: string, settings?: SpeechSettings) => void;
    hush: () => void;
  };
  /** The voice to read in, if the conversation's pet has one. */
  settings?: SpeechSettings;
};

export function useSpokenReply({ reply, busy, speak, settings }: Options): {
  /** Starts speaking the turn that is about to run. */
  begin: () => void;
  /** Abandons the current turn, silently. */
  cancel: () => void;
} {
  const armedRef = useRef(false);
  const spokenRef = useRef(0);
  /*
    `busy` is false both before a turn starts and after it ends, and the tail
    flush must only happen on the second. Without this, `begin()` followed by a
    render before the send lands would immediately flush an empty reply and
    disarm — the answer would then be read by nobody.
  */
  const startedRef = useRef(false);

  const speakRef = useRef(speak);
  useEffect(() => { speakRef.current = speak; }, [speak]);
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  useEffect(() => {
    if (!armedRef.current) return;
    if (busy) startedRef.current = true;

    const final = startedRef.current && !busy;
    const chunk = nextSpeakable(reply, spokenRef.current, final);

    if (chunk) {
      spokenRef.current = chunk.cut;
      speakRef.current.enqueue(chunk.text, settingsRef.current);
    }

    if (final) {
      armedRef.current = false;
      startedRef.current = false;
    }
  }, [reply, busy]);

  const begin = useCallback(() => {
    armedRef.current = true;
    startedRef.current = false;
    spokenRef.current = 0;
    // Whatever was being read is about to be answered by something newer.
    speakRef.current.hush();
  }, []);

  const cancel = useCallback(() => {
    armedRef.current = false;
    startedRef.current = false;
    spokenRef.current = 0;
    speakRef.current.hush();
  }, []);

  // Memoised: callers put this in effect dependency arrays, and a fresh object
  // every render would re-run them on every keystroke.
  return useMemo(() => ({ begin, cancel }), [begin, cancel]);
}
