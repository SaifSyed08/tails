/**
 * The renderer's half of Piper: ask the server for audio, then play it in order.
 *
 * ## Why a queue and not just `audio.play()`
 *
 * A reply arrives in pieces while the rest is still streaming, so pieces are
 * handed over faster than they play. Without a queue the second chunk cuts off
 * the first and a four-sentence answer is heard as its last sentence — which is
 * the same bug `useSpeech` already had to solve for the platform synthesiser,
 * arriving again by a different route because a fresh `Audio` has no idea
 * another one is talking.
 *
 * ## Why one request per chunk and not per sentence
 *
 * Each request spawns a `piper.exe` that loads a 63 MB voice, measured at about
 * 1.5 s warm. Splitting a chunk into sentences would pay that per sentence and
 * turn a comfortable 1.7x realtime into something slower than speech. The
 * chunking that matters already happened upstream in `stream-speech.ts`; this
 * layer must not undo it.
 */

export type PiperVoice = {
  id: string;
  label: string;
  installed: boolean;
  downloadMiB: number;
};

export type PiperStatus = {
  ready: boolean;
  reason?: string;
  enginePresent: boolean;
  installed: string[];
  defaultVoice: string;
  voices: PiperVoice[];
};

/** Null when the server cannot be reached, which is not the same as not ready. */
export async function readPiperStatus(): Promise<PiperStatus | null> {
  try {
    const response = await fetch('/api/voice/speech', { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    return await response.json() as PiperStatus;
  } catch {
    return null;
  }
}

export async function downloadPiperVoice(id: string): Promise<void> {
  const response = await fetch(`/api/voice/speech/voice/${encodeURIComponent(id)}/download`, {
    method: 'POST',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? 'That voice could not be downloaded.');
  }
}

async function synthesise(text: string, voice?: string): Promise<Blob> {
  const response = await fetch('/api/voice/speech/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...(voice ? { voice } : {}) }),
  });
  if (!response.ok) throw new Error(`Speech failed (${response.status})`);
  return response.blob();
}

/**
 * A sequential player for synthesised audio.
 *
 * Owns two things that are easy to get wrong separately and impossible to get
 * right separately: the order clips play in, and the lifetime of their object
 * URLs. A URL revoked too early plays silence; one never revoked leaks the
 * whole reply's audio for as long as the app is open.
 */
export class PiperSpeaker {
  private queue: string[] = [];
  private element: HTMLAudioElement | null = null;
  /**
   * Bumped by `stop`, checked by every in-flight synthesis before it enqueues.
   *
   * Synthesis is a round trip, so a chunk requested before the user pressed
   * stop can arrive after it. Without this the reply they silenced starts
   * talking again a second later, which reads as the app ignoring them.
   */
  private generation = 0;
  private speaking = false;

  constructor(private readonly onSpeakingChange: (speaking: boolean) => void) {}

  /** Synthesises and queues. Resolves when queued, not when finished playing. */
  async enqueue(text: string, voice?: string): Promise<void> {
    const mine = this.generation;
    const blob = await synthesise(text, voice);
    if (mine !== this.generation) return;

    this.queue.push(URL.createObjectURL(blob));
    if (!this.speaking) this.playNext();
  }

  /** Everything stops now, including work that has not come back yet. */
  stop(): void {
    this.generation += 1;

    if (this.element) {
      this.element.pause();
      URL.revokeObjectURL(this.element.src);
      this.element = null;
    }
    for (const url of this.queue) URL.revokeObjectURL(url);
    this.queue = [];

    if (this.speaking) {
      this.speaking = false;
      this.onSpeakingChange(false);
    }
  }

  private playNext(): void {
    const url = this.queue.shift();
    if (!url) {
      if (this.speaking) {
        this.speaking = false;
        this.onSpeakingChange(false);
      }
      this.element = null;
      return;
    }

    if (!this.speaking) {
      this.speaking = true;
      this.onSpeakingChange(true);
    }

    const audio = new Audio(url);
    this.element = audio;

    const advance = () => {
      URL.revokeObjectURL(url);
      if (this.element === audio) this.playNext();
    };

    audio.addEventListener('ended', advance, { once: true });
    // A clip that fails must not stall the rest of the reply behind it.
    audio.addEventListener('error', advance, { once: true });

    void audio.play().catch(advance);
  }
}
