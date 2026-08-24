import fs from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import { TAILS_HOME } from '@/db/connection.js';

/**
 * Streaming dictation through AssemblyAI, with the user's own key.
 *
 * ## Why a third provider at all
 *
 * The two that exist sit at opposite ends of one trade. Local whisper shows
 * words as you speak — by re-running the model over the growing buffer — and is
 * the least accurate. The cloud transcriber is the most accurate and shows
 * nothing until you stop, because `supportsPartials` is false for it and that
 * is not squeamishness: a live pass re-transcribes the same audio, so partials
 * against a per-minute API would bill for one sentence five times.
 *
 * A *stream* is the way out of that trade. The audio goes over once, the
 * partials come back for free, and the accuracy is a hosted model's. It is the
 * only shape that can be both live and cloud, which is why it is worth a third
 * path rather than another model id on the second one.
 *
 * ## Failure means "be the old provider"
 *
 * This code cannot be run against the real service from here — there is no key
 * on this machine — and it sits in the middle of the capture loop, which is the
 * part of the app most expensive to break. So every failure in this module is
 * arranged to end the same way: the session reports itself dead, the gateway
 * transcribes the buffered audio the ordinary way, and the user gets dictation
 * that behaves like the cloud provider they already had.
 *
 * That is also why the message reader below accepts two shapes. The service has
 * changed its streaming protocol between versions, and a field name guessed
 * wrong should cost partials rather than every word.
 */

const KEY_FILE = path.join(TAILS_HOME, 'assemblyai-key');

/**
 * The streaming endpoint.
 *
 * Sample rate is fixed at the rate the capture worklet already produces, so
 * nothing here resamples — the pipeline is 16 kHz mono Int16 from the browser
 * to this socket, and a mismatch would be silence rather than an error.
 */
const ENDPOINT = 'wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le';

/** How long to wait for the socket to open before giving up on it. */
const CONNECT_MS = 4_000;

/** How long to wait for the closing transcript after the audio stops. */
const FINAL_MS = 4_000;

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
    return;
  }

  fs.writeFileSync(KEY_FILE, value, { mode: 0o600 });
}

/**
 * Reads a transcript out of whatever the service sent.
 *
 * Two shapes, deliberately. The v3 streaming API reports turns — `type: 'Turn'`
 * with a `transcript` and an `end_of_turn` flag — and the older realtime API
 * reported `message_type: 'PartialTranscript' | 'FinalTranscript'` with a
 * `text`. Reading both is not indecision: this cannot be tested from here, and
 * the cost of guessing wrong should be partials rather than every word.
 *
 * Returns null for anything that is neither, which includes the session-begin
 * and session-terminated frames that are not transcripts at all.
 */
export function readTranscriptFrame(raw: unknown): { text: string; final: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;

  if (record.type === 'Turn') {
    const text = typeof record.transcript === 'string' ? record.transcript : '';
    return { text, final: record.end_of_turn === true };
  }

  const kind = record.message_type;
  if (kind === 'PartialTranscript' || kind === 'FinalTranscript') {
    const text = typeof record.text === 'string' ? record.text : '';
    return { text, final: kind === 'FinalTranscript' };
  }

  return null;
}

export type RealtimeSession = {
  /** Audio for the current utterance. Ignored once the session has failed. */
  push: (frame: Int16Array) => void;
  /**
   * Stops the audio and resolves with the best transcript the service sent.
   *
   * Empty when nothing usable arrived, which the caller must treat as "fall
   * back" rather than as "the user said nothing".
   */
  finish: () => Promise<string>;
  /** True once anything has gone wrong. The caller stops using the session. */
  readonly failed: boolean;
};

/**
 * Opens a streaming session, or returns null if it cannot.
 *
 * Null rather than a rejected promise: the caller's response to every failure
 * mode is identical — use the buffered path — and an exception would make that
 * a try/catch around the whole capture loop.
 */
export async function openRealtime(
  onPartial: (text: string) => void,
): Promise<RealtimeSession | null> {
  const key = readKey();
  if (!key) return null;

  let socket: WebSocket;
  try {
    socket = new WebSocket(ENDPOINT, { headers: { Authorization: key } });
  } catch {
    return null;
  }

  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CONNECT_MS);
    const settle = (ok: boolean) => { clearTimeout(timer); resolve(ok); };
    socket.once('open', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('close', () => settle(false));
  });

  if (!opened) {
    try { socket.close(); } catch { /* already gone */ }
    return null;
  }

  let failed = false;
  /*
    The best final so far, and the latest partial.

    Kept separately because a stream can end without a final — a dropped socket,
    a turn the service never closed — and the last partial is a much better
    answer than nothing in that case.
  */
  let settled = '';
  let latest = '';

  socket.on('message', (data: Buffer) => {
    let frame: unknown;
    try {
      frame = JSON.parse(data.toString()) as unknown;
    } catch {
      return;
    }

    const read = readTranscriptFrame(frame);
    if (!read || !read.text) return;

    if (read.final) {
      // Appended rather than replaced: a long utterance can close several turns
      // before the user stops, and keeping only the last would drop the
      // beginning of anything said in more than one breath.
      settled = settled ? `${settled} ${read.text}` : read.text;
      latest = '';
    } else {
      latest = read.text;
    }

    onPartial(settled ? `${settled} ${latest}`.trim() : latest);
  });

  socket.on('error', () => { failed = true; });
  socket.on('close', () => { failed = true; });

  return {
    get failed() { return failed; },

    push(frame) {
      if (failed || socket.readyState !== WebSocket.OPEN) return;
      try {
        // The bytes as they came off the worklet. `Buffer.from` on the
        // underlying memory rather than a copy of the view, so a frame that is
        // a subarray of a larger block does not send the whole block.
        socket.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
      } catch {
        failed = true;
      }
    },

    async finish() {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'Terminate' }));
        } catch {
          failed = true;
        }
      }

      /*
        A brief wait for the closing transcript.

        Resolved by the socket closing or by the timeout, whichever comes first,
        and never by an absent "final" — a service that never sends one must not
        hang the end of an utterance, because the user has already stopped
        talking and is waiting to see their words.
      */
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FINAL_MS);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
      });

      try { socket.close(); } catch { /* already closing */ }
      return (settled ? `${settled} ${latest}` : latest).trim();
    },
  };
}
