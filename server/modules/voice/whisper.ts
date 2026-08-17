import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TAILS_HOME } from '@/db/connection.js';
import { encodeWav } from '@/modules/voice/pcm.js';
import { buildInitialPrompt } from '@/modules/voice/vocabulary.js';

/**
 * The on-device recogniser.
 *
 * ## Why base.en q8_0 and not the smaller quantization
 *
 * Measured on this project's own technical vocabulary, `base.en` q8_0 is both
 * *faster* and more accurate than q5_1 — 522 ms against 630 ms for a short
 * utterance, at a lower error rate. The intuition that the smaller file must be
 * quicker is wrong here: q8_0 has the better SIMD path on AVX2. The 21 MiB is
 * bought back several times over. `small.en` was measured at 2191 ms, over the
 * latency budget, and bought no accuracy.
 *
 * ## Why a subprocess and not a native addon
 *
 * This project already carries a scar from native modules: `better-sqlite3` and
 * `node-pty` are built against Node's ABI, which is why `ensureServer()` spawns
 * a plain Node process rather than re-entering Electron. A prebuilt N-API addon
 * would be safe here for the same reason that server is plain Node — but the
 * subprocess costs only the model load, measured at 117 ms, and it cannot break
 * on an ABI change at all. Cold wall-clock end to end was 728 ms, which is well
 * inside budget, so the safer option is also an affordable one.
 */

