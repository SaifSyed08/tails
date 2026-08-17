import { useEffect, useState } from 'react';

import { readArmed, readSensitivity, voiceApi } from '@/components/voice/voice-api';
import type { WakeWordArm } from '@/components/voice/useWakeWord';

/**
 * The wake words that are switched on *and* actually installed.
 *
 * Two sources have to agree: the user's choice, which lives in
 * `localStorage`, and what is on disk, which the server knows. Arming a word
 * whose model was never downloaded would spawn a Worker that fails to load and
 * report an error the user cannot act on — so a stored preference for a
 * missing model is quietly ignored until the model arrives.
 *
 * Returns a stable empty array until the server answers, so nothing is armed
 * during the round trip and the Worker is not created speculatively.
 */
const NONE: WakeWordArm[] = [];

export function useArmedWakeWords(): WakeWordArm[] {
  const [words, setWords] = useState<WakeWordArm[]>(NONE);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const status = await voiceApi.wake().catch(() => null);
      if (cancelled || !status) return;

      const chosen = new Set(readArmed());
      const sensitivity = readSensitivity();

      const next = status.words
        .filter((word) => word.installed && chosen.has(word.id))
        .map((word) => ({
          id: word.id,
          file: word.file,
          threshold: sensitivity[word.id] ?? word.threshold,
        }));

      // Keep the shared empty array when nothing is armed: a fresh `[]` on
      // every poll would restart the wake Worker and re-fetch its models.
      setWords(next.length > 0 ? next : NONE);
    })();

    return () => { cancelled = true; };
  }, []);

  return words;
}
