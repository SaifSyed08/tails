/**
 * The sounds a pet makes: impacts, and footsteps.
 *
 * Synthesised rather than shipped, for the same reasons as the voice-mode
 * chimes in `voice-chime.ts`: it has to be immediate, it costs no bytes, and it
 * carries no licence. A thud that arrives 80 ms after the bounce reads as a
 * glitch rather than as an impact.
 *
 * ## Off by default, and that is not timidity
 *
 * A sound tied to something the *user* did — pressing a button, saying a wake
 * word — can be on by default, because it only happens when they act. These
 * fire whenever a thrown pet reaches a wall, or wanders across the gutter on
 * his own: bounces and steps nobody thought about and nobody aimed. A noise
 * that happens without being asked for is the kind people disable once and
 * never re-enable, so it starts off and is something to switch on because you
 * want it.
 *
 * One switch for both, because they are one decision — "should the pet be
 * audible" — and splitting it into a toggle per sound is a settings screen
 * growing a row every time somebody adds a noise.
 */

const KEY = 'tails.pets.collisionSound';

/** Off unless explicitly enabled. See the note above. */
export function collisionSoundEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setCollisionSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? '1' : '0');
  } catch {
    // A blocked localStorage costs a preference, not the feature.
  }
}

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
    return context;
  } catch {
    return null;
  }
}

/**
 * A soft, low thud.
 *
 * Noise through a steep lowpass rather than a tone, because an impact has no
 * pitch — a sine at 80 Hz reads as a bass note and a bounce is not musical. The
 * filter sweeping downward is what makes it a thump instead of a click: the
 * brightness leaves faster than the body does, which is how a real knock
 * behaves.
 *
 * `force` is the bounce speed, normalised. It moves loudness and brightness
 * together, so a hard throw sounds like one and a pet drifting into the wall is
 * almost silent — the alternative is every contact sounding identical, which
 * quickly reads as a bug.
 */
export function playCollision(force: number): void {
  const ctx = audio();
  if (!ctx) return;

  const strength = Math.min(1, Math.max(0, force));
  // Below this it is a nudge, not an impact, and a sound would be noise.
  if (strength < 0.08) return;

  const now = ctx.currentTime;
  const duration = 0.13;

  // A short burst of white noise, built once per hit. Cheap at this length,
  // and it avoids keeping a buffer alive for a sound that may never play.
  const frames = Math.ceil(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    // Decaying noise: the tail is the body of the thud.
    samples[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(220 + strength * 520, now);
  filter.frequency.exponentialRampToValueAtTime(90, now + duration);

  const gain = ctx.createGain();
  const peak = 0.05 + strength * 0.09;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peak, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(now);
  source.stop(now + duration + 0.01);
}

/**
 * A footstep.
 *
 * Much quieter and much shorter than a thud, because it happens twenty times a
 * walk and a thud happens once a throw. The same noise-through-a-filter
 * construction, but band-passed rather than lowpassed: a step is a small
 * *scuff* against a surface, and the low body that makes an impact feel heavy is
 * exactly what would make a walk sound like someone moving furniture.
 *
 * `variation` shifts the centre frequency a little per step. Two identical
 * samples in a row read as a loop rather than as legs — the same reason a
 * footstep in a game is never one file.
 */
export function playFootstep(variation = Math.random()): void {
  const ctx = audio();
  if (!ctx) return;

  const now = ctx.currentTime;
  const duration = 0.045;

  const frames = Math.ceil(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    // A sharper decay than the thud's: a scuff stops, it does not resonate.
    samples[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 3;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 0.9;
  filter.frequency.value = 900 + variation * 500;

  const gain = ctx.createGain();
  // A twentieth of the thud's peak. It should be felt as texture under the
  // animation rather than heard as an event.
  gain.gain.setValueAtTime(0.012, now);
  gain.gain.exponentialRampToValueAtTime(0.0005, now + duration);

  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(now);
  source.stop(now + duration + 0.01);
}
