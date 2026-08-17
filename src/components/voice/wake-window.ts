/**
 * The buffering rules of the wake-word chain, without the models.
 *
 * openWakeWord is three ONNX graphs in a row, and almost all of the difficulty
 * is in how audio is fed between them rather than in the graphs themselves:
 *
 *   16 kHz audio --[melspectrogram]--> mel frames (5 per 80 ms chunk)
 *   76 mel frames --[embedding]------> one 96-value embedding, hopping 8 frames
 *   16 embeddings --[classifier]-----> one score per wake word
 *
 * The consequence that is easy to get wrong, and which cost a debugging round
 * when this was first measured: **the classifier cannot produce any score at
 * all until roughly two seconds of audio have been seen** — 76 frames to fill
 * the first embedding window, then fifteen more hops of 8 frames. A clip
 * shorter than that scores nothing, which is indistinguishable from scoring
 * zero unless you know to look. Encoded here so it is a tested rule rather
 * than folklore.
 */

/** Mel frames the embedding model consumes per inference. */
export const MEL_WINDOW = 76;

/** Mel frames advanced between embeddings — 80 ms at a 10 ms hop. */
export const MEL_HOP = 8;

/** Embeddings the classifier consumes per score. */
export const EMBEDDING_WINDOW = 16;

/** Values in one embedding vector. */
export const EMBEDDING_SIZE = 96;

/** Values in one mel frame. */
export const MEL_BINS = 32;

/** Audio samples in one chunk — 80 ms at 16 kHz. */
export const CHUNK_SAMPLES = 1280;

/**
 * Extra preceding audio handed to the melspectrogram graph with each chunk.
 *
 * Measured, not guessed, and it matters more than it looks. The mel hop is 160
 * samples, so 1280 samples of audio *should* yield 8 frames — but feeding the
 * graph a bare 1280-sample chunk yields only **5**, because the STFT has no
 * history at the chunk boundary and the edge frames are lost. Feeding
 * 1280 + 480 yields exactly 8.
 *
 * Getting this wrong does not break detection; it silently stretches the
 * warm-up from 2.0 s to 3.2 s and shifts every frame's timing away from what
 * the models were trained on. The reference implementation carries the same
 * 480-sample overlap for the same reason.
 */
export const MEL_CONTEXT_SAMPLES = 480;

/** Mel frames produced per chunk, given the overlap above. */
export const FRAMES_PER_CHUNK = 8;

/**
 * The audio needed before the first score can exist, in samples.
 *
 * Exposed because a caller feeding it fixed-length clips needs to pad them,
 * and because it is the number that makes a silent pipeline explicable.
 */
export const WARMUP_SAMPLES = Math.ceil(
  (MEL_WINDOW + (EMBEDDING_WINDOW - 1) * MEL_HOP) / FRAMES_PER_CHUNK,
) * CHUNK_SAMPLES;

/**
 * Re-cuts arriving audio into exactly `CHUNK_SAMPLES` blocks.
 *
 * ## Why this exists, which is a bug worth not repeating
 *
 * The capture worklet posts ~100 ms blocks, because 100 ms is a sensible unit
 * for a microphone. The wake-word chain needs 80 ms, because 80 ms is what the
 * models were trained on. Those two numbers have no reason to agree, and they
 * did not: the worker began `if (pcm.length !== CHUNK_SAMPLES) return`, so
 * **every chunk was silently dropped and no wake word could ever fire**. There
 * was no error, no log and no partial behaviour — the feature simply did
 * nothing, which is why it survived so long.
 *
 * The guard was not wrong to want fixed-size input; it was wrong to make the
 * producer's block size part of the consumer's contract. This queue is the
 * seam: audio may arrive in any size, in blocks that vary from call to call,
 * and what comes out is always the length the graphs require, in order, with
 * nothing dropped and nothing duplicated.
 */
export class ChunkQueue {
  private held = new Int16Array(0);

  /**
   * Adds audio and returns every whole chunk now available.
   *
   * Usually one, occasionally two, sometimes none — a 100 ms producer feeding
   * an 80 ms consumer runs a 20 ms surplus that pays for an extra chunk every
   * fourth call. The remainder is carried, which is the whole point: dropping
   * it would lose a fifth of the audio and detection would degrade in a way
   * that looks like a bad model rather than a bad buffer.
   */
  push(pcm: Int16Array): Int16Array[] {
    const joined = new Int16Array(this.held.length + pcm.length);
    joined.set(this.held, 0);
    joined.set(pcm, this.held.length);

    const chunks: Int16Array[] = [];
    let at = 0;
    while (at + CHUNK_SAMPLES <= joined.length) {
      // Copied rather than sub-viewed: these are handed to a tensor that
      // outlives this call, and a view would keep the whole joined buffer
      // alive behind it.
      chunks.push(joined.slice(at, at + CHUNK_SAMPLES));
      at += CHUNK_SAMPLES;
    }

    this.held = joined.slice(at);
    return chunks;
  }

