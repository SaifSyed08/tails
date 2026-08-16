import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodeWav,
  frameDbfs,
  FRAME_SAMPLES,
  MAX_UTTERANCE_SAMPLES,
  readPcmFrames,
  SILENCE_HANGOVER_FRAMES,
  SPEECH_ONSET_FRAMES,
  SpeechGate,
  toFrames,
} from '@/modules/voice/pcm.js';

/** A frame at a given amplitude, as a square wave so RMS is predictable. */
function frameAt(amplitude: number): Int16Array {
  const frame = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < frame.length; i += 1) frame[i] = i % 2 === 0 ? amplitude : -amplitude;
  return frame;
}

const LOUD = frameAt(6000);
const QUIET = frameAt(2);

test('silence measures as negative infinity rather than a very small number', () => {
  assert.equal(frameDbfs(new Int16Array(FRAME_SAMPLES)), Number.NEGATIVE_INFINITY);
});

test('a full-scale square wave measures at roughly 0 dBFS', () => {
  assert.ok(Math.abs(frameDbfs(frameAt(32767))) < 0.01);
});

test('the gate waits for sustained speech before opening', () => {
  const gate = new SpeechGate();

  for (let i = 0; i < SPEECH_ONSET_FRAMES - 1; i += 1) {
    assert.equal(gate.feed(LOUD), null, 'opened before the onset threshold');
  }

  assert.deepEqual(gate.feed(LOUD), { type: 'speech-start' });
  assert.equal(gate.active, true);
});

test('an isolated loud frame does not open the gate', () => {
  const gate = new SpeechGate();

  // A door closing, a keyboard, a chair. One frame, then back to the floor.
  for (let i = 0; i < 20; i += 1) {
    assert.equal(gate.feed(i === 5 ? LOUD : QUIET), null);
  }
  assert.equal(gate.active, false);
});

test('the gate closes after the silence hangover, not on the first quiet frame', () => {
  const gate = new SpeechGate();
  for (let i = 0; i < SPEECH_ONSET_FRAMES; i += 1) gate.feed(LOUD);

  for (let i = 0; i < SILENCE_HANGOVER_FRAMES - 1; i += 1) {
    assert.equal(gate.feed(QUIET), null, 'closed during a mid-sentence pause');
  }

  assert.deepEqual(gate.feed(QUIET), { type: 'speech-end', reason: 'silence' });
  assert.equal(gate.active, false);
});

test('a pause shorter than the hangover does not split one utterance in two', () => {
  const gate = new SpeechGate();
  for (let i = 0; i < SPEECH_ONSET_FRAMES; i += 1) gate.feed(LOUD);

  // Someone thinking mid-sentence, then carrying on.
  for (let i = 0; i < SILENCE_HANGOVER_FRAMES - 5; i += 1) gate.feed(QUIET);
  for (let i = 0; i < 10; i += 1) assert.equal(gate.feed(LOUD), null);

  assert.equal(gate.active, true);
});

test('continuous noise ends the utterance at the length cap instead of never', () => {
  const gate = new SpeechGate();
  let ended: string | null = null;

  // Well past 30 seconds of unbroken "speech" — a fan, a television.
  const frames = Math.ceil(MAX_UTTERANCE_SAMPLES / FRAME_SAMPLES) + 50;
  for (let i = 0; i < frames; i += 1) {
    const event = gate.feed(LOUD);
    if (event?.type === 'speech-end') { ended = event.reason; break; }
  }

  assert.equal(ended, 'max-length');
  assert.equal(gate.active, false);
});

test('framing discards the partial tail rather than padding it with silence', () => {
  const frames = toFrames(new Int16Array(FRAME_SAMPLES * 2 + 7));
  assert.equal(frames.length, 2);
});

test('a wav header round-trips the samples it was given', () => {
  const samples = Int16Array.from([0, 1000, -1000, 32767, -32768]);
  const wav = encodeWav(samples);

  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), samples.length * 2);
  assert.equal(wav.readUInt32LE(24), 16000);

  for (let i = 0; i < samples.length; i += 1) {
    assert.equal(wav.readInt16LE(44 + i * 2), samples[i]);
  }
});

test('pcm is read correctly from a buffer that is not two-byte aligned', () => {
  // Buffer pooling means a chunk off the wire usually starts at an odd offset,
  // which is exactly where a zero-copy Int16Array view would throw or read a
  // neighbouring allocation.
  const backing = Buffer.alloc(9);
  backing.writeInt16LE(1234, 1);
  backing.writeInt16LE(-4321, 3);
  const unaligned = backing.subarray(1, 5);

  assert.equal(unaligned.byteOffset % 2, 1, 'test needs an odd offset to be meaningful');
  assert.deepEqual(Array.from(readPcmFrames(unaligned)), [1234, -4321]);
});

test('an odd trailing byte is dropped rather than corrupting the last sample', () => {
  const chunk = Buffer.alloc(5);
  chunk.writeInt16LE(7, 0);
  chunk.writeInt16LE(9, 2);
  assert.deepEqual(Array.from(readPcmFrames(chunk)), [7, 9]);
});
