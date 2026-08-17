import assert from 'node:assert/strict';
import test from 'node:test';

// Client code, reached by path — see the note in speech-text.test.ts.
import {
  matchVoiceName,
  resolvePetVoice,
} from '../../../../src/components/voice/pet-voice.js';

const voice = (name: string, lang = 'en-US', isDefault = false) => ({ name, lang, isDefault });

const WINDOWS = [
  voice('Microsoft David Desktop', 'en-US', true),
  voice('Microsoft Zira Desktop', 'en-US'),
  voice('Microsoft Hedda Desktop', 'de-DE'),
];

test('an exactly named voice is used', () => {
  assert.equal(matchVoiceName('Microsoft Zira Desktop', WINDOWS), 'Microsoft Zira Desktop');
});

test('a voice named the way another platform decorates it still matches', () => {
  // A pet authored elsewhere may name "Zira" or the full en-GB style string;
  // both should find this machine's Zira rather than falling through.
  assert.equal(matchVoiceName('Zira', WINDOWS), 'Microsoft Zira Desktop');
  assert.equal(matchVoiceName('Microsoft Zira - English (United States)', WINDOWS), 'Microsoft Zira Desktop');
});

test('a voice this machine has never heard of falls back to the same language', () => {
  // The macOS case: "Samantha" does not exist on Windows.
  const picked = matchVoiceName('Samantha', WINDOWS);
  assert.ok(picked && picked.startsWith('Microsoft'), `picked ${picked}`);
  assert.equal(WINDOWS.find((v) => v.name === picked)?.lang, 'en-US');
});

test('with no English voice at all it falls back to the platform default', () => {
  const germanOnly = [voice('Microsoft Hedda Desktop', 'de-DE', true)];
  assert.equal(matchVoiceName('Samantha', germanOnly), 'Microsoft Hedda Desktop');
});

test('no voices at all yields no name rather than throwing', () => {
  assert.equal(matchVoiceName('Samantha', []), undefined);
});

test('an unnamed voice still resolves to something speakable', () => {
  assert.equal(matchVoiceName(undefined, WINDOWS), 'Microsoft David Desktop');
});

test('a pet authored to be silent stays silent', () => {
  // `engine: 'none'` is a choice, not an absence — honouring it is the whole
  // difference between a setting and a suggestion.
  assert.equal(resolvePetVoice({ engine: 'none', pitch: 1, rate: 1 }, WINDOWS), null);
});

test('a pet with no voice block at all does not speak', () => {
  assert.equal(resolvePetVoice(null, WINDOWS), null);
  assert.equal(resolvePetVoice(undefined, WINDOWS), null);
});

test('a system pet carries its authored pitch and rate through', () => {
  const settings = resolvePetVoice(
    { engine: 'system', name: 'Zira', pitch: 1.6, rate: 0.8 },
    WINDOWS,
  );

  assert.equal(settings?.voiceName, 'Microsoft Zira Desktop');
  assert.equal(settings?.pitch, 1.6);
  assert.equal(settings?.rate, 0.8);
});

test('a pet whose voice is missing still speaks, in a substitute', () => {
  const settings = resolvePetVoice(
    { engine: 'system', name: 'Samantha', pitch: 1, rate: 1 },
    WINDOWS,
  );

  assert.ok(settings, 'a missing voice must not silence the pet');
  assert.ok(settings.voiceName, 'a substitute should have been chosen');
});
