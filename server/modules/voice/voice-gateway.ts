import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  FRAME_SAMPLES,
  MAX_UTTERANCE_SAMPLES,
  readPcmFrames,
  SAMPLE_RATE,
  SpeechGate,
  toFrames,
} from '@/modules/voice/pcm.js';
import { cleanTranscript } from '@/modules/voice/cleanup.js';
import { MIN_PASS_INTERVAL_MS, StableTranscript } from '@/modules/voice/live-transcript.js';
import { activeProvider, transcribeUtterance } from '@/modules/voice/transcription.js';
import { readRecord, readString } from '@/shared/utils.js';

const VOICE_PATH = '/voice';

type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Routes websocket upgrades between this gateway and the ones already attached.
 *
 * The same dispatcher `terminal-gateway.ts` documents, and for the same reason:
 * `new WebSocketServer({ server, path })` registers its own `upgrade` listener,
 * and a listener whose path does not match **aborts the handshake with a 400**
 * instead of passing it along. Adding a third gateway naively would kill the
 * chat socket and the shell. So this claims `/voice` and hands everything else
 * back untouched.
 */
function routeUpgrades(server: Server, wss: WebSocketServer): void {
  const existing = server.listeners('upgrade') as UpgradeListener[];
  for (const listener of existing) server.removeListener('upgrade', listener);

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string | null = null;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = null;
    }

    if (pathname === VOICE_PATH) {
      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit('connection', client, request);
      });
      return;
    }

    for (const listener of existing) listener.call(server, request, socket, head);
  });
}

type ServerFrame =
  /** The gate opened or closed. Drives the composer's listening indicator. */
  | { type: 'state'; listening: boolean }
  /**
   * Text that has settled and will not change.
   *
   * Sent while the user is still talking. Never a revision — see
   * `live-transcript.ts` for why nothing provisional is ever sent.
   */
  | { type: 'partial'; text: string }
  | { type: 'transcript'; text: string }
  | { type: 'error'; message: string };

/**
 * One microphone session.
 *
 * Holds the audio for a single utterance and nothing longer. There is no
 * recording, no history and no file that outlives the sentence: the samples
 * exist in this buffer, become a temp file for the length of one subprocess
 * call, and are dropped.
 */
type Capture = {
  cwd: string | null;
  gate: SpeechGate;
  /** Samples for the utterance in progress, or null between utterances. */
  buffer: Int16Array | null;
  used: number;
  /** Leftover samples when a chunk did not divide evenly into gate frames. */
  remainder: Int16Array;
  busy: boolean;
  /** Decides which words have stopped changing and may be shown. */
  live: StableTranscript;
  /** When the last live pass started, so passes cannot overlap. */
  lastPassAt: number;
  /** True while a live pass is running; passes are strictly serial. */
  passing: boolean;
};

function append(capture: Capture, samples: Int16Array): void {
  if (!capture.buffer) {
    capture.buffer = new Int16Array(MAX_UTTERANCE_SAMPLES);
    capture.used = 0;
  }
  const room = capture.buffer.length - capture.used;
  const take = Math.min(room, samples.length);
  capture.buffer.set(samples.subarray(0, take), capture.used);
  capture.used += take;
}

/**
 * Accepts microphone audio and returns text.
 *
 * Audio arrives as raw little-endian Int16 at 16 kHz mono — binary frames
 * rather than base64 in JSON, which avoids a third of the bytes and the
 * encode/decode on both ends. At 32 KB/s over loopback the transport is not
 * worth optimising further.
 */
