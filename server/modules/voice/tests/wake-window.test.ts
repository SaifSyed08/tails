import assert from 'node:assert/strict';
import test from 'node:test';

import { WORKLET_CHUNK_SAMPLES } from '../../../../src/components/voice/capture-worklet.js';
import {
  CHUNK_SAMPLES,
  ChunkQueue,
  DetectionGate,
  EMBEDDING_SIZE,
  EMBEDDING_WINDOW,
  EmbeddingWindow,
  FRAMES_PER_CHUNK,
  MEL_BINS,
  MEL_HOP,
  MEL_WINDOW,
  MelWindow,
  scaleMel,
  WARMUP_SAMPLES,
} from '../../../../src/components/voice/wake-window.js';
import { bytesNeeded } from '@/modules/voice/wake-download.js';
import { clampThreshold, MAX_THRESHOLD, MIN_THRESHOLD, WAKE_WORDS } from '@/modules/voice/wake-word.js';

const chunkOfFrames = (n: number, fill = 1) => Float32Array.from(
  { length: n * MEL_BINS },
  (_, i) => fill + i / 10000,
);

/**
 * PCM whose value is its own position in the stream.
 *
 * Wrapped into Int16 range so the sample at absolute index `i` is always
 * `(i % 4096) - 2048`. That makes one comparison check three things at once:
 * that nothing was dropped, that nothing was duplicated, and that order held.
 */
const ramp = (length: number, from: number) => Int16Array.from(
  { length },
  (_, i) => ((from + i) % 4096) - 2048,
);

test('mel scaling matches the transform the embedding model was trained on', () => {
  // Omitting this is the classic silent failure: the chain runs and never fires.
  assert.deepEqual(Array.from(scaleMel(Float32Array.from([0, 10, -20]))), [2, 3, 0]);
});

test('no embedding window exists until 76 mel frames have arrived', () => {
  const mel = new MelWindow();
  mel.push(chunkOfFrames(MEL_WINDOW - 1));
  assert.deepEqual(mel.drain(), []);

  mel.push(chunkOfFrames(1));
  assert.equal(mel.drain().length, 1);
});

test('each window is the full size the embedding model expects', () => {
  const mel = new MelWindow();
  mel.push(chunkOfFrames(MEL_WINDOW));
  assert.equal(mel.drain()[0].length, MEL_WINDOW * MEL_BINS);
});

test('windows advance by the hop, not by a whole window', () => {
  const mel = new MelWindow();
  // Two hops past the first full window should yield three windows in total.
  mel.push(chunkOfFrames(MEL_WINDOW + MEL_HOP * 2));
  assert.equal(mel.drain().length, 3);
  assert.equal(mel.pending, MEL_WINDOW - MEL_HOP);
});

test('the buffer does not grow without bound while listening', () => {
  const mel = new MelWindow();
  for (let i = 0; i < 500; i += 1) {
    mel.push(chunkOfFrames(FRAMES_PER_CHUNK));
    mel.drain();
  }
  // Whatever is retained must be less than one window, or nothing is draining.
  assert.ok(mel.pending < MEL_WINDOW, `retained ${mel.pending} frames`);
});

test('the classifier gets nothing until it has a full embedding window', () => {
  const window = new EmbeddingWindow();
  for (let i = 0; i < EMBEDDING_WINDOW - 1; i += 1) {
    window.push(new Float32Array(EMBEDDING_SIZE).fill(i));
    assert.equal(window.ready, false);
    assert.equal(window.read(), null);
  }

  window.push(new Float32Array(EMBEDDING_SIZE).fill(99));
  assert.equal(window.ready, true);
  assert.equal(window.read()?.length, EMBEDDING_WINDOW * EMBEDDING_SIZE);
});

test('the ring is read oldest-first, not in storage order', () => {
  const window = new EmbeddingWindow();
  // Overfill so the write cursor has wrapped, which is where storage order and
  // chronological order diverge — a sequence model given the wrong order is
  // subtly wrong rather than obviously broken.
  for (let i = 0; i < EMBEDDING_WINDOW + 5; i += 1) {
    window.push(new Float32Array(EMBEDDING_SIZE).fill(i));
  }

  const read = window.read();
  assert.ok(read);
  for (let i = 0; i < EMBEDDING_WINDOW; i += 1) {
    const expected = i + 5;
    assert.equal(read[i * EMBEDDING_SIZE], expected, `slot ${i} out of order`);
  }
});

test('resetting clears the context so a new session cannot inherit the old one', () => {
  const window = new EmbeddingWindow();
  for (let i = 0; i < EMBEDDING_WINDOW; i += 1) window.push(new Float32Array(EMBEDDING_SIZE).fill(1));
  window.reset();
  assert.equal(window.ready, false);
});

test('the documented warm-up is about two seconds of audio', () => {
  const seconds = WARMUP_SAMPLES / 16000;
  assert.ok(seconds > 1.8 && seconds < 2.4, `warm-up was ${seconds.toFixed(2)}s`);
  assert.equal(WARMUP_SAMPLES % CHUNK_SAMPLES, 0, 'should be a whole number of chunks');
});

test('one spoken phrase produces one detection, not one per frame', () => {
  const gate = new DetectionGate(0.5, 25);
  // A real detection stays above threshold for several consecutive scores.
  const fired = [0.9, 0.95, 0.97, 0.8, 0.6].filter((s) => gate.accept(s));
  assert.equal(fired.length, 1);
});

test('a second phrase after the refractory period is detected again', () => {
  const gate = new DetectionGate(0.5, 3);
  assert.equal(gate.accept(0.9), true);
  for (let i = 0; i < 3; i += 1) gate.accept(0.0);
  assert.equal(gate.accept(0.9), true);
});

