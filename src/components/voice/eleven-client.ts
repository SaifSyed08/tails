/**
 * Playing ElevenLabs audio, in order, with one element.
 *
 * The platform synthesiser and Piper both hand back something that manages its
 * own queue. This does not — it is a sequence of HTTP responses that have to be
 * played one after another — so the queue is here.
 *
 * ## One element, reused
 *
 * A new `Audio` per line leaks a decoder per utterance and, on Windows, audibly
 * clicks between them as each one opens the output device. One element, its
 * `src` swapped, is both cheaper and smoother.
 *
 * ## Failure is the caller's cue, not an error
 *
 * `enqueue` rejects when the line could not be fetched or played, because the
 * only useful response is to say it in the local voice instead, and that
 * decision belongs to whoever knows what the local voice is. Nothing here
 * retries: a second attempt at a refused key is a second bill for the same
 * silence.
 */

type Speaker = {
  /** Resolves when the line has finished playing. Rejects if it never started. */
  enqueue: (text: string, voiceId: string, replace: boolean) => Promise<void>;
  stop: () => void;
};

export function createElevenSpeaker(onSpeaking: (speaking: boolean) => void): Speaker {
  const element = typeof Audio === 'undefined' ? null : new Audio();
  /** Everything queued, so a line cannot start before the one before it ends. */
  let chain: Promise<void> = Promise.resolve();
  let current: string | null = null;
  /** Bumped on every stop, so audio already in flight knows it was abandoned. */
  let generation = 0;

  const release = () => {
    if (current) {
      URL.revokeObjectURL(current);
      current = null;
    }
  };

  const stop = () => {
    generation += 1;
    if (element) {
      element.pause();
      element.removeAttribute('src');
    }
    release();
    chain = Promise.resolve();
    onSpeaking(false);
  };

  const play = async (text: string, voiceId: string, mine: number): Promise<void> => {
    if (!element) throw new Error('No audio output.');

    const response = await fetch('/api/voice/elevenlabs/say', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voiceId }),
    });
    if (!response.ok) throw new Error('ElevenLabs refused the line.');
    // Abandoned while the request was in flight. Playing now would be a line
    // from a reply the user has already moved past.
    if (mine !== generation) return;

    const url = URL.createObjectURL(await response.blob());
    release();
    current = url;
    element.src = url;

    onSpeaking(true);
    try {
      await element.play();
      await new Promise<void>((resolve) => {
        const settle = () => {
          element.removeEventListener('ended', settle);
          element.removeEventListener('error', settle);
          resolve();
        };
        element.addEventListener('ended', settle);
        // An error mid-playback resolves rather than rejects: the line was
        // started, so falling back now would repeat half of it in another voice.
        element.addEventListener('error', settle);
      });
    } finally {
      if (mine === generation) onSpeaking(false);
      release();
    }
  };

  return {
    enqueue(text, voiceId, replace) {
      if (replace) stop();
      const mine = generation;

      /*
        Chained, and the chain never rejects.

        Each caller gets a promise that reflects *its* line — so a failed line
        falls back locally — while the chain itself carries on, because one line
        the vendor refused should not silence every line after it.
      */
      const attempt = chain.then(() => play(text, voiceId, mine));
      chain = attempt.catch(() => {});
      return attempt;
    },
    stop,
  };
}
