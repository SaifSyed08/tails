/**
 * The microphone worklet, as source text.
 *
 * ## Why a string and a blob URL
 *
 * `AudioWorklet.addModule` takes a URL, and the worklet runs in its own realm
 * with no bundler around it. Shipping this as a real module means teaching Vite
 * to emit a separate chunk that is never imported normally, and getting the
 * path right in dev, in the built app, and inside Electron's `file`-free
 * loopback origin. A blob URL sidesteps all three and keeps the processor
 * beside the code that uses it.
 *
 * ## Why a worklet at all
 *
 * It runs on the audio rendering thread. The obvious alternative,
 * `ScriptProcessorNode`, is deprecated and runs on the main thread — which in
 * this app is the thread drawing the pet, so dictation would visibly stutter
 * the animation it is supposed to sit next to.
 */

/**
 * Downsamples to 16 kHz mono Int16 and posts ~100 ms chunks.
 *
 * The resample is a plain linear interpolation rather than a windowed filter.
 * Speech energy sits well below the 8 kHz Nyquist limit of the target rate, and
 * whisper's own front end is a mel spectrogram that discards what little
 * aliasing this introduces — a proper polyphase filter would cost more than it
 * could possibly recover.
 */
const PROCESSOR_SOURCE = `
class TailsCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions.targetRate;
    // Fractional read position into the incoming stream, carried across
    // callbacks so the resampled output has no discontinuity at block edges.
    this.cursor = 0;
    this.pending = [];
    this.pendingLength = 0;
    this.chunkSamples = Math.round(this.targetRate / 10);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input yet, or the track ended. Returning true keeps the node alive so
    // capture resumes if the device comes back rather than dying silently.
    if (!channel || channel.length === 0) return true;

    const ratio = sampleRate / this.targetRate;
    const out = [];
    for (let i = this.cursor; i < channel.length; i += ratio) {
      const low = Math.floor(i);
      const frac = i - low;
      const a = channel[low];
      const b = low + 1 < channel.length ? channel[low + 1] : a;
      out.push(a + (b - a) * frac);
    }
    this.cursor = this.cursor + Math.ceil((channel.length - this.cursor) / ratio) * ratio - channel.length;
    if (this.cursor < 0) this.cursor = 0;

    this.pending.push(out);
    this.pendingLength += out.length;
    if (this.pendingLength < this.chunkSamples) return true;

    const merged = new Int16Array(this.pendingLength);
    let at = 0;
    for (const part of this.pending) {
      for (let i = 0; i < part.length; i += 1) {
        const v = Math.max(-1, Math.min(1, part[i]));
        merged[at + i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      at += part.length;
    }
    this.pending = [];
    this.pendingLength = 0;

    // Transferred, not copied: this runs on the audio thread and must not
    // spend time it does not have.
    this.port.postMessage(merged, [merged.buffer]);
    return true;
  }
}

registerProcessor('tails-capture', TailsCaptureProcessor);
`;

let cachedUrl: string | null = null;

/** The worklet's module URL, created once per document. */
export function captureWorkletUrl(): string {
  if (!cachedUrl) {
    cachedUrl = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'text/javascript' }));
  }
  return cachedUrl;
}

export const CAPTURE_PROCESSOR = 'tails-capture';
export const TARGET_SAMPLE_RATE = 16000;