export function attachVoiceGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  routeUpgrades(server, wss);

  wss.on('connection', (socket: WebSocket) => {
    const capture: Capture = {
      cwd: null,
      gate: new SpeechGate(),
      buffer: null,
      used: 0,
      remainder: new Int16Array(0),
      busy: false,
      live: new StableTranscript(),
      lastPassAt: 0,
      passing: false,
    };

    const send = (frame: ServerFrame) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };

    /**
     * Transcribes the audio so far and emits whatever has settled.
     *
     * Runs while the user is still talking, which is what makes text appear as
     * they speak rather than after they stop. Strictly serial and rate-limited:
     * a pass costs roughly 640 ms here and whisper pads every input to a
     * 30-second window, so overlapping passes would queue behind each other and
     * add latency without adding resolution.
     *
     * Failures are swallowed. A dropped live pass costs one update; the final
     * transcription on stop is the one that must not fail.
     */
    const runLivePass = async () => {
      /*
       * Not every engine may be asked this.
       *
       * A partial is produced by transcribing the *same* audio again, a few
       * hundred milliseconds later, and taking whatever has newly settled. That
       * is free against a local binary and it is a separate billed request
       * against an API — so a ten-word sentence would be charged five times to
       * show the user words they were about to see anyway. The provider says
       * whether it wants this; see `transcription.ts`.
       */
      if (!activeProvider().supportsPartials) return;
      if (capture.passing || capture.busy) return;
      const now = Date.now();
      if (now - capture.lastPassAt < MIN_PASS_INTERVAL_MS) return;
      if (!capture.buffer || capture.used < SAMPLE_RATE / 2) return;

      capture.passing = true;
      capture.lastPassAt = now;
      // Copied because capture continues writing into the buffer underneath.
      const snapshot = capture.buffer.slice(0, capture.used);

      try {
        const settled = capture.live.advance(await transcribeUtterance(snapshot, capture.cwd));
        if (settled) send({ type: 'partial', text: cleanTranscript(settled) });
      } catch {
        // See above: a live pass is best-effort.
      } finally {
        capture.passing = false;
      }
    };

    /**
     * Ends an utterance and transcribes it.
     *
     * `explicit` means the user pressed stop rather than the gate closing. It
     * changes only one thing, and that one thing is worth the parameter: a
     * deliberate stop that produced no audio has to say so. Silence here is
     * indistinguishable from a broken feature — the microphone light is on, the
     * button was pressed, and nothing appears — and the usual cause is a gate
     * that never opened because the input level is too low, which is something
     * the user can actually fix.
     */
    const finish = async (explicit = false) => {
      const samples = capture.buffer?.subarray(0, capture.used);
      capture.buffer = null;
      capture.used = 0;
      capture.gate.reset();
      send({ type: 'state', listening: false });

      // Below about a fifth of a second there is no word in there, and running
      // the model on it produces confident nonsense rather than nothing.
      if (!samples || samples.length < SAMPLE_RATE / 5) {
        if (explicit) {
          send({
            type: 'error',
            message: 'No speech was picked up — check that the right microphone is selected and that its level is up.',
          });
        }
        return;
      }
      if (capture.busy) return;

      capture.busy = true;
      try {
        // The last pass sees all the audio and is the most accurate one, but
        // whatever was already shown cannot be taken back — so `flush` returns
        // only the part that has not been sent, re-anchored if this pass
        // disagrees with what the user is already looking at.
        const tail = capture.live.flush(await transcribeUtterance(samples, capture.cwd));
        const text = cleanTranscript(tail);
        if (text) send({ type: 'transcript', text });
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : 'Transcription failed' });
      } finally {
        capture.live.reset();
        capture.busy = false;
      }
    };

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Carry any odd tail across chunk boundaries so a sample is never split
        // in half by the network, which would shift every sample after it.
        const incoming = readPcmFrames(data);
        const joined = new Int16Array(capture.remainder.length + incoming.length);
        joined.set(capture.remainder, 0);
        joined.set(incoming, capture.remainder.length);

        const frames = toFrames(joined, FRAME_SAMPLES);
        const consumed = frames.length * FRAME_SAMPLES;
        capture.remainder = joined.subarray(consumed);

        for (const frame of frames) {
          const event = capture.gate.feed(frame);
          if (capture.gate.active || event?.type === 'speech-end') append(capture, frame);

          if (event?.type === 'speech-start') send({ type: 'state', listening: true });
          else if (event?.type === 'speech-end') void finish();
        }

        // Text should arrive while the sentence is still being spoken, not
        // after it ends. Rate-limiting lives inside the pass itself.
        if (capture.gate.active) void runLivePass();
        return;
      }

      const message = readRecord(JSON.parse(data.toString()) as unknown);
      if (!message) return;

      if (message.type === 'voice.start') {
        // Asked of whichever engine is selected, not of the local one. A
        // missing local model must not block a session that is going to the
        // cloud, and a missing key must not be reported as a missing download.
        const provider = activeProvider();
        if (!provider.ready) {
          send({ type: 'error', message: provider.reason ?? 'Dictation is not available' });
          return;
        }
        capture.cwd = readString(message.cwd);
        capture.live.reset();
        capture.lastPassAt = 0;
        capture.gate.reset();
        capture.buffer = null;
        capture.used = 0;
        capture.remainder = new Int16Array(0);
        return;
      }

      // An explicit stop must transcribe whatever has been said so far rather
      // than waiting for the gate — the user has already decided they finished.
      if (message.type === 'voice.stop') void finish(true);
    });

    socket.on('close', () => {
      // Deliberately does not transcribe. A closed socket has nowhere to send
      // the result, and running the model anyway would burn a core to produce
      // text nobody will ever see.
      capture.buffer = null;
      capture.gate.reset();
    });
  });

  return wss;
}
