import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { TAILS_HOME } from '@/db/connection.js';
import { APP_ROOT } from '@/modules/voice/whisper.js';

/**
 * Speech *out*, on device.
 *
 * ## Why Piper and not the platform synthesiser
 *
 * Because the platform synthesiser on this machine is three voices from 2013
 * and there is no better one to select — the complaint that started this was
 * "text to speech sounds pretty shit", and no amount of settings work fixes a
 * voice list with nothing good in it.
 *
 * ## Why Piper and not Kokoro, given Kokoro sounds better
 *
 * It does sound better, and it is used for pets for exactly that reason. It
 * cannot carry the *replies*, and the reason is structural rather than a
 * question of tuning. Measured here, on this machine:
 *
 *   | engine            | first chunk | vs realtime |
 *   |-------------------|-------------|-------------|
 *   | Piper (norman)    |  1,133 ms   |  6.0x       |
 *   | Kokoro int8 (CPU) |  1,976 ms   |  0.6x       |
 *
 * A reply is spoken in pieces while the rest is still streaming, so the engine
 * has to generate faster than the audio plays or it falls progressively
 * further behind — 0.6x does not merely start late, it loses ground on every
 * chunk and opens gaps mid-sentence. Piper at 6x builds a buffer instead.
 *
 * Both GPU escapes were tried and both are shut: `onnxruntime-gpu` has no
 * wheel matching this machine's Python and CUDA pair, and DirectML crashes on
 * Kokoro's `ConvTranspose` in int8 *and* fp16. Pets do not care — a one-off
 * line has nothing to keep pace with.
 *
 * ## Why a subprocess
 *
 * The same reasoning `whisper.ts` sets out at length, and it applies here
 * unchanged: a prebuilt CLI cannot break on a Node ABI change, and the process
 * start is affordable against the work it does. It also settles the licence
 * question — see below — which a native addon would not.
 *
 * ## The licence, which is the part worth reading
 *
 * Piper's own code and voices are MIT, but it phonemises with **espeak-ng,
 * which is GPL-3.0**. That is what ruled Kokoro's JS distribution out earlier:
 * `kokoro-js` compiles espeak-ng to WASM and *statically links it into the
 * bundle*, which is a combined work by any reading.
 *
 * Piper is packaged the other way round. `piper.exe` links espeak-ng itself
 * and ships with its own copy; this app only ever *spawns* it. Two programs
 * exchanging text over a pipe are not one work — the same relationship an app
 * has with `ffmpeg` or `git` — so nothing here makes TAILS a derivative of
 * anything GPL. What redistribution does oblige is carrying espeak-ng's licence
 * and an offer of source, which `scripts/fetch-piper.mjs` does.
 *
 * The distinction is linking, not proximity, and getting it backwards is what
 * made this feature look impossible for months.
 */

/** The voice used when nothing else is chosen. */
export const DEFAULT_VOICE_ID = 'en_US-norman-medium';

export type PiperVoiceDefinition = {
  id: string;
  label: string;
  /** Bytes of the `.onnx`, for the "this will download N MB" copy. */
  bytes: number;
  /** Path under the upstream voice tree, without the extension. */
  remote: string;
};

/**
 * The voices offered, and why the list is short.
 *
 * Upstream ships over a hundred. A settings panel listing all of them is a
 * worse experience than one that names three, and every entry is a 60 MB
 * download the user has to evaluate. These are the default plus two obvious
 * alternates; adding one is a line here.
 */
export const PIPER_VOICES: readonly PiperVoiceDefinition[] = [
  {
    id: DEFAULT_VOICE_ID,
    label: 'Norman (US)',
    bytes: 63_531_379,
    remote: 'en/en_US/norman/medium/en_US-norman-medium',
  },
  {
    id: 'en_US-amy-medium',
    label: 'Amy (US)',
    bytes: 63_201_294,
    remote: 'en/en_US/amy/medium/en_US-amy-medium',
  },
  {
    id: 'en_GB-alba-medium',
    label: 'Alba (GB)',
    bytes: 63_104_526,
    remote: 'en/en_GB/alba/medium/en_GB-alba-medium',
  },
];

const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

/** Where downloaded voices live, beside the speech-recognition model. */
export const voiceDir = (): string => path.join(TAILS_HOME, 'models', 'piper');

export const voicePath = (id: string): string => path.join(voiceDir(), `${id}.onnx`);

/**
 * Locates the Piper binary.
 *
 * Deliberately the same search order as `enginePath()` in `whisper.ts`, and
 * deliberately *not* a `PATH` search, for the same reason spelled out there: a
 * stray `piper.exe` the app never installed would make speech quality depend
 * on something it cannot vouch for.
 */
