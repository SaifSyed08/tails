import fs from 'node:fs';
import path from 'node:path';

import { SHARED_MODELS, WAKE_WORDS, wakeDir, type WakeWordId } from '@/modules/voice/wake-word.js';

/**
 * Fetching wake-word models, once, and only when asked.
 *
 * Every byte here arrives because someone pressed a button with the size on
 * it. Nothing is fetched at launch, nothing is fetched by arming a word that
 * is already present, and a failed download leaves no file behind that could
 * be mistaken for a working one.
 *
 * The pretrained weights are **CC-BY-NC-SA** — openWakeWord's code is
 * Apache-2.0 but its models are not. That is why they are downloaded rather
 * than bundled: fetching on the user's own instruction is a different act from
 * redistributing inside an MIT application, and the licence is stated on the
 * toggle that triggers it.
 */

const RELEASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1';

/**
 * Expected sizes, from the release metadata.
 *
 * Used as the completeness check: a truncated download is the failure mode
 * that otherwise presents as a corrupt model and an inscrutable ONNX error.
 */
const SIZES: Record<string, number> = {
  'melspectrogram.onnx': 1_087_958,
  'embedding_model.onnx': 1_326_578,
  'hey_jarvis_v0.1.onnx': 1_271_370,
  'timer_v0.1.onnx': 1_742_475,
};

/** True when the file is present *and* complete. */
export function isPresent(file: string): boolean {
  const expected = SIZES[file];
  try {
    const actual = fs.statSync(path.join(wakeDir(), file)).size;
    return expected ? actual === expected : actual > 0;
  } catch {
    return false;
  }
}

/** Bytes still to fetch before `id` can be armed. Zero when nothing is needed. */
export function bytesNeeded(id: WakeWordId): number {
  const word = WAKE_WORDS.find((candidate) => candidate.id === id);
  if (!word) return 0;

  return [...SHARED_MODELS, word.file]
    .filter((file) => !isPresent(file))
    .reduce((total, file) => total + (SIZES[file] ?? 0), 0);
}

async function fetchOne(file: string): Promise<void> {
  if (isPresent(file)) return;

  const target = path.join(wakeDir(), file);
  const partial = `${target}.partial`;
  fs.mkdirSync(wakeDir(), { recursive: true });

  const response = await fetch(`${RELEASE}/${file}`);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${file} (${response.status})`);
  }

  const handle = await fs.promises.open(partial, 'w');
  let received = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk as Uint8Array);
      await handle.write(buffer);
      received += buffer.length;
    }
  } finally {
    await handle.close();
  }

  const expected = SIZES[file];
  if (expected && received !== expected) {
    await fs.promises.rm(partial, { force: true });
    throw new Error(`${file} downloaded as ${received} bytes, expected ${expected}`);
  }

  // Renamed only once complete, so `isPresent` can never see a half-file.
  await fs.promises.rename(partial, target);
}

const inFlight = new Map<WakeWordId, Promise<void>>();

/**
 * Downloads everything a wake word needs: the two shared graphs and its own.
 *
 * Deduplicated per word, because the settings toggle is a button someone can
 * press twice while nothing visible has happened yet.
 */
export function downloadWakeWord(id: WakeWordId): Promise<void> {
  const existing = inFlight.get(id);
  if (existing) return existing;

  const word = WAKE_WORDS.find((candidate) => candidate.id === id);
  if (!word) return Promise.reject(new Error(`Unknown wake word: ${id}`));

  if (word.source === 'bundled' && !isPresent(word.file)) {
    // Our own model ships with the app; if it is missing it has not been built
    // yet, and there is nowhere honest to fetch it from.
    return Promise.reject(new Error(
      `The "${word.label}" model has not been trained yet — it is not available to download`,
    ));
  }

  const run = (async () => {
    for (const file of SHARED_MODELS) await fetchOne(file);
    await fetchOne(word.file);
  })().finally(() => { inFlight.delete(id); });

  inFlight.set(id, run);
  return run;
}
