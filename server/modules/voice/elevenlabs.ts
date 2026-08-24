import fs from 'node:fs';
import path from 'node:path';

import { TAILS_HOME } from '@/db/connection.js';

/**
 * Speech through ElevenLabs, with the user's own key.
 *
 * ## The same bargain the cloud transcriber made, in the other direction
 *
 * `cloud-transcribe.ts` states the rule this module inherits: audio and text
 * leaving the machine is off unless chosen, goes to one vendor and nowhere
 * else, keeps nothing, and is named honestly in the UI. Everything there
 * applies here, with one difference worth being explicit about — *this* one
 * costs money per character, and it can be triggered without the user acting.
 *
 * A chatty pet remarks on its own, after a turn nobody asked it to comment on.
 * Wired naively that is a bill that grows while the user is not at the machine.
 * So:
 *
 * - **Nothing here is a default.** Local Piper stays the default voice. This is
 *   reached only by a pet that names an ElevenLabs voice, or a session that has
 *   been given one.
 * - **The text is capped** before it is sent. A runaway reply cannot become a
 *   runaway invoice, and the cap is enforced here rather than at the caller so
 *   that every path through this module obeys it.
 * - **Failure is silent and local.** A refused key or an exhausted quota falls
 *   back to the local voice rather than throwing into the chat. The user asked
 *   for a nicer voice, not for a new class of error.
 */

const KEY_FILE = path.join(TAILS_HOME, 'elevenlabs-key');
const API = 'https://api.elevenlabs.io/v1';

/**
 * The longest utterance sent.
 *
 * ElevenLabs bills per character. A pet line is a sentence and a spoken reply
 * is chunked before it reaches any synthesiser, so anything past this is a bug
 * upstream — and truncating it is much cheaper than discovering the bug on an
 * invoice.
 */
export const MAX_SPOKEN_CHARS = 600;

/** How long to wait for audio before giving up and letting the local voice have it. */
const TIMEOUT_MS = 12_000;

/**
 * The model.
 *
 * Turbo rather than the multilingual flagship: this is a companion speaking a
 * line or two in reply to something the user just did, so latency is the
 * quality that matters and the difference in delivery over one sentence is not
 * worth a second of silence.
 */
const MODEL = 'eleven_turbo_v2_5';

export function readKey(): string | null {
  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export const hasKey = (): boolean => readKey() !== null;

/** The last four characters, for the settings panel. See `cloud-transcribe.ts`. */
export function keyHint(): string | null {
  const key = readKey();
  return key ? `…${key.slice(-4)}` : null;
}

export function writeKey(key: string): void {
  const value = key.trim();
  fs.mkdirSync(TAILS_HOME, { recursive: true });

  if (!value) {
    try { fs.unlinkSync(KEY_FILE); } catch { /* already gone */ }
    voiceCache = null;
    return;
  }

  // Owner-only at creation, not chmodded after — a key written world-readable
  // and then tightened has still been readable.
  fs.writeFileSync(KEY_FILE, value, { mode: 0o600 });
  voiceCache = null;
}

/** One voice, reduced to what a picker needs. */
export type ElevenVoice = {
  id: string;
  name: string;
  /** "American · calm · narration", assembled from whatever labels came back. */
  description: string;
};

type VoicesResponse = {
  voices?: {
    voice_id?: unknown;
    name?: unknown;
    labels?: Record<string, unknown>;
  }[];
};

/**
 * The voice list, cached for a few minutes.
 *
 * It changes only when the user adds a voice on ElevenLabs' own site, and the
 * settings panel re-reads it on every open. Without the cache, opening settings
 * twice is two round trips for a list that cannot have changed.
 */
let voiceCache: { at: number; voices: ElevenVoice[] } | null = null;
const CACHE_MS = 5 * 60_000;

function describe(labels: Record<string, unknown> | undefined): string {
  if (!labels) return '';
  // Whatever the vendor chose to send, in a stable order, deduplicated. The
  // label set is not a fixed vocabulary and has changed before, so this reads
  // it rather than naming the keys it expects.
  const seen = new Set<string>();
  for (const value of Object.values(labels)) {
    if (typeof value === 'string' && value.trim()) seen.add(value.trim());
  }
  return [...seen].join(' · ');
}

export async function listVoices(): Promise<ElevenVoice[]> {
  const key = readKey();
  if (!key) return [];

  if (voiceCache && Date.now() - voiceCache.at < CACHE_MS) return voiceCache.voices;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API}/voices`, {
      headers: { 'xi-api-key': key },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const body = await response.json() as VoicesResponse;
    const voices = (body.voices ?? [])
      .filter((voice) => typeof voice.voice_id === 'string' && typeof voice.name === 'string')
      .map((voice) => ({
        id: String(voice.voice_id),
        name: String(voice.name),
        description: describe(voice.labels),
      }));

    voiceCache = { at: Date.now(), voices };
    return voices;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turns a line into audio.
 *
 * Returns the bytes and their type, or null. Null rather than a thrown error on
 * purpose: every caller's correct response is the same one — use the local
 * voice — and an exception would make each of them write that fallback out
 * again, slightly differently.
 */
export async function speak(
  text: string,
  voiceId: string,
): Promise<{ audio: ArrayBuffer; mediaType: string } | null> {
  const key = readKey();
  const line = text.trim().slice(0, MAX_SPOKEN_CHARS);
  if (!key || !voiceId || !line) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text: line, model_id: MODEL }),
      signal: controller.signal,
    });
    if (!response.ok) return null;

    return { audio: await response.arrayBuffer(), mediaType: 'audio/mpeg' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A short sample of a voice, for the picker.
 *
 * Synthesised rather than fetched from the vendor's `preview_url`, for two
 * reasons. The preview is a fixed line that says nothing about how the voice
 * handles *this* app's kind of speech, and fetching it from the renderer would
 * mean the page reaching a third-party host directly — which is a thing this
 * app otherwise never does, and not something to start doing for a sample.
 */
export const SAMPLE_LINE = 'Tests are passing. Want me to push it?';

export const sample = (voiceId: string) => speak(SAMPLE_LINE, voiceId);
