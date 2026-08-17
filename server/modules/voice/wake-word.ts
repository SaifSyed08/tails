import fs from 'node:fs';
import path from 'node:path';

import { TAILS_HOME } from '@/db/connection.js';
import {
  CHUNK_SAMPLES,
  DetectionGate,
  EmbeddingWindow,
  MEL_CONTEXT_SAMPLES,
  MEL_WINDOW,
  MEL_BINS,
  MelWindow,
  scaleMel,
} from '@/modules/voice/wake-window.js';

/**
 * Always-on wake-word spotting.
 *
 * ## Measured on this machine, because nobody publishes the number
 *
 * openWakeWord's own figures are Raspberry Pi. Running its three ONNX graphs
 * under `onnxruntime-node` on a Ryzen 7 8845HS, single-threaded, costs
 * **1.80% of one core** to listen continuously — 1.44 ms of CPU per 80 ms of
 * audio — in about 75 MB of RSS. Three wake words cost the same as one,
 * because the expensive stages (melspectrogram and embedding) are shared and
 * only the final classifier is per-word.
 *
 * That is cheap enough to leave running. It is still **off by default**: an
 * always-open microphone is the highest-trust-cost thing this app could do, so
 * it is opt-in per wake word rather than something that arrives switched on.
 *
 * ## Licensing, which decides what can ship
 *
 * openWakeWord's *code* is Apache-2.0 but its *pretrained weights* are
 * CC-BY-NC-SA — non-commercial. This app is MIT, so those weights cannot be
 * bundled. A model we train ourselves carries no such restriction. Hence
 * `source`: models are located on disk, never redistributed, and the
 * non-commercial ones must be fetched by the user's own explicit action with
 * the licence stated at the point of enabling.
 */

/** Score above which a frame counts as a detection, before the refractory gate. */
const DEFAULT_THRESHOLD = 0.5;

export type WakeWordId = string;

export type WakeWordDefinition = {
  id: WakeWordId;
  /** File name inside the models directory. */
  file: string;
  label: string;
  /**
   * Where the weights came from, which is a licensing fact rather than trivia.
   *
   * `bundled` is ours to ship. `fetched` is CC-BY-NC-SA and may only arrive by
   * the user asking for it — the UI has to say so where the toggle is.
   */
  source: 'bundled' | 'fetched';
  /**
   * Detection threshold.
   *
   * Per-word because it has to be. Measured here, a near-rhyme of "hey jarvis"
   * still scored 0.29 against a 0.5 threshold — comfortable, but that is a
   * distinctive invented phrase. A common English word has neighbours much
   * closer than that and needs a higher bar.
   */
  threshold: number;
};

/** Where wake-word models live, beside the speech model. */
const wakeDir = (): string => path.join(TAILS_HOME, 'models', 'wake');

/**
 * The three wake words this app offers, each independently switchable.
 *
 * `hey tails` rather than `tails`: measured guidance puts the floor at six
 * phonemes and two syllables, and "tails" is four phonemes and one — it rhymes
 * with fails, sales and tales, and occurs inside ordinary English ("heads or
 * tails"). Adding "hey" clears the floor. Its threshold is set higher than the
 * others for the same reason.
 */
export const WAKE_WORDS: readonly WakeWordDefinition[] = [
  { id: 'hey_tails', file: 'hey_tails.onnx', label: 'Hey TAILS', source: 'bundled', threshold: 0.7 },
  { id: 'hey_jarvis', file: 'hey_jarvis_v0.1.onnx', label: 'Hey Jarvis', source: 'fetched', threshold: 0.5 },
  { id: 'timer', file: 'timer_v0.1.onnx', label: 'Timer', source: 'fetched', threshold: 0.5 },
];

export type WakeWordStatus = {
  /** False when the ONNX runtime is absent — the common case today. */
  runtimePresent: boolean;
  /** False when the shared melspectrogram/embedding models are missing. */
  sharedModelsPresent: boolean;
  reason?: string;
  words: Array<{
    id: WakeWordId;
    label: string;
    installed: boolean;
    /** True for weights we may not redistribute; the UI must say so. */
    nonCommercial: boolean;
  }>;
};

/**
 * What the settings panel needs to render the wake-word toggles.
 *
 * Reports missing pieces as states rather than errors, exactly as
 * `readStatus()` does for dictation: the runtime being absent is a first-class
 * condition of this feature, not a failure. Dictation is unaffected either way.
 */
export async function readWakeWordStatus(): Promise<WakeWordStatus> {
  const runtimePresent = (await loadOrt()) !== null;
  const sharedModelsPresent = ['melspectrogram.onnx', 'embedding_model.onnx']
    .every((f) => fs.existsSync(path.join(wakeDir(), f)));

  const reason = !runtimePresent
    ? 'Wake-word runtime is not installed. Dictation still works.'
    : !sharedModelsPresent
      ? 'Wake-word models are not downloaded yet'
      : undefined;

  return {
    runtimePresent,
    sharedModelsPresent,
    reason,
    words: WAKE_WORDS.map((word) => ({
      id: word.id,
      label: word.label,
      installed: fs.existsSync(path.join(wakeDir(), word.file)),
      nonCommercial: word.source === 'fetched',
    })),
  };
}

type Session = {
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array }>>;
  outputNames: string[];
};

/**
 * The slice of onnxruntime-node this module uses, described structurally.
 *
 * Typed here rather than imported so the server still compiles when the
 * package is absent — which it is by default. Adding a multi-megabyte native
 * runtime to `dependencies` for a feature that ships switched off is a real
 * decision about install weight, and this module is written so that decision
 * can be made separately from the code that needs it.
 */
