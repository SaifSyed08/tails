import assert from 'node:assert/strict';
import test from 'node:test';

import { readTranscriptFrame } from '@/modules/voice/assemblyai.js';

/**
 * The one part of the streaming provider that can be tested from here.
 *
 * The socket cannot: there is no key on this machine and no honest way to
 * imitate a vendor's protocol well enough for a passing test to mean anything.
 * What *is* testable is the reader — which frames carry a transcript, which are
 * session bookkeeping, and whether a turn has closed — and that is also where a
 * mistake would be silent. A misread frame does not throw; it produces a
 * dictation session that shows nothing and blames the microphone.
 */

test('a v3 turn is read, and its end is noticed', () => {
  assert.deepEqual(
    readTranscriptFrame({ type: 'Turn', transcript: 'run the tests', end_of_turn: false }),
    { text: 'run the tests', final: false },
  );
  assert.deepEqual(
    readTranscriptFrame({ type: 'Turn', transcript: 'run the tests', end_of_turn: true }),
    { text: 'run the tests', final: true },
  );
});

test('the older realtime shape is read too', () => {
  // Deliberate, and not indecision: the service has changed this protocol
  // between versions, and a field name guessed wrong should cost partials
  // rather than every word.
  assert.deepEqual(
    readTranscriptFrame({ message_type: 'PartialTranscript', text: 'run the' }),
    { text: 'run the', final: false },
  );
  assert.deepEqual(
    readTranscriptFrame({ message_type: 'FinalTranscript', text: 'run the tests' }),
    { text: 'run the tests', final: true },
  );
});

test('bookkeeping frames are not transcripts', () => {
  // A session-begin read as an empty final would close a turn that had not
  // started, and truncate whatever was said next.
  for (const frame of [
    { type: 'Begin', id: 'abc', expires_at: 1 },
    { type: 'Termination', audio_duration_seconds: 3 },
    { message_type: 'SessionBegins', session_id: 'abc' },
    { error: 'not authorised' },
  ]) {
    assert.equal(readTranscriptFrame(frame), null, JSON.stringify(frame));
  }
});

test('nonsense is not a transcript', () => {
  for (const frame of [null, undefined, 'Turn', 42, [], {}]) {
    assert.equal(readTranscriptFrame(frame), null, JSON.stringify(frame));
  }
});

test('a turn with no words is still a turn', () => {
  // Read as an empty transcript rather than as no frame, so the caller can tell
  // "the turn closed with nothing in it" from "that frame was about something
  // else". The caller ignores empties; conflating the two here would take that
  // choice away from it.
  assert.deepEqual(
    readTranscriptFrame({ type: 'Turn', transcript: '', end_of_turn: true }),
    { text: '', final: true },
  );
});

test('a missing transcript field is empty, not a crash', () => {
  assert.deepEqual(readTranscriptFrame({ type: 'Turn', end_of_turn: true }), { text: '', final: true });
  assert.deepEqual(
    readTranscriptFrame({ message_type: 'PartialTranscript' }),
    { text: '', final: false },
  );
});
