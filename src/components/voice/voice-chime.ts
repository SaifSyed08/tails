/**
 * The sounds voice mode makes, synthesised rather than shipped.
 *
 * ## Why no audio files
 *
 * Three reasons, in the order they matter. A wake-word chime has to be *short*
 * and *immediate* — it confirms that the app heard you, so arriving 80 ms late
 * because a file was still decoding defeats the entire point, and an oscillator
 * starts on the sample. It costs no bytes in a bundle that already asks the
 * user to download 78 MB of model. And it carries no licence, which for a
 * project that has already had to abandon two dependencies over licensing is
 * not a small consideration.
 *
 * ## Why it is this quiet
 *
 * The gain envelopes below peak at 0.05–0.07. This plays every single time the
 * wake word fires, in a room where somebody is talking, and a confirmation
 * sound that makes you flinch is one you will turn off within the hour. It
 * should sit under the voice rather than over it: noticed, not announced.
 */

let context: AudioContext | null = null;

/**
 * The shared context, created on first use.
 *
 * Lazily, because constructing an `AudioContext` before any user gesture leaves
 * it suspended and browsers log about it — and because someone who never turns
 * voice mode on should never have an audio graph at all.
 */
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    context ??= new AudioContext();
    // A context created before the first gesture starts suspended. Resuming is
    // a no-op once it is already running.
    if (context.state === 'suspended') void context.resume();
    return context;
  } catch {
    return null;
  }
}

type Blip = {
  /** Hz. */
  frequency: number;
  /** Seconds from the start of the sound. */
  at: number;
  duration: number;
  peak: number;
};

/**
 * Plays a short sequence of pure tones.
 *
 * Each blip gets its own gain envelope with a real attack and release. A bare
 * `start`/`stop` on an oscillator produces a click at both ends — the waveform
 * is cut mid-cycle, which is a step change, which is broadband noise. The 8 ms
 * ramps are what make this a tone rather than a tick.
 */
function play(blips: Blip[]): void {
  const ctx = audio();
  if (!ctx) return;

  const now = ctx.currentTime;
  for (const blip of blips) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    // A triangle rather than a sine: it carries a little odd-harmonic content,
    // which survives small laptop speakers where a pure sine mostly does not.
    oscillator.type = 'triangle';
    oscillator.frequency.value = blip.frequency;

    const start = now + blip.at;
    const end = start + blip.duration;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(blip.peak, start + 0.008);
    gain.gain.setValueAtTime(blip.peak, end - 0.03);
    gain.gain.linearRampToValueAtTime(0, end);

    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.01);
  }
}

/**
 * Voice mode is now listening for the wake word.
 *
 * A single mid tone. Deliberately the least eventful of the three: this fires
 * when the user pressed a menu item, so they already know what happened.
 */
export function chimeArmed(): void {
  play([{ frequency: 587.33, at: 0, duration: 0.1, peak: 0.05 }]);
}

/**
 * The wake word was heard.
 *
 * Two tones rising a fifth, overlapping slightly so they read as one gesture
 * rather than two beeps. This is the one that has to be unmistakable — it is
 * the app saying *go ahead* — so it is the brightest and the only one that
 * moves.
 */
export function chimeWake(): void {
  play([
    { frequency: 659.25, at: 0, duration: 0.075, peak: 0.06 },
    { frequency: 987.77, at: 0.06, duration: 0.11, peak: 0.07 },
  ]);
}

/** Voice mode is off. The rising pair, reversed. */
export function chimeOff(): void {
  play([
    { frequency: 587.33, at: 0, duration: 0.07, peak: 0.045 },
    { frequency: 392.0, at: 0.055, duration: 0.1, peak: 0.05 },
  ]);
}