test('scores below the threshold never fire', () => {
  const gate = new DetectionGate(0.5);
  for (const score of [0, 0.1, 0.49]) assert.equal(gate.accept(score), false);
});

test('a raised threshold is respected, which is how a common word gets tuned', () => {
  const strict = new DetectionGate(0.95);
  assert.equal(strict.accept(0.9), false);
  assert.equal(strict.accept(0.96), true);
});

test('a sensitivity value from settings is clamped into a usable range', () => {
  // A stored value from an older build, or a slider dragged to an extreme,
  // must never be able to disable detection or make it fire on silence.
  assert.equal(clampThreshold(0.85), 0.85);
  assert.equal(clampThreshold(0), MIN_THRESHOLD);
  assert.equal(clampThreshold(5), MAX_THRESHOLD);
  assert.equal(clampThreshold(Number.NaN), 0.5);
});

test('the phrase chosen against the reliability floor is flagged as such', () => {
  const tails = WAKE_WORDS.find((word) => word.id === 'tails');
  const jarvis = WAKE_WORDS.find((word) => word.id === 'hey_jarvis');

  assert.ok(tails && jarvis);
  // It ships, but it ships stricter than the phrases that clear the floor.
  assert.ok(tails.threshold > jarvis.threshold, 'tails should start stricter');
  assert.equal(tails.source, 'bundled', 'our own model carries no licence limit');
  assert.equal(jarvis.source, 'fetched', 'pretrained weights are non-commercial');
});

/*
 * The producer/consumer size mismatch that made the wake word inert.
 *
 * The capture worklet posts blocks sized from `TARGET_SAMPLE_RATE`; the models
 * want `CHUNK_SAMPLES`. Those two numbers were never equal and the worker
 * required equality, so every chunk was dropped and nothing ever fired. These
 * tests pin the queue that reconciles them — and, deliberately, read the
 * worklet's own constant rather than a copy of it, so a change on either side
 * is caught here instead of turning into silence again.
 */
test('the microphone block size does not match what the models want', () => {
  // Not an assertion about correctness — an assertion that the gap is real, so
  // nobody removes the queue on the assumption that the sizes agree.
  assert.notEqual(WORKLET_CHUNK_SAMPLES, CHUNK_SAMPLES);
});

test('audio posted at the worklet size comes out at the model size', () => {
  const queue = new ChunkQueue();
  const chunks = queue.push(ramp(WORKLET_CHUNK_SAMPLES, 0));

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, CHUNK_SAMPLES);
  assert.equal(queue.pending, WORKLET_CHUNK_SAMPLES - CHUNK_SAMPLES);
});

test('no sample is dropped, duplicated or reordered across many blocks', () => {
  const queue = new ChunkQueue();
  const out: number[] = [];
  let written = 0;

  // Twenty blocks, alternating length, because the worklet's own output is not
  // a constant either — it flushes whatever has accumulated past its threshold.
  for (let i = 0; i < 20; i += 1) {
    const size = WORKLET_CHUNK_SAMPLES + (i % 2 === 0 ? 0 : 43);
    for (const chunk of queue.push(ramp(size, written))) out.push(...chunk);
    written += size;
  }

  assert.equal(out.length % CHUNK_SAMPLES, 0);
  assert.equal(out.length + queue.pending, written);
  // The ramp is its own index, so this checks order and identity at once.
  for (let i = 0; i < out.length; i += 1) assert.equal(out[i], (i % 4096) - 2048);
});

test('a block smaller than one chunk yields nothing and is not lost', () => {
  const queue = new ChunkQueue();
  assert.deepEqual(queue.push(ramp(100, 0)), []);
  assert.equal(queue.pending, 100);

  const chunks = queue.push(ramp(CHUNK_SAMPLES, 100));
  assert.equal(chunks.length, 1);
  assert.equal(queue.pending, 100);
});

test('reset drops the carry, so a re-arm does not splice two sessions together', () => {
  const queue = new ChunkQueue();
  queue.push(ramp(500, 0));
  queue.reset();
  assert.equal(queue.pending, 0);
});

test('our own phrases are bundled, and never offered as a download', () => {
  /*
    `tails` and `hey_tails` are trained here, so their weights carry no licence
    restriction and there is nowhere to fetch them from. openWakeWord's are the
    opposite on both counts. Conflating them would either offer a download that
    404s, or present CC-BY-NC-SA weights as though they were ours.
  */
  const ours = WAKE_WORDS.filter((word) => word.source === 'bundled');
  assert.deepEqual(ours.map((word) => word.id).sort(), ['hey_tails', 'tails']);

  for (const word of ours) {
    assert.equal(bytesNeeded(word.id), 0, `${word.id} must not be downloadable`);
  }

  // And the fetched ones must still declare themselves non-commercial, which is
  // what the settings panel renders the warning from.
  for (const word of WAKE_WORDS.filter((entry) => entry.source === 'fetched')) {
    assert.notEqual(bytesNeeded(word.id), undefined);
  }
});

test('the two-word form does not inherit the bare word handicap', () => {
  const bare = WAKE_WORDS.find((word) => word.id === 'tails');
  const two = WAKE_WORDS.find((word) => word.id === 'hey_tails');
  assert.ok(bare && two);

  // Six phonemes against four. It starts at the ordinary default because it
  // clears the floor the bare word sits under — both are placeholders until
  // the false-accept run, but they are not the *same* placeholder.
  assert.ok(two.threshold < bare.threshold);
});
