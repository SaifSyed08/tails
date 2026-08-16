import assert from 'node:assert/strict';
import test from 'node:test';

// Client code, reached by path: it imports nothing, and this is the repo's only
// test runner. See the note in answers.test.ts.
import { describeVoiceControl, type VoiceDictation } from '../../../../src/components/chat/voice-contract.js';

const dictation = (status: VoiceDictation['status'], reason?: string): VoiceDictation => ({
  status,
  ...(reason ? { reason } : {}),
  start: () => {},
  stop: () => {},
});

test('every state has its own accessible name', () => {
  // State is carried by the name as well as by colour and motion, so someone
  // who cannot see the pulse can still tell whether the microphone is live.
  const names = (['unavailable', 'idle', 'listening', 'transcribing'] as const)
    .map((status) => describeVoiceControl(dictation(status)).label);

  assert.equal(new Set(names).size, names.length, `not all distinct: ${names.join(' / ')}`);
});

test('the same button stops what it started', () => {
  const listening = describeVoiceControl(dictation('listening'));

  assert.equal(listening.pressed, true, 'and reports itself as on');
  assert.equal(listening.disabled, false, 'stopping is never harder to find than starting');
  assert.match(listening.label, /stop/i);
});

test('a disabled button explains itself', () => {
  const reason = 'Needs a one-time 78 MB model download.';
  const described = describeVoiceControl(dictation('unavailable', reason));

  assert.equal(described.disabled, true);
  assert.equal(described.title, reason, 'the tooltip is the reason, not a shrug');
});

test('no voice module at all is the unavailable state, not a crash', () => {
  const described = describeVoiceControl(undefined);

  assert.equal(described.status, 'unavailable');
  assert.equal(described.disabled, true);
  assert.ok(described.title.length > 0, 'and still says something');
});

test('transcribing is busy, not pressed', () => {
  const described = describeVoiceControl(dictation('transcribing'));

  assert.equal(described.disabled, true, 'capture has already stopped; there is nothing to toggle');
  assert.equal(described.pressed, false);
});

test('idle is the only other state that can be pressed', () => {
  const described = describeVoiceControl(dictation('idle'));

  assert.equal(described.disabled, false);
  assert.equal(described.pressed, false);
});