/** The model this module is built around. Sizes verified against the download. */
export const MODEL_FILE = 'ggml-base.en-q8_0.bin';
export const MODEL_BYTES = 81_781_811;
export const MODEL_MIB = Math.round(MODEL_BYTES / 1_048_576);
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`;

/** Where a downloaded model lives — beside the database, in the app's own dir. */
export const modelPath = (): string => path.join(TAILS_HOME, 'models', MODEL_FILE);

/**
 * Locates the whisper binary.
 *
 * An explicit environment variable first so a developer can point at a local
 * build, then the copy the installer shipped, then the app's own directory.
 * Deliberately does **not** search `PATH`: silently picking up an unrelated
 * `whisper-cli` would make transcription quality depend on something the app
 * never installed and cannot vouch for. The installed copy is the opposite
 * case — it is a pinned whisper.cpp release the packaging step verified by
 * digest — which is why it is a location rather than an exception to the rule.
 *
 * Note that `claude-cli.ts` reaches the *opposite* conclusion about `PATH` from
 * the same rule, and the difference is which program it is: whisper is an
 * implementation detail the user never chose, `claude` is their own install.
 * That comparison is written out in full there.
 *
 * `TAILS_RESOURCES_PATH` is Electron's `process.resourcesPath`, handed down by
 * `ensureServer()` when the app is packaged. The server cannot work it out
 * itself: it is a separate process that also runs from a source checkout under
 * `npm run dev`, where there are no resources and nothing should be found here.
 */
export function enginePath(): string | null {
  const executable = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';

  const override = process.env.TAILS_WHISPER_PATH;
  if (override && fs.existsSync(override)) return override;

  const resources = process.env.TAILS_RESOURCES_PATH;
  if (resources) {
    const packaged = path.join(resources, 'whisper', executable);
    if (fs.existsSync(packaged)) return packaged;
  }

  const bundled = path.join(TAILS_HOME, 'whisper', executable);
  return fs.existsSync(bundled) ? bundled : null;
}

export type VoiceStatus = {
  ready: boolean;
  /** Present only when not ready. Becomes the disabled button's tooltip. */
  reason?: string;
  modelPresent: boolean;
  enginePresent: boolean;
  downloadMiB: number;
};

/** True only if the file is complete — a half-finished download is not a model. */
function modelPresent(): boolean {
  try {
    return fs.statSync(modelPath()).size === MODEL_BYTES;
  } catch {
    return false;
  }
}

/**
 * What the UI needs to decide whether the microphone button works.
 *
 * The reason is the whole error surface, so it names the obstacle and the fix
 * rather than reporting that something is unavailable.
 */
export function readStatus(): VoiceStatus {
  const engine = enginePath() !== null;
  const model = modelPresent();

  if (engine && model) {
    return { ready: true, modelPresent: true, enginePresent: true, downloadMiB: MODEL_MIB };
  }

  const reason = !engine
    ? 'Speech recognition engine is not installed yet'
    : `Needs a one-time ${MODEL_MIB} MB model download — nothing is sent anywhere`;

  return { ready: false, reason, modelPresent: model, enginePresent: engine, downloadMiB: MODEL_MIB };
}

let downloading: Promise<void> | null = null;

/**
 * Fetches the model, once, and only when asked.
 *
 * The single network call this feature is allowed to make, and it happens only
 * behind an explicit user action with the size shown first. Downloads to a
 * temporary name and renames on success, so an interrupted fetch can never be
 * mistaken for a usable model by the size check above.
 */
export function downloadModel(onProgress?: (received: number) => void): Promise<void> {
  if (downloading) return downloading;

  downloading = (async () => {
    const target = modelPath();
    const partial = `${target}.partial`;
    fs.mkdirSync(path.dirname(target), { recursive: true });

    const response = await fetch(MODEL_URL);
    if (!response.ok || !response.body) {
      throw new Error(`Model download failed with ${response.status}`);
    }

    const handle = await fs.promises.open(partial, 'w');
    let received = 0;
    try {
      for await (const chunk of response.body) {
        const buf = Buffer.from(chunk as Uint8Array);
        await handle.write(buf);
        received += buf.length;
        onProgress?.(received);
      }
    } finally {
      await handle.close();
    }

    if (received !== MODEL_BYTES) {
      await fs.promises.rm(partial, { force: true });
      throw new Error(`Model download was ${received} bytes, expected ${MODEL_BYTES}`);
    }

    await fs.promises.rename(partial, target);
  })().finally(() => { downloading = null; });

  return downloading;
}

/** Strips the CLI's own chatter, leaving only what was said. */
function readTranscript(stdout: string): string {
  return stdout
    .split('\n')
    .filter((line) => !line.startsWith('[') && !line.startsWith('whisper_'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How long a single utterance may take before it is abandoned.
 *
 * Ten seconds against a measured p95 of 810 ms is not a performance budget, it
 * is a deadlock guard: a wedged subprocess must not leave the button spinning.
 */
const TRANSCRIBE_TIMEOUT_MS = 10_000;

/**
 * Turns one utterance into text.
 *
 * `cwd` is the conversation's folder, and it is doing real work: it seeds the
 * decoder with the project's own vocabulary, which is what turns
 * "Pet's Tage Chat Pet TSX" into "petstage, ChatPet.tsx".
 */
export async function transcribe(samples: Int16Array, cwd?: string | null): Promise<string> {
  const engine = enginePath();
  if (!engine) throw new Error('Speech recognition engine is not installed');
  if (!modelPresent()) throw new Error('Speech recognition model is not downloaded');

  // whisper-cli reads a file and cannot take audio on stdin, so the utterance
  // has to land on disk. Written to the OS temp dir and removed immediately —
  // recorded speech should not outlive the sentence it came from.
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tails-voice-'));
  const wav = path.join(scratch, 'utterance.wav');
  await fs.promises.writeFile(wav, encodeWav(samples));

  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(engine, [
        '-m', modelPath(),
        '-f', wav,
        '-t', '8',
        '-nt',
        '--prompt', buildInitialPrompt(cwd),
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      // stderr carries whisper's timing report, which is noise unless it failed.
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Transcription timed out'));
      }, TRANSCRIBE_TIMEOUT_MS);

      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(readTranscript(stdout));
        else reject(new Error(stderr.trim().split('\n').pop() || `whisper exited with ${code}`));
      });
    });
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  }
}
