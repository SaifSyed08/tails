import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * The wake-word Worker must not assume things about models it did not train.
 *
 * This file has now produced the same failure three times, and each one looked
 * identical from outside: a wake word switched on in Settings, reported as
 * installed, with every visible signal correct and no detection ever.
 *
 *   1. The chunk size. The worker required exactly 1280 samples and the
 *      microphone posts ~1600, so every chunk was dropped.
 *   2. The classifier input name. Hardcoded to `x.1`, which is what PyTorch's
 *      tracer calls an unnamed input and therefore what openWakeWord's
 *      pretrained heads carry — livekit-wakeword's exporter names it
 *      `embeddings`, so a model we trained ourselves would throw on every
 *      frame.
 *   3. (reserved for the next one, which is the point of this file)
 *
 * The common cause is a literal standing in for something the model can be
 * asked about. So this asserts the *shape* of the code rather than a specific
 * value: the classifier is invoked with a name read from the session.
 *
 * The two shared graphs are deliberately exempt. `melspectrogram.onnx` and
 * `embedding_model.onnx` are frozen and byte-identical across both projects —
 * their names cannot drift, and pinning them documents that they are fixed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(
  HERE, '..', '..', '..', '..', 'src', 'components', 'voice', 'wake-worker.ts',
);

const source = (): string => fs.readFileSync(WORKER, 'utf8');

/**
 * The file with its comments removed.
 *
 * These assertions are about what the code *does*, and the first version of
 * this test could not tell the difference — it failed on the comment that
 * explains why `x.1` must not be used, which would have pushed the next
 * person to delete the explanation in order to make the test pass. A guard
 * that punishes documenting the thing it guards is worse than no guard.
 */
const code = (): string => source()
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*/g, '');

test('the classifier input name is read from the model, never hardcoded', () => {
  const text = code();

  // The specific literal that broke it, and the general shape of the mistake.
  assert.doesNotMatch(
    text,
    /session\.run\(\s*\{\s*['"`]/,
    'the classifier is being called with a literal input name; a model from a '
    + 'different trainer will throw on every frame and the wake word will '
    + 'silently never fire',
  );
  assert.ok(
    /session\.run\(\s*\{\s*\[\s*session\.inputNames\[0\]\s*\]/.test(text),
    'the classifier should be invoked with session.inputNames[0]',
  );
});

test('`x.1` is never written as a literal in the code', () => {
  // openWakeWord's models really do use it, and they still work — because the
  // name is now read from them. It may be discussed in a comment; it may not
  // be depended on.
  assert.doesNotMatch(code(), /['"`]x\.1['"`]/);
});

test('output names are read from the session too', () => {
  const text = code();
  assert.ok(/mel\.outputNames\[0\]/.test(text));
  assert.ok(/embedder\.outputNames\[0\]/.test(text));
  assert.ok(/session\.outputNames\[0\]/.test(text));
});

test('the worker does not require a fixed chunk length from its caller', () => {
  // The first failure. `feed` must accept whatever the microphone posts and
  // re-cut it, rather than returning early on a length it did not expect.
  assert.doesNotMatch(
    code(),
    /pcm\.length\s*!==\s*CHUNK_SAMPLES/,
    'the worker is rejecting audio by length again; the capture worklet posts '
    + '100 ms blocks and the models want 80 ms, and reconciling that is '
    + "ChunkQueue's job",
  );
  assert.ok(/queue\.push\(pcm\)/.test(code()), 'audio should go through the queue');
});
