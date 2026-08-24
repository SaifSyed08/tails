import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_VOICE, normalizeDefaultVoice } from '@/modules/preferences/default-voice.js';

// Client code, reached by path — the same arrangement the voice module's own
// tests use. The resolver has to be tested beside the stored shape it consumes,
// because the interesting behaviour is the seam between them.
import { resolveVoice } from '../../../../src/components/settings/default-voice.js';
import type { PetVoice } from '../../../../src/components/voice/pet-voice.js';

const voice = (name: string, lang = 'en-US', isDefault = false) => ({ name, lang, isDefault });

const WINDOWS = [
  voice('Microsoft David Desktop', 'en-US', true),
  voice('Microsoft Zira Desktop', 'en-US'),
  voice('Microsoft Hedda Desktop', 'de-DE'),
];

test('an empty name is not a chosen voice', () => {
  // '' is what a cleared <select> sends. Stored as-is it would be a voice name
  // no platform will ever report, which resolves as "chosen but missing"
  // instead of "not chosen".
  assert.equal(normalizeDefaultVoice({ name: '' }).name, null);
  assert.equal(normalizeDefaultVoice({ name: '   ' }).name, null);
  assert.equal(normalizeDefaultVoice({}).name, null);
});

test('nonsense from the wire cannot reach the database', () => {
  assert.deepEqual(normalizeDefaultVoice(null), DEFAULT_VOICE);
  assert.deepEqual(normalizeDefaultVoice('Zira'), DEFAULT_VOICE);
  assert.deepEqual(
    normalizeDefaultVoice({ name: 'Zira', pitch: 99, rate: -4 }),
    { name: 'Zira', pitch: 2, rate: 0.1, elevenVoiceId: null },
  );
  assert.deepEqual(
    normalizeDefaultVoice({ name: 'Zira', pitch: Number.NaN, rate: 'fast' }),
    { name: 'Zira', pitch: 1, rate: 1, elevenVoiceId: null },
  );
});

test('a cloud voice is kept beside the local one, not instead of it', () => {
  // Turning the cloud voice off has to return the user to the platform voice
  // they had, rather than to nothing — so both are stored and the resolver
  // decides which answers.
  const voice = normalizeDefaultVoice({ name: 'Zira', elevenVoiceId: '  abc123  ' });
  assert.equal(voice.elevenVoiceId, 'abc123', 'trimmed, like every other pasted value');
  assert.equal(voice.name, 'Zira');
});

test('an empty or absent cloud voice is null, never an empty string', () => {
  // "" is what a cleared control sends, and storing it would be an id no vendor
  // will ever report — "chosen, but missing" rather than "not chosen".
  assert.equal(normalizeDefaultVoice({ elevenVoiceId: '' }).elevenVoiceId, null);
  assert.equal(normalizeDefaultVoice({ elevenVoiceId: '   ' }).elevenVoiceId, null);
  assert.equal(normalizeDefaultVoice({ elevenVoiceId: 42 }).elevenVoiceId, null);
  assert.equal(normalizeDefaultVoice({}).elevenVoiceId, null);
});

test('the name is stored exactly as picked, never resolved on the server', () => {
  // The server cannot see the voice list, so a name it "helpfully" normalised
  // would be a guess that `matchVoiceName` then has to undo. Only trimmed.
  const stored = normalizeDefaultVoice({ name: '  Microsoft Zira - English (United States)  ' });

  assert.equal(stored.name, 'Microsoft Zira - English (United States)');
});

test('a pet with its own voice keeps it', () => {
  const pet: PetVoice = { engine: 'system', name: 'Zira', pitch: 1.4, rate: 0.8 };
  const settings = resolveVoice(pet, { name: 'Microsoft Hedda Desktop', pitch: 1, rate: 1 }, WINDOWS);

  assert.deepEqual(settings, { voiceName: 'Microsoft Zira Desktop', rate: 0.8, pitch: 1.4 });
});

test('ENFORCED: a pet kept quiet on purpose is not given the default', () => {
  /*
    The one case that would make this feature feel broken rather than helpful.
    `engine: 'none'` is an authored decision — the pets module is careful to
    keep it distinct from `null`, which means "nothing stored, ask the manifest"
    — and a fallback that overrode it would take a pet somebody deliberately
    silenced and hand it a voice.
  */
  const silent: PetVoice = { engine: 'none', pitch: 1, rate: 1 };

  assert.equal(resolveVoice(silent, { name: 'Microsoft Zira Desktop', pitch: 1, rate: 1 }, WINDOWS), null);
});

test('a chat with no pet falls through to the default', () => {
  const settings = resolveVoice(null, { name: 'Zira', pitch: 1.2, rate: 1.1 }, WINDOWS);

  assert.deepEqual(settings, { voiceName: 'Microsoft Zira Desktop', rate: 1.1, pitch: 1.2 });
});

test('a pet with nothing stored falls through to the default', () => {
  // `undefined` is the pet whose voice has never been set — the second half of
  // what the user reported having no answer for.
  const settings = resolveVoice(undefined, { name: 'Zira', pitch: 1, rate: 1 }, WINDOWS);

  assert.equal(settings?.voiceName, 'Microsoft Zira Desktop');
});

test('no default chosen still reaches the platform default', () => {
  // The third tier, and it needs no code of its own: a null name reaches
  // `matchVoiceName` as undefined, which is already its "pick something
  // sensible" path.
  const settings = resolveVoice(null, DEFAULT_VOICE, WINDOWS);

  assert.equal(settings?.voiceName, 'Microsoft David Desktop', 'the voice the platform marks as its own');
});

test('the default survives being written on another operating system', () => {
  // The whole reason the name is stored verbatim and matched late. These two
  // strings are the same speaker and share no substring, so anything comparing
  // them directly returns nothing and the app goes silent for no visible reason.
  const settings = resolveVoice(
    null,
    { name: 'Microsoft Zira - English (United States)', pitch: 1, rate: 1 },
    WINDOWS,
  );

  assert.equal(settings?.voiceName, 'Microsoft Zira Desktop');
});

test('a default naming a voice this machine does not have still speaks', () => {
  // Degrading to a same-language voice beats refusing to talk. `matchVoiceName`
  // owns that ladder; this asserts the default is actually going through it.
  const settings = resolveVoice(null, { name: 'Samantha', pitch: 1, rate: 1 }, WINDOWS);

  assert.ok(settings?.voiceName, 'a missing voice must not produce silence');
});

test('no voices at all is not a crash', () => {
  const settings = resolveVoice(null, { name: 'Zira', pitch: 1, rate: 1 }, []);

  assert.equal(settings?.voiceName, null, 'null hands the choice back to the synthesiser');
});
