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

/**
 * Our own wake words are trained with **livekit-wakeword**, not openWakeWord.
 *
 * The runtime does not change: livekit's exported classifier takes the same
 * `(1, 16, 96)` embedding stack, from the same frozen melspectrogram and
 * embedding front end, with the same `/10 + 2` scaling. Swapping the trainer
 * swaps one file.
 *
 * Two reasons for it. Its classifier weights are plain Apache-2.0 with no
 * carve-out, where openWakeWord's pretrained heads are CC-BY-NC-SA and cannot
 * be shipped by an MIT app. And its published work targets false accepts,
 * which is the failure mode that decides whether a one-syllable wake word is
 * usable at all.
 *
 * **Their headline "100× fewer false positives" is unverified here.** No
 * pinned openWakeWord baseline, no reproducible artifact. It is directional,
 * and it is written down as directional so nobody later repeats it as a fact
 * this project measured.
 *
 * One correction worth preserving, because an earlier note in this repo got it
 * wrong: the shared mel and embedding graphs were **never** the non-commercial
 * problem. Only the per-word classifier heads are. The front end is
 * Apache-derived in both projects.
 */

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
 * replacing with a measured figure. 0.85 is a starting position, not a result.
 *
 * ## Measured, and the answer is that no threshold works
 *
 * The model is trained and installed. Scored through this app's own chain
 * against synthesised confusables, `tails` peaks at **0.963** — and seven
 * negatives reach or beat it:
 *
 *     tails off   0.982      bales        0.968      tell tales  0.966
 *     tails app   0.979      tail         0.967      tales       0.963
 *                            fails        0.958
 *
 * The ranges do not overlap at the edges; the negatives are *on top*. There is
 * no value of this threshold — not 0.85, not the 0.99 ceiling — that hears the
 * word and not its rhymes, and the two worst offenders are the app's own name
 * in ordinary use.
 *
 * Its own trainer disagrees, and the disagreement is instructive rather than a
 * contradiction: livekit's eval reported **FPPH 0.00, recall 99.4%, optimal
 * threshold 0.50** against 35,584 general-audio negatives. Both numbers are
 * honest. General audio contains almost no rhymes of "tails", so that eval
 * measures the wake word against *noise* and this measures it against
 * *English*. Shipping on the eval alone would have produced a wake word that
 * fires when you say the name of the app.
 *
 * Caveat kept with the number: two synthesised voices, not human speech. That
 * sizes a margin, and there is no margin here to size.
 *
 * It stays installed and selectable because the product owner asked for it
 * knowing this. 0.85 is retained as the least-bad position rather than a
 * defensible one — it rejects the quieter half of the list and nothing else.
 *
 * ## The calibration point, corrected
 *
 * An earlier note here said a near-rhyme of the distinctive phrase "hey jarvis"
 * ("hey harvest") "still scored 0.29 on this machine", offered as reassurance
 * that there was comfortable margin. Re-measured across two voices on identical
 * synthesised audio, it scores **0.190 on one and 0.961 on the other** — the
 * second is a near-certain false accept against `hey_jarvis`'s own 0.5 default.
 *
 * The honest reading, with the caveat stated: synthesised speech is not human
 * speech, and one voice's rendering of "harvest" may sit unusually close to
 * "jarvis". These numbers are reliable for *comparing models on identical
 * audio*, which is what the harness exists for, and should not be read as
 * absolute false-accept rates.
 *
 * What it does establish is that the single figure this threshold was reasoned
 * from was not representative. A distinctive two-word phrase can be pushed to
 * 0.96 by a rhyme, so no amount of phoneme-counting says where a common
 * one-syllable word lands. That has to be measured per phrase, which is why
 * `hey tails` is trained alongside `tails` rather than as a fallback.
 */
export const WAKE_WORDS: readonly WakeWordDefinition[] = [
  { id: 'tails', file: 'tails.onnx', label: 'TAILS', source: 'bundled', threshold: 0.85 },
  /*
    The two-word form, offered alongside rather than instead.

    Six phonemes against four, which clears the reliability floor the bare word
    sits under — but that is an argument, and the point of training both is to
    replace the argument with a number. Listed here so that when the measurement
    comes back the answer is a toggle rather than a release: whichever wins, the
    user can already pick it.

    Its threshold starts at the shared default because a phrase that clears the
    floor does not need the bare word's handicap. Like `tails`, it is a starting
    position until the false-accept run replaces it.
  */
  { id: 'hey_tails', file: 'hey_tails.onnx', label: 'Hey TAILS', source: 'bundled', threshold: 0.93 },
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
    /** Model filename. The renderer needs it: detection runs there. */
    file: string;
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
      file: word.file,
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
