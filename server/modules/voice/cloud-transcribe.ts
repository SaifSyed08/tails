import fs from 'node:fs';
import path from 'node:path';

import { TAILS_HOME } from '@/db/connection.js';
import { encodeWav } from '@/modules/voice/pcm.js';

/**
 * Dictation through OpenAI's transcription API, with the user's own key.
 *
 * ## This is the one place audio leaves the machine
 *
 * Every other part of this feature was built on the rule that no audio and no
 * transcript ever goes anywhere: the wake words run in the renderer, whisper.cpp
 * runs as a local subprocess, the utterance exists as a buffer and a temp file
 * that outlives one call. That rule was the point.
 *
 * This breaks it, deliberately and on request, because the local model's
 * accuracy was not good enough to use. So the rule becomes a narrower one, and
 * the code has to hold it rather than the comment:
 *
 * - **Off unless chosen.** The provider defaults to `local`. There is no
 *   fallback *to* the cloud — a missing local model reports a missing local
 *   model, it does not quietly start uploading.
 * - **The user's key, and only to OpenAI.** The key is read from disk here and
 *   sent to `api.openai.com` and nowhere else. It is never logged, never
 *   returned by an endpoint, and never included in an error message.
 * - **Nothing is kept.** The WAV is built in memory and handed to `fetch`. No
 *   temp file, which is a real difference from the local path: there, a file has
 *   to exist because the binary reads files.
 * - **Said out loud in the UI.** The setting names the consequence, because
 *   "better accuracy" and "your microphone is uploaded" are the same choice and
 *   the user should only be able to make it knowingly.
 */

/** Where the key lives. Outside the repo, in the app's own directory. */
const KEY_FILE = path.join(TAILS_HOME, 'openai-key');

/**
 * The models offered.
 *
 * `whisper-1` is the long-standing one and the cheapest. The `gpt-4o`
 * transcribers are more accurate on accented and technical speech, which is
 * most of what this feature is used for — the local model's failures were
 * overwhelmingly on identifiers and product names.
 */
export const CLOUD_MODELS = [
  {
    id: 'gpt-4o-transcribe',
    label: 'GPT-4o Transcribe',
    note: 'Most accurate on technical words and accents.',
  },
  {
    id: 'gpt-4o-mini-transcribe',
    label: 'GPT-4o mini Transcribe',
    note: 'Cheaper, still better than the local model.',
  },
  {
    id: 'whisper-1',
    label: 'Whisper v1',
    note: 'The original. Cheapest per minute.',
  },
] as const;

export type CloudModelId = (typeof CLOUD_MODELS)[number]['id'];

const DEFAULT_MODEL: CloudModelId = 'gpt-4o-transcribe';

export const isCloudModel = (value: string): value is CloudModelId =>
  CLOUD_MODELS.some((model) => model.id === value);

/**
 * Reads the key, or null.
 *
 * Trimmed, because a key pasted from a web page routinely arrives with a
 * newline and the resulting 401 says nothing about why.
 */
export function readKey(): string | null {
  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Whether a key is present. The only thing about the key any caller may learn. */
export const hasKey = (): boolean => readKey() !== null;

/**
 * The last four characters, for the settings panel.
 *
 * Enough to tell two keys apart and to confirm something was saved; not enough
 * to be worth anything if it ends up in a screenshot. The alternative — showing
 * nothing — makes a saved key indistinguishable from a lost one.
 */
export function keyHint(): string | null {
  const key = readKey();
  return key ? `…${key.slice(-4)}` : null;
}

export function writeKey(key: string): void {
  const value = key.trim();
  fs.mkdirSync(TAILS_HOME, { recursive: true });

  if (!value) {
    try { fs.unlinkSync(KEY_FILE); } catch { /* already gone */ }
    return;
  }

  /*
    Owner-only, and set at creation rather than after. A key written world
    readable and then chmodded has still been readable. The mode is a no-op on
    Windows, where the file inherits the user profile's ACL, which is the same
    protection by a different mechanism.
  */
  fs.writeFileSync(KEY_FILE, value, { mode: 0o600 });
}

/**
 * How long to wait for a transcription before giving up.
 *
 * An utterance is a sentence or two, so a request that takes this long is not
 * slow, it is broken — and the user is sitting in front of a microphone button
 * that says it is thinking. Aborted rather than left hanging, because the next
 * thing they will do is press it again.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Sends one utterance and returns what was said.
 *
 * `prompt` carries the same vocabulary hint the local path builds from the
 * project directory — the file names and identifiers in the current project —
 * which is what makes "tsconfig" come back as a word rather than as three.
 */
export async function transcribeInCloud(
  samples: Int16Array,
  options: { model?: string; prompt?: string } = {},
): Promise<string> {
  const key = readKey();
  if (!key) throw new Error('No OpenAI API key is saved. Add one in Settings to use cloud dictation.');

  const model = options.model && isCloudModel(options.model) ? options.model : DEFAULT_MODEL;

  const form = new FormData();
  // In memory. The local path needs a file because the binary reads files; this
  // one does not, so there is no recording on disk at any point.
  form.append('file', new Blob([encodeWav(samples)], { type: 'audio/wav' }), 'utterance.wav');
  form.append('model', model);
  form.append('response_format', 'text');
  if (options.prompt) form.append('prompt', options.prompt);

  const abort = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: abort,
    });
  } catch (error) {
    // Deliberately does not include the request. A thrown fetch error can carry
    // the headers, and the headers carry the key.
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new Error(timedOut
      ? 'The transcription request timed out.'
      : 'Could not reach the transcription service. Check your connection.');
  }

  if (!response.ok) {
    /*
      Mapped to something actionable. The API's own message is often a JSON
      envelope about a field, which tells the user nothing about what to do, and
      the status is the part that distinguishes "your key is wrong" from "you
      have run out of credit" — two problems with completely different fixes.
    */
    const reason = response.status === 401
      ? 'That OpenAI key was rejected. Check it in Settings.'
      : response.status === 429
        ? 'OpenAI rate-limited or declined the request — check the billing on that key.'
        : `Transcription failed (${response.status}).`;
    throw new Error(reason);
  }

  // `response_format: text` returns the words and nothing else, so there is no
  // envelope to parse and no shape to be wrong about.
  return (await response.text()).trim();
}