type Ort = {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
  InferenceSession: {
    create: (modelPath: string, options?: Record<string, unknown>) => Promise<Session>;
  };
};

/** Resolved at runtime so TypeScript does not try to resolve the package. */
const RUNTIME_MODULE = 'onnxruntime-node';

/**
 * `undefined` means "not tried yet", `null` means "tried and unavailable".
 *
 * The same shape `terminal-gateway.ts` uses for node-pty, and for the same
 * reason: a missing optional dependency must degrade to a feature that says it
 * is unavailable, never to a server that refuses to boot. Dictation does not
 * depend on this, so a missing runtime must not take dictation down with it.
 */
let ort: Ort | null | undefined;

async function loadOrt(): Promise<Ort | null> {
  if (ort !== undefined) return ort;
  try {
    ort = (await import(RUNTIME_MODULE)) as Ort;
  } catch {
    ort = null;
  }
  return ort;
}

/** True when the runtime and the shared models are both present. */
export async function wakeWordAvailable(): Promise<boolean> {
  if (!(await loadOrt())) return false;
  return ['melspectrogram.onnx', 'embedding_model.onnx']
    .every((f) => fs.existsSync(path.join(wakeDir(), f)));
}

/** Wake words whose weights are actually on disk. */
export function installedWakeWords(definitions: WakeWordDefinition[]): WakeWordDefinition[] {
  return definitions.filter((d) => fs.existsSync(path.join(wakeDir(), d.file)));
}


/**
 * One listening session over a continuous audio stream.
 *
 * Created only when a wake word is actually armed, and disposed when it is
 * not — there is no dormant instance holding models in memory for a feature
 * that is switched off.
 */
export class WakeWordListener {
  private mel!: Session;
  private embedding!: Session;
  private readonly classifiers = new Map<WakeWordId, Session>();
  private readonly gates = new Map<WakeWordId, DetectionGate>();
  private readonly melWindow = new MelWindow();
  private readonly embeddings = new EmbeddingWindow();
  private context = new Float32Array(MEL_CONTEXT_SAMPLES);
  private runtime!: Ort;

  private constructor(private readonly words: WakeWordDefinition[]) {}

  static async create(words: WakeWordDefinition[]): Promise<WakeWordListener | null> {
    const runtime = await loadOrt();
    if (!runtime || words.length === 0) return null;

    const listener = new WakeWordListener(words);
    listener.runtime = runtime;

    // Single-threaded deliberately: a background listener that grabs every
    // core is precisely the cost this feature must not have.
    const options = { intraOpNumThreads: 1, interOpNumThreads: 1 };
    const open = (file: string) => runtime.InferenceSession.create(
      path.join(wakeDir(), file), options,
    ) as unknown as Promise<Session>;

    try {
      listener.mel = await open('melspectrogram.onnx');
      listener.embedding = await open('embedding_model.onnx');
      for (const word of words) {
        listener.classifiers.set(word.id, await open(word.file));
        listener.gates.set(word.id, new DetectionGate(word.threshold ?? DEFAULT_THRESHOLD));
      }
    } catch {
      return null;
    }

    return listener;
  }

  /**
   * Feeds one 80 ms chunk and returns any wake word that fired.
   *
   * Returns null for the overwhelming majority of calls, which is the point —
   * this runs about twelve times a second for as long as the feature is on.
   */
  async feed(chunk: Int16Array): Promise<WakeWordId | null> {
    if (chunk.length !== CHUNK_SAMPLES) return null;
    const { Tensor } = this.runtime;

    // Carry 480 samples of history, or the STFT loses its edge frames and the
    // models see timing they were not trained on.
    const withContext = new Float32Array(MEL_CONTEXT_SAMPLES + chunk.length);
    withContext.set(this.context, 0);
    for (let i = 0; i < chunk.length; i += 1) {
      withContext[MEL_CONTEXT_SAMPLES + i] = chunk[i] / 32768;
    }
    this.context = withContext.slice(withContext.length - MEL_CONTEXT_SAMPLES);

    const melOut = await this.mel.run({
      input: new Tensor('float32', withContext, [1, withContext.length]),
    });
    this.melWindow.push(scaleMel(melOut[this.mel.outputNames[0]].data));

    for (const window of this.melWindow.drain()) {
      const embOut = await this.embedding.run({
        input_1: new Tensor('float32', window, [1, MEL_WINDOW, MEL_BINS, 1]),
      });
      this.embeddings.push(Float32Array.from(embOut[this.embedding.outputNames[0]].data));

      const stack = this.embeddings.read();
      if (!stack) continue;

      const tensor = new Tensor('float32', stack, [1, 16, 96]);
      for (const word of this.words) {
        const session = this.classifiers.get(word.id);
        const gate = this.gates.get(word.id);
        if (!session || !gate) continue;

        const out = await session.run({ 'x.1': tensor });
        if (gate.accept(out[session.outputNames[0]].data[0])) {
          // A detection ends this stretch of context: the phrase has been
          // consumed, and leaving it in the window would re-fire on the tail.
          this.embeddings.reset();
          return word.id;
        }
      }
    }

    return null;
  }

  /** Drops accumulated context, e.g. when the microphone is closed. */
  reset(): void {
    this.embeddings.reset();
    this.context = new Float32Array(MEL_CONTEXT_SAMPLES);
    for (const gate of this.gates.values()) gate.reset();
  }
}
