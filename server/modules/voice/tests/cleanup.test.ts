import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanTranscript } from '@/modules/voice/cleanup.js';

test('an empty or whitespace transcript produces nothing, not a stray capital', () => {
  assert.equal(cleanTranscript(''), '');
  assert.equal(cleanTranscript('   \n '), '');
});

test('a clean sentence is left alone', () => {
  const text = 'Add a microphone button next to the send arrow.';
  assert.equal(cleanTranscript(text), text);
});

test('the mis-hearings the benchmark actually found are repaired', () => {
  // Every one of these came out of the measured runs against this codebase.
  assert.match(cleanTranscript('Check whether better Sleight 3 matches'), /better-sqlite/);
  assert.match(cleanTranscript('Check whether better Sclyte 3 matches'), /better-sqlite/);
  assert.match(cleanTranscript('instead of process execpack'), /execPath/);
  assert.match(cleanTranscript('Run npm run type check'), /typecheck/);
  assert.match(cleanTranscript('over a binary web socket'), /websocket/);
});

test('a retraction drops the clause it interrupts, not the whole sentence', () => {
  assert.equal(
    cleanTranscript('Open the config file, no wait, the manifest instead.'),
    'Open the config file, the manifest instead.',
  );
});

test('a trailing retraction removes what came before it', () => {
  assert.equal(cleanTranscript('Delete the migration, scratch that.'), 'Delete the migration,');
});

test('"scratch that" mid-clause keeps only what follows', () => {
  assert.equal(cleanTranscript('use tabs scratch that use spaces'), 'Use spaces');
});

test('fillers that survived the model are removed', () => {
  assert.equal(cleanTranscript('um, run the tests'), 'Run the tests');
  assert.equal(cleanTranscript('Run uh the tests'), 'Run the tests');
});

test('a repeated word from a stutter is collapsed', () => {
  assert.equal(cleanTranscript('open the the file'), 'Open the file');
});

test('a word that legitimately repeats across a boundary is not collapsed', () => {
  // "that that" is a stutter; "had had" is grammar. The rule only fires on an
  // immediate repeat, so this checks the rule is not reaching across a comma.
  assert.equal(
    cleanTranscript('the test that failed, failed again'),
    'The test that failed, failed again',
  );
});

test('sentence case is restored after a leading clause is dropped', () => {
  assert.match(cleanTranscript('open that one, I mean the other one'), /^The other one/);
});

test('spacing before punctuation left by a deletion is tidied', () => {
  assert.equal(cleanTranscript('run the tests um , then stop'), 'Run the tests, then stop');
});

test('cleaning is idempotent', () => {
  const once = cleanTranscript('um, open the the file, no wait, the other one');
  assert.equal(cleanTranscript(once), once);
});