  /** Samples carried over, waiting for the rest of their chunk. */
  get pending(): number {
    return this.held.length;
  }

  reset(): void {
    this.held = new Int16Array(0);
  }
}

/**
 * openWakeWord's mel scaling, applied between the first two graphs.
 *
 * Not cosmetic: the embedding model was trained on this distribution, and
 * without it the classifier sees the wrong input range and silently never
 * fires. It is a single line in the reference implementation and the easiest
 * thing in the pipeline to omit.
 */
export function scaleMel(raw: Float32Array): Float32Array {
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] / 10 + 2;
  return out;
}

/**
 * Accumulates mel frames and hands out embedding-sized windows.
 *
 * Holds only what the next window needs — an always-on listener must not grow
 * a buffer for the lifetime of the process.
 */
export class MelWindow {
  private frames: Float32Array[] = [];

  /** Appends the frames from one chunk, given as a flat scaled array. */
  push(flat: Float32Array): void {
    for (let at = 0; at + MEL_BINS <= flat.length; at += MEL_BINS) {
      this.frames.push(flat.subarray(at, at + MEL_BINS));
    }
  }

  /** Pulls every complete window now available, advancing by the hop. */
  drain(): Float32Array[] {
    const windows: Float32Array[] = [];
    while (this.frames.length >= MEL_WINDOW) {
      const window = new Float32Array(MEL_WINDOW * MEL_BINS);
      for (let i = 0; i < MEL_WINDOW; i += 1) window.set(this.frames[i], i * MEL_BINS);
      windows.push(window);
      this.frames.splice(0, MEL_HOP);
    }
    return windows;
  }

  get pending(): number {
    return this.frames.length;
  }
}

/**
 * Keeps the last `EMBEDDING_WINDOW` embeddings as a classifier-ready tensor.
 *
 * A plain ring rather than an array that grows and shifts: this runs forever,
 * so the allocation has to be bounded and constant.
 */
export class EmbeddingWindow {
  private readonly ring = new Float32Array(EMBEDDING_WINDOW * EMBEDDING_SIZE);
  private count = 0;
  private next = 0;

  push(embedding: Float32Array): void {
    this.ring.set(embedding, this.next * EMBEDDING_SIZE);
    this.next = (this.next + 1) % EMBEDDING_WINDOW;
    if (this.count < EMBEDDING_WINDOW) this.count += 1;
  }

  /** True once there is enough context for the classifier to mean anything. */
  get ready(): boolean {
    return this.count === EMBEDDING_WINDOW;
  }

  /**
   * The window in chronological order, or null while still filling.
   *
   * Order matters — the classifier is a sequence model, and handing it the ring
   * in storage order would present the oldest embedding in the middle.
   */
  read(): Float32Array | null {
    if (!this.ready) return null;
    const out = new Float32Array(EMBEDDING_WINDOW * EMBEDDING_SIZE);
    for (let i = 0; i < EMBEDDING_WINDOW; i += 1) {
      const from = ((this.next + i) % EMBEDDING_WINDOW) * EMBEDDING_SIZE;
      out.set(this.ring.subarray(from, from + EMBEDDING_SIZE), i * EMBEDDING_SIZE);
    }
    return out;
  }

  reset(): void {
    this.count = 0;
    this.next = 0;
    this.ring.fill(0);
  }
}

/**
 * Decides whether a score counts as a detection.
 *
 * A bare threshold fires repeatedly across the two or three consecutive frames
 * a single spoken phrase occupies, so a refractory period is part of the rule
 * rather than something the caller is expected to remember. 0.5 is
 * openWakeWord's own default; it is exposed because the right value depends on
 * the phrase, and a common English word will need a higher one.
 */
export class DetectionGate {
  private cooling = 0;

  constructor(
    private readonly threshold = 0.5,
    private readonly refractoryScores = 25,
  ) {}

  /** Returns true exactly once per detection event. */
  accept(score: number): boolean {
    if (this.cooling > 0) {
      this.cooling -= 1;
      return false;
    }
    if (score < this.threshold) return false;
    this.cooling = this.refractoryScores;
    return true;
  }

  reset(): void {
    this.cooling = 0;
  }
}
