import assert from 'node:assert/strict';
import test from 'node:test';

import { StableTranscript } from '@/modules/voice/live-transcript.js';

/** Feeds passes in order and returns what each one emitted. */
function play(passes: string[], holdback = 3): string[] {
  const live = new StableTranscript(2, holdback);
  return passes.map((pass) => live.advance(pass));
}

test('the first pass emits nothing — there is nothing to agree with yet', () => {
  const live = new StableTranscript();
  assert.equal(live.advance('the tests'), '');
});

test('words settle only once a later pass agrees and the tail has moved on', () => {
  const emitted = play([
    'the tests pass',
    'the tests pass and the build',
    'the tests pass and the build is clean',
  ]);

  assert.equal(emitted[0], '', 'first pass cannot settle anything');
  // Pass two agrees on only three words, and all three are inside the
  // three-word holdback — so still nothing is safe to show.
  assert.equal(emitted[1], '');
  // Pass three agrees on six; the first three clear the holdback.
  assert.equal(emitted[2], 'the tests pass');
});

test('a word revised by a later pass is never shown in its wrong form', () => {
  // Whisper hears "a build", then corrects itself to "the build" once more
  // audio arrives. The wrong version must never have reached the composer.
  const live = new StableTranscript(2, 3);
  const seen: string[] = [];
  for (const pass of [
    'the tests pass and a build',
    'the tests pass and the build is clean now',
  ]) {
    seen.push(live.advance(pass));
  }

  const shown = seen.join(' ');
  assert.ok(!/\ba build\b/.test(shown), `leaked a revised word: "${shown}"`);
});

test('disagreement stalls the commit rather than guessing', () => {
  const live = new StableTranscript(2, 0);
  live.advance('open the config file');
  // A pass that disagrees at word two: nothing past "open" can settle.
  const emitted = live.advance('open a config file');
  assert.equal(emitted, 'open');
});

test('emitted text never repeats itself across passes', () => {
  const emitted = play([
    'run the tests',
    'run the tests and then',
    'run the tests and then stop the server',
    'run the tests and then stop the server now please',
  ]);

  const joined = emitted.filter(Boolean).join(' ').split(/\s+/);
  assert.deepEqual(joined, [...new Set(joined)].length === joined.length ? joined : [],
    `a word was emitted twice: ${joined.join(' ')}`);
});

test('the committed text is always a prefix of what was actually said', () => {
  const live = new StableTranscript(2, 3);
  const truth = 'the tests pass and the build is clean and the server restarts';
  const spoken = truth.split(' ');

  for (let n = 2; n <= spoken.length; n += 1) live.advance(spoken.slice(0, n).join(' '));

  assert.ok(truth.startsWith(live.committed), `"${live.committed}" is not a prefix`);
});

test('punctuation and casing changes do not read as disagreement', () => {
  // A later pass deciding a sentence started, or adding a comma, must not
  // stall the commit — otherwise nothing settles on ordinary speech.
  const live = new StableTranscript(2, 0);
  live.advance('open the file and stop');
  const emitted = live.advance('Open the file, and stop');
  assert.match(emitted, /open the file/i);
});

test('flush releases the held-back tail, so the sentence is not cut short', () => {
  const live = new StableTranscript(2, 3);
  live.advance('the tests pass and the build is clean');
  live.advance('the tests pass and the build is clean');

  const tail = live.flush('the tests pass and the build is clean');
  assert.equal(`${live.committed}`, 'the tests pass and the build is clean');
  assert.match(tail, /is clean$/);
});

test('flush after nothing was emitted returns the whole utterance', () => {
  const live = new StableTranscript();
  assert.equal(live.flush('just one short thing'), 'just one short thing');
});

test('flush does not repeat text already shown', () => {
  const live = new StableTranscript(2, 1);
  live.advance('open the config file now');
  const early = live.advance('open the config file now');
  const tail = live.flush('open the config file now');

  const all = `${early} ${tail}`.trim().split(/\s+/);
  assert.deepEqual(all, ['open', 'the', 'config', 'file', 'now']);
});

test('flush re-anchors when the final pass disagrees with what was shown', () => {
  // The final pass is the most accurate but cannot retract what the user has
  // already seen; it must append from the divergence rather than duplicating.
  const live = new StableTranscript(2, 0);
  live.advance('open the config');
  live.advance('open the config');

  const tail = live.flush('open the manifest instead');
  assert.ok(!tail.startsWith('open the'), `duplicated the shown prefix: "${tail}"`);
});

test('reset clears state so a second utterance does not inherit the first', () => {
  const live = new StableTranscript(2, 0);
  live.advance('first utterance');
  live.advance('first utterance');
  live.reset();

  assert.equal(live.committed, '');
  assert.equal(live.advance('second utterance'), '', 'needs two fresh passes again');
});

test('silence between passes emits nothing rather than churning', () => {
  const live = new StableTranscript();
  live.advance('');
  assert.equal(live.advance(''), '');
  assert.equal(live.committed, '');
});