export function enginePath(): string | null {
  const executable = process.platform === 'win32' ? 'piper.exe' : 'piper';

  const override = process.env.TAILS_PIPER_PATH;
  if (override && fs.existsSync(override)) return override;

  const resources = process.env.TAILS_RESOURCES_PATH;
  if (resources) {
    const packaged = path.join(resources, 'piper', executable);
    if (fs.existsSync(packaged)) return packaged;
  }

  const home = path.join(TAILS_HOME, 'piper', executable);
  if (fs.existsSync(home)) return home;

  // The checkout's own copy, fetched by `npm run vendor:piper`. Same case as
  // whisper's: a digest-pinned build this project fetched and verified.
  const vendored = path.join(
    APP_ROOT, 'vendor', 'piper', `${process.platform}-${process.arch}`, executable,
  );
  return fs.existsSync(vendored) ? vendored : null;
}

export type SpeechStatus = {
  ready: boolean;
  reason?: string;
  enginePresent: boolean;
  /** Voice ids present on disk. */
  installed: string[];
  defaultVoice: string;
  voices: Array<{ id: string; label: string; installed: boolean; downloadMiB: number }>;
};

const voiceInstalled = (id: string): boolean => {
  try {
    return fs.statSync(voicePath(id)).size > 1_000_000;
  } catch {
    return false;
  }
};

export function readSpeechStatus(): SpeechStatus {
  const engine = enginePath() !== null;
  const voices = PIPER_VOICES.map((voice) => ({
    id: voice.id,
    label: voice.label,
    installed: voiceInstalled(voice.id),
    downloadMiB: Math.round(voice.bytes / 1_048_576),
  }));
  const installed = voices.filter((voice) => voice.installed).map((voice) => voice.id);

  const reason = !engine
    ? 'The speech engine is not installed yet'
    : installed.length === 0
      ? `Needs a one-time ${voices[0].downloadMiB} MB voice download — nothing is sent anywhere`
      : undefined;

  return {
    ready: engine && installed.length > 0,
    ...(reason ? { reason } : {}),
    enginePresent: engine,
    installed,
    defaultVoice: DEFAULT_VOICE_ID,
    voices,
  };
}

const downloading = new Map<string, Promise<void>>();

/**
 * Fetches one voice, once, and only when asked.
 *
 * Two files: the model and its config, which Piper needs together and which is
 * a genuine failure mode — a voice with no `.json` loads and then produces
 * silence. Downloaded to temporary names and renamed on success, so a half
 * finished fetch can never satisfy the size check above.
 */
export function downloadVoice(id: string, onProgress?: (received: number) => void): Promise<void> {
  const existing = downloading.get(id);
  if (existing) return existing;

  const definition = PIPER_VOICES.find((voice) => voice.id === id);
  if (!definition) return Promise.reject(new Error(`Unknown voice ${id}`));

  const run = (async () => {
    fs.mkdirSync(voiceDir(), { recursive: true });

    for (const suffix of ['.onnx', '.onnx.json'] as const) {
      const target = path.join(voiceDir(), `${id}${suffix}`);
      const partial = `${target}.partial`;

      const response = await fetch(`${VOICE_BASE}/${definition.remote}${suffix}`);
      if (!response.ok || !response.body) {
        throw new Error(`Voice download failed with ${response.status}`);
      }

      const handle = await fs.promises.open(partial, 'w');
      let received = 0;
      try {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk as Uint8Array);
          await handle.write(buffer);
          received += buffer.length;
          if (suffix === '.onnx') onProgress?.(received);
        }
      } finally {
        await handle.close();
      }

      await fs.promises.rename(partial, target);
    }
  })().finally(() => { downloading.delete(id); });

  downloading.set(id, run);
  return run;
}

/**
 * How long one chunk may take before it is abandoned.
 *
 * Fifteen seconds against a measured 1.1 s is a deadlock guard rather than a
 * budget: a wedged subprocess must not leave the reply silent forever with no
 * way to tell.
 */
const SYNTH_TIMEOUT_MS = 15_000;

/**
 * Turns text into a WAV.
 *
 * Piper writes to a file rather than to stdout in this build, so the audio
 * lands on disk for the length of one call and is removed immediately —
 * synthesised speech should not outlive the sentence it came from, the same
 * rule dictation follows for the microphone.
 */
export async function synthesise(text: string, voiceId?: string): Promise<Buffer> {
  const engine = enginePath();
  if (!engine) throw new Error('The speech engine is not installed');

  const id = voiceId && voiceInstalled(voiceId) ? voiceId : DEFAULT_VOICE_ID;
  if (!voiceInstalled(id)) throw new Error('No speech voice is downloaded');

  const scratch = await fs.promises.mkdtemp(path.join(voiceDir(), 'say-'));
  const wav = path.join(scratch, 'out.wav');

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(engine, [
        '-m', voicePath(id),
        '-c', `${voicePath(id)}.json`,
        '-f', wav,
      ], { stdio: ['pipe', 'ignore', 'pipe'] });

      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Speech synthesis timed out'));
      }, SYNTH_TIMEOUT_MS);

      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(stderr.trim().split('\n').pop() || `piper exited with ${code}`));
      });

      // One line in, one clip out. Newlines would be separate utterances and
      // the file would hold only the last of them.
      child.stdin.end(`${text.replace(/\s+/g, ' ').trim()}\n`);
    });

    return await fs.promises.readFile(wav);
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  }
}
