/**
 * The audio side of dictation: framing, the speech gate, and WAV assembly.
 *
 * Everything here is pure and works on plain arrays, because this is the part
 * with rules worth testing — the gate decides when someone stopped talking,
 * and getting that wrong either truncates a sentence or leaves the microphone
 * running after they finished.
 */

/** The rate the model wants. Resampling happens in the renderer's worklet. */
export const SAMPLE_RATE = 16000;

/**
 * Gate frame size, in samples — 20 ms.
 *
 * Short enough that the tail of a sentence is not clipped, long enough that a
 * single glottal pulse or a keyboard click cannot flip the gate on its own.
 */
export const FRAME_SAMPLES = 320;

/**
 * How loud a frame must be, relative to full scale, to count as speech.
 *
 * -45 dBFS sits above the noise floor of a laptop microphone in a quiet room
 * and below normal speech at arm's length. This is the one number most likely
 * to need tuning against a real machine, which is why it is a named constant
 * rather than inline.
 */
export const SPEECH_THRESHOLD_DBFS = -45;

/**
 * Consecutive loud frames before capture is considered to have started.
 *
 * Three frames is 60 ms — long enough to reject a door closing, short enough
 * that the first consonant is not eaten.
 */
export const SPEECH_ONSET_FRAMES = 3;

/**
 * Consecutive quiet frames before an utterance is considered finished.
 *
 * 40 frames is 800 ms. People pause mid-sentence to think; anything much
 * shorter cuts them off, and anything much longer makes the app feel slow at
 * exactly the moment they are waiting for it.
 */
export const SILENCE_HANGOVER_FRAMES = 40;

/**
 * Hard ceiling on a single utterance — 30 seconds.
 *
 * Not arbitrary: Whisper pads every input to a 30-second window, so audio past
 * that point is a second inference pass rather than a longer one. Cutting here
 * keeps the latency the benchmark measured, and a stuck gate can never grow a
 * buffer without bound.
 */
export const MAX_UTTERANCE_SAMPLES = SAMPLE_RATE * 30;

/** Root-mean-square of a frame, in dBFS. Silence returns -Infinity. */
export function frameDbfs(frame: Int16Array): number {
  if (frame.length === 0) return Number.NEGATIVE_INFINITY;

  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] / 32768;
    sum += v * v;
  }

  const rms = Math.sqrt(sum / frame.length);
  return rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
}

export type GateEvent =
  /** Speech began. The utterance buffer is now filling. */
  | { type: 'speech-start' }
  /** Speech ended, with the reason — a natural pause or the length cap. */
  | { type: 'speech-end'; reason: 'silence' | 'max-length' };

/**
 * The energy gate.
 *
 * Deliberately an energy gate and not a neural VAD. whisper.cpp v1.9.2 already
 * carries Silero server-side, so the renderer only needs enough signal to drive
 * the listening indicator and to bracket an utterance — and a client-side
 * Silero would mean pulling `onnxruntime-web` and several megabytes of WASM
 * into the bundle before knowing whether any of it is needed.
 *
 * `feed` is the seam where that swap happens: replace the `frameDbfs` decision
 * with a model's speech probability and nothing else in the pipeline changes.
 */
export class SpeechGate {
  private loud = 0;
  private quiet = 0;
  private speaking = false;
  private held = 0;

  /** True while an utterance is in progress. Drives the "listening" state. */
  get active(): boolean {
    return this.speaking;
  }

  /**
   * Feeds one frame and reports any transition.
   *
   * Returns null for the common case of "nothing changed", so callers can skip
   * work rather than compare states.
   */
  feed(frame: Int16Array): GateEvent | null {
    const speechish = frameDbfs(frame) > SPEECH_THRESHOLD_DBFS;

    if (speechish) {
      this.loud += 1;
      this.quiet = 0;
    } else {
      this.quiet += 1;
      this.loud = 0;
    }

    if (this.speaking) {
      this.held += frame.length;
      // The cap is checked before the silence rule so a continuous noise
      // source ends the utterance instead of holding it open forever.
      if (this.held >= MAX_UTTERANCE_SAMPLES) {
        this.reset();
        return { type: 'speech-end', reason: 'max-length' };
      }
      if (this.quiet >= SILENCE_HANGOVER_FRAMES) {
        this.reset();
        return { type: 'speech-end', reason: 'silence' };
      }
      return null;
    }

    if (this.loud >= SPEECH_ONSET_FRAMES) {
      this.speaking = true;
      this.held = 0;
      this.quiet = 0;
      return { type: 'speech-start' };
    }

    return null;
  }

  /** Returns the gate to its resting state, e.g. when the user presses stop. */
  reset(): void {
    this.loud = 0;
    this.quiet = 0;
    this.speaking = false;
    this.held = 0;
  }
}

/** Splits a sample run into whole frames, discarding any short tail. */
export function toFrames(samples: Int16Array, size = FRAME_SAMPLES): Int16Array[] {
  const frames: Int16Array[] = [];
  for (let offset = 0; offset + size <= samples.length; offset += size) {
    frames.push(samples.subarray(offset, offset + size));
  }
  return frames;
}

/**
 * Wraps raw mono PCM in a 16-bit WAV container.
 *
 * whisper-cli reads files rather than stdin, so an utterance has to become a
 * real file on the way in. Written by hand rather than with a dependency: the
 * canonical 44-byte header is the entire format at this fixed sample rate, and
 * a decoder library would be a supply-chain risk for forty lines of arithmetic.
 */
export function encodeWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }

  return buffer;
}

/**
 * Reads a little-endian Int16 view over bytes that arrived off the wire.
 *
 * `Buffer` pooling means `byteOffset` is rarely zero and is almost never
 * 2-aligned, so a bare `new Int16Array(buf.buffer, ...)` throws or — worse —
 * silently reads a neighbouring allocation. Copying is the correct move here.
 */
export function readPcmFrames(chunk: Buffer): Int16Array {
  const usable = chunk.length - (chunk.length % 2);
  const out = new Int16Array(usable / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = chunk.readInt16LE(i * 2);
  return out;
}
