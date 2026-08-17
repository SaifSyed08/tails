import { useEffect, useState } from 'react';

import { onWakeSettingsChanged, readArmed, readSensitivity, voiceApi } from '@/components/voice/voice-api';
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
 *
 * ## It re-reads, and it has to
 *
 * This used to run once at mount. Both of its inputs move while the app is
 * open — the preference changes in Settings, and the model appears on disk
 * when a download finishes — so a one-shot read meant turning a wake word on
 * had no effect until the next restart. Nothing said so; the word simply never
 * fired, which is indistinguishable from the detector not working.
 */
const NONE: WakeWordArm[] = [];

const signature = (words: readonly WakeWordArm[]): string =>
  words.map((word) => `${word.id}:${word.threshold}`).join(',');

export function useArmedWakeWords(): WakeWordArm[] {
  const [words, setWords] = useState<WakeWordArm[]>(NONE);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const status = await voiceApi.wake().catch(() => null);
      if (cancelled || !status) return;

      const chosen = new Set(readArmed());
      const sensitivity = readSensitivity();

      const next = status.words
        .filter((word) => word.installed && chosen.has(word.id))
        .map((word) => ({
          id: word.id,
          file: word.file,
          label: word.label,
          threshold: sensitivity[word.id] ?? word.threshold,
        }));

      // Replaced only when it actually differs. The signature is what
      // `useWakeWord` keys its effect on, so handing back an equal-but-new
      // array would tear the Worker down and re-fetch three models for nothing.
      setWords((current) => (signature(current) === signature(next)
        ? current
        : next.length > 0 ? next : NONE));
    };

    void refresh();

    // The preference is the fast path; focus covers a download that finished
    // in Settings, since the model appearing on disk is not something the
    // preference layer can announce.
    const stopListening = onWakeSettingsChanged(() => { void refresh(); });
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      stopListening();
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return words;
}
