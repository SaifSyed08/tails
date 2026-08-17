import fs from 'node:fs';
import path from 'node:path';

import { TAILS_HOME } from '@/db/connection.js';

/**
 * What the server knows about wake words: which models exist, and their terms.
 *
 * ## Why there is no inference here
 *
 * Detection runs in the renderer, on `onnxruntime-web` inside a Worker, not on
 * this side. Both were measured on this machine: the native `onnxruntime-node`
 * runtime costs 1.80% of one core against WASM's 5.37%, but it is ~60 MB
 * shipped against ~12.9 MB, it is a native addon, and — the reason that
 * decided it — its install runs a network-capable `postinstall` script inside
 * a feature whose entire premise is that nothing touches the network. 5.4% of
 * one core is 0.34% of this machine, paid only by someone who switched the
 * feature on.
 *
 * Two things followed from measuring rather than assuming. Multi-threaded WASM
 * was *worse* — 9.17% against 5.37% — so no `SharedArrayBuffer` and no
 * cross-origin isolation headers are needed. And the work has to be off the
 * main thread not because 5.4% is large but because it arrives as a 4.29 ms
 * block against a 16.7 ms frame budget, on the thread drawing the pet.
 *
 * So this module locates model files and reports terms. The audio never comes
 * here at all.
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
   * openWakeWord's *code* is Apache-2.0 but its *pretrained weights* are
   * CC-BY-NC-SA — non-commercial. This app is MIT, so those cannot be bundled.
   * A model we train ourselves carries no such restriction. `fetched` weights
   * may only arrive by the user's own explicit action, with the licence stated
   * where the toggle is rather than buried.
   */
  source: 'bundled' | 'fetched';
  /** Starting sensitivity. Higher means fewer accidental triggers. */
  threshold: number;
};

/** Where wake-word models live, beside the speech model. */
export const wakeDir = (): string => path.join(TAILS_HOME, 'models', 'wake');

/** The two graphs every wake word shares. */
export const SHARED_MODELS = ['melspectrogram.onnx', 'embedding_model.onnx'] as const;

/**
 * How far a threshold may be moved from settings.
 *
 * A sensitivity control exists because one of these phrases sits below the
 * published reliability floor (see `tails` below). Turning "it keeps firing"
 * into a slider is the honest response to shipping it. The floor of 0.3 is low
 * enough to be useful in a quiet room; below that the classifier's own noise
 * dominates and the control stops meaning anything.
 */
export const MIN_THRESHOLD = 0.3;
export const MAX_THRESHOLD = 0.99;

/**
 * The three wake words this app offers, each independently switchable.
 *
 * ## `tails` is a deliberate choice made against the evidence
 *
 * Published guidance puts the floor at six phonemes and two syllables. "tails"
 * is four phonemes and one syllable; it rhymes with *fails, sales, tales,
 * bales*, sits inside "heads or tails" and "tails off", and — the case that
 * will actually bite — is the app's own name, which the user says aloud
 * constantly while using the app. "hey tails" would clear the floor and was
 * recommended; the product owner chose the bare word knowingly, because it is
 * the name and the feel of saying it matters more to him than the margin.
 *
 * So it ships with mitigations rather than an argument. Its threshold starts
 * far above the others, and it is the one word whose value most needs
 * replacing with a measured figure: the calibration point available today is
 * that a near-rhyme of the *distinctive* phrase "hey jarvis" still scored 0.29
 * on this machine, so rhymes of a common word will sit much higher. 0.85 is a
 * starting position, not a result — it must be re-derived from a false-accept
 * run against those confusables before this is enabled by default.
 */
export const WAKE_WORDS: readonly WakeWordDefinition[] = [
  { id: 'tails', file: 'tails.onnx', label: 'TAILS', source: 'bundled', threshold: 0.85 },
  { id: 'hey_jarvis', file: 'hey_jarvis_v0.1.onnx', label: 'Hey Jarvis', source: 'fetched', threshold: 0.5 },
  { id: 'timer', file: 'timer_v0.1.onnx', label: 'Timer', source: 'fetched', threshold: 0.5 },
];

/** Keeps a value from settings inside the range the classifier can act on. */
export function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_THRESHOLD;
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, value));
}

export type WakeWordStatus = {
  /** False when the shared melspectrogram/embedding models are missing. */
  sharedModelsPresent: boolean;
  reason?: string;
  /** Bounds for the sensitivity control, so the UI cannot offer what is refused. */
  thresholdRange: { min: number; max: number };
  words: Array<{
    id: WakeWordId;
    label: string;
    installed: boolean;
    /** True for weights we may not redistribute; the UI must say so. */
    nonCommercial: boolean;
    threshold: number;
    /**
     * True when the phrase is known to be harder to detect reliably.
     *
     * Surfaced so the settings panel can say which words fire by accident more
     * often. Not a nudge away from a choice already made — a fact that belongs
     * at the point of choosing.
     */
    belowPhraseFloor: boolean;
  }>;
};

/**
 * What the settings panel needs to render the wake-word toggles.
 *
 * Reports missing pieces as states rather than errors, exactly as
 * `readStatus()` does for dictation. Dictation does not depend on any of this,
 * and a missing wake-word model must never make dictation look broken.
 */
export function readWakeWordStatus(): WakeWordStatus {
  const sharedModelsPresent = SHARED_MODELS
    .every((file) => fs.existsSync(path.join(wakeDir(), file)));

  return {
    sharedModelsPresent,
    reason: sharedModelsPresent ? undefined : 'Wake-word models are not downloaded yet',
    thresholdRange: { min: MIN_THRESHOLD, max: MAX_THRESHOLD },
    words: WAKE_WORDS.map((word) => ({
      id: word.id,
      label: word.label,
      installed: fs.existsSync(path.join(wakeDir(), word.file)),
      nonCommercial: word.source === 'fetched',
      threshold: word.threshold,
      // One syllable and four phonemes, against a published floor of two and
      // six. Reported rather than inferred so the copy does not have to guess.
      belowPhraseFloor: word.id === 'tails',
    })),
  };
}

/**
 * Resolves a model file for serving to the renderer.
 *
 * Returns null for anything not on the known list. The renderer asks for these
 * by name, so this must never become a way to read an arbitrary path — the
 * allow-list is the check, not the string itself.
 */
export function resolveWakeModel(file: string): string | null {
  const known = [...SHARED_MODELS, ...WAKE_WORDS.map((word) => word.file)];
  if (!known.includes(file)) return null;

  const full = path.join(wakeDir(), file);
  return fs.existsSync(full) ? full : null;
}
