/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
/*
  Reached by relative path rather than as `onnxruntime-web/dist/...`, because
  the package's `exports` map does not publish the `.wasm` file — its default
  entry expects to locate the binary at runtime instead. Importing it as an
  asset is what makes Vite emit it with a hashed name and gives us a URL that
  is correct in dev and in the built app without any copy step.
*/
import wasmUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';

import {
  ChunkQueue,
  DetectionGate,
  EMBEDDING_WINDOW,
  EMBEDDING_SIZE,
  EmbeddingWindow,
  MEL_BINS,
  MEL_CONTEXT_SAMPLES,
  MEL_WINDOW,
  MelWindow,
  scaleMel,
} from '@/components/voice/wake-window';

/**
 * Wake-word detection, off the main thread.
 *
 * ## Why a Worker, which is not the obvious reason
 *
 * Measured on this machine, the WASM chain costs 5.37% of one core. That sounds
 * ignorable, and as a duty cycle it is — but it does not arrive spread evenly.
 * It arrives as a **4.29 ms block every 80 ms**, against a 16.7 ms frame
 * budget, on the thread drawing the pet. A quarter of a frame, twelve times a
 * second, would have shipped as "the pet stutters sometimes" — a symptom
 * nobody would ever have connected back to the wake word.
 *
 * ## Why single-threaded
 *
 * Because two threads measured *worse*: 9.17% against 5.37%. Thread
 * coordination dominates on graphs this small. That is also what lets this run
 * with no `SharedArrayBuffer` and therefore no cross-origin isolation headers
 * on a page the app serves itself.
 */

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

type Session = ort.InferenceSession;

type InitMessage = {
  type: 'init';
  base: string;
  words: Array<{ id: string; file: string; threshold: number }>;
};

type AudioMessage = { type: 'audio'; pcm: Int16Array };
type Incoming = InitMessage | AudioMessage | { type: 'reset' };

type Outgoing =
  | { type: 'ready' }
  | { type: 'detected'; id: string }
  | { type: 'error'; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: Outgoing) => scope.postMessage(message);

let mel: Session | null = null;
let embedder: Session | null = null;
const classifiers: Array<{ id: string; session: Session; gate: DetectionGate }> = [];

const melWindow = new MelWindow();
const embeddings = new EmbeddingWindow();
const queue = new ChunkQueue();
let context = new Float32Array(MEL_CONTEXT_SAMPLES);

/**
 * Loads a model as bytes rather than by URL.
 *
 * ORT can take a path, but it resolves it against the worker's own base, which
 * differs between dev and a built bundle. Fetching first keeps one code path.
 */
async function open(url: string): Promise<Session> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
}

async function init(message: InitMessage): Promise<void> {
  mel = await open(`${message.base}melspectrogram.onnx`);
  embedder = await open(`${message.base}embedding_model.onnx`);

  for (const word of message.words) {
    classifiers.push({
      id: word.id,
      session: await open(`${message.base}${word.file}`),
      gate: new DetectionGate(word.threshold),
    });
  }

  post({ type: 'ready' });
}

/**
 * Scores one chunk of exactly `CHUNK_SAMPLES`. True when a word fired.
 *
 * The length precondition is real — the mel graph's frame count depends on it —
 * but it is `ChunkQueue`'s job to satisfy, not the caller's. It used to be an
 * early return here against whatever the microphone happened to post, which
 * silently discarded every chunk.
 */
async function scoreChunk(pcm: Int16Array): Promise<boolean> {
  if (!mel || !embedder) return false;

  // 480 samples of history per chunk. Without it the STFT loses its edge
  // frames and yields 5 instead of 8, which stretches the warm-up and shifts
  // every frame's timing away from what the models were trained on.
  const withContext = new Float32Array(MEL_CONTEXT_SAMPLES + pcm.length);
  withContext.set(context, 0);
  for (let i = 0; i < pcm.length; i += 1) {
    withContext[MEL_CONTEXT_SAMPLES + i] = pcm[i] / 32768;
  }
  context = withContext.slice(withContext.length - MEL_CONTEXT_SAMPLES);

  const melOut = await mel.run({
    input: new ort.Tensor('float32', withContext, [1, withContext.length]),
  });
  melWindow.push(scaleMel(melOut[mel.outputNames[0]].data as Float32Array));

  for (const window of melWindow.drain()) {
    const embOut = await embedder.run({
      input_1: new ort.Tensor('float32', window, [1, MEL_WINDOW, MEL_BINS, 1]),
    });
    embeddings.push(Float32Array.from(embOut[embedder.outputNames[0]].data as Float32Array));

    const stack = embeddings.read();
    if (!stack) continue;

    const tensor = new ort.Tensor('float32', stack, [1, EMBEDDING_WINDOW, EMBEDDING_SIZE]);
    for (const { id, session, gate } of classifiers) {
      /*
        The input name is read from the model, not assumed.

        It used to be the literal `'x.1'`, which is what PyTorch's tracer names
        an unnamed input and therefore what openWakeWord's pretrained heads
        carry. Our own models are trained with livekit-wakeword, whose exporter
        names it `embeddings` — so a model we trained ourselves would have
        installed, reported as present in Settings, and thrown on every frame.

        That is the same shape of failure as the chunk-size mismatch this file
        already carries a note about: a wake word that is switched on, looks
        correct everywhere, and silently never fires. The two shared graphs
        above keep their literal names because they are frozen and identical
        in both projects; the classifier is the part that varies by trainer,
        so it is the part that has to ask.
      */
      const out = await session.run({ [session.inputNames[0]]: tensor });
      const score = (out[session.outputNames[0]].data as Float32Array)[0];
      if (gate.accept(score)) {
        // The phrase has been consumed; leaving it in the window would re-fire
        // on its own tail.
        embeddings.reset();
        post({ type: 'detected', id });
        return true;
      }
    }
  }

  return false;
}

/**
 * Accepts audio in whatever size the microphone posts it.
 *
 * The queue is what makes that true. Nothing here may assume 80 ms blocks: the
 * capture worklet posts about 100 ms, and it is free to change.
 */
async function feed(pcm: Int16Array): Promise<void> {
  if (!mel || !embedder) return;
  for (const chunk of queue.push(pcm)) {
    // Stops at the first detection so the rest of this block is scored against
    // a window that has already been cleared, rather than re-firing on it.
    if (await scoreChunk(chunk)) return;
  }
}

/*
  Chunks are handled strictly in order. Audio arrives every 80 ms and one chunk
  takes about 4 ms, so the queue is normally empty — but a scheduling hiccup
  must not interleave two `feed` calls, because they share the mel and
  embedding buffers and would corrupt each other's context.
*/
let pending: Promise<void> = Promise.resolve();

scope.onmessage = (event: MessageEvent<Incoming>) => {
  const message = event.data;

  if (message.type === 'init') {
    pending = pending
      .then(() => init(message))
      .catch((error: unknown) => {
        post({ type: 'error', message: error instanceof Error ? error.message : 'Wake word failed to start' });
      });
    return;
  }

  if (message.type === 'reset') {
    pending = pending.then(() => {
      embeddings.reset();
      queue.reset();
      context = new Float32Array(MEL_CONTEXT_SAMPLES);
      for (const { gate } of classifiers) gate.reset();
    });
    return;
  }

  pending = pending.then(() => feed(message.pcm)).catch(() => {
    // A single bad chunk is not worth tearing the listener down for; the next
    // one will almost certainly be fine.
  });
};
