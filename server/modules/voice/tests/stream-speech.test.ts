import assert from 'node:assert/strict';
import test from 'node:test';

// Client code, reached by path: it imports nothing, and this is the repo's only
// test runner. See the note in answers.test.ts.
import {
  CHUNK_SENTENCES,
  nextSpeakable,
} from '../../../../src/components/voice/stream-speech.js';

/** Feeds a reply in slices, as it would arrive, and collects what was spoken. */
function stream(parts: string[]): { chunks: string[]; total: string } {
  let reply = '';
  let spoken = 0;
  const chunks: string[] = [];

  for (const part of parts) {
    reply += part;
    const next = nextSpeakable(reply, spoken);
    if (next) {
      spoken = next.cut;
      chunks.push(next.text);
    }
  }

  const tail = nextSpeakable(reply, spoken, true);
  if (tail) chunks.push(tail.text);

  return { chunks, total: chunks.join('') };
}

test('nothing is spoken until there are enough sentences to sound whole', () => {
  assert.equal(nextSpeakable('One thing. Two things.', 0), null);
});

test('three sentences are enough', () => {
  const chunk = nextSpeakable('One. Two. Three.', 0);
  assert.ok(chunk);
  assert.equal(chunk.text, 'One. Two. Three.');
  assert.equal(chunk.cut, 16);
});

test('CHUNK_SENTENCES is the number that decides it', () => {
  const sentences = Array.from({ length: CHUNK_SENTENCES - 1 }, (_, i) => `S${i}.`).join(' ');
  assert.equal(nextSpeakable(sentences, 0), null);
  assert.ok(nextSpeakable(`${sentences} One more.`, 0));
});

test('a whole reply is spoken exactly once, in order, with nothing lost', () => {
  // The property that matters most: a watermark bug either repeats a sentence
  // or swallows one, and both are obvious out loud and invisible on screen.
  const { chunks, total } = stream([
    'The build passes. ',
    'Two tests were failing and both are fixed now. ',
    'The first was a timing issue. ',
    'The second was a typo in the fixture. ',
    'Nothing else changed.',
  ]);

  assert.ok(chunks.length >= 2, 'it should start speaking before the turn ends');
  assert.equal(
    total,
    'The build passes. Two tests were failing and both are fixed now. The first was a '
    + 'timing issue. The second was a typo in the fixture. Nothing else changed.',
  );
});

test('the tail is released when the turn ends, however short it is', () => {
  // Holding back the last sentence of an answer because it is only one
  // sentence would be the worst bug this feature could have.
  const first = nextSpeakable('One. Two. Three.', 0);
  assert.ok(first);

  // One more sentence arrives — below the threshold, so nothing goes out while
  // the turn is still running.
  const grown = 'One. Two. Three. And finally this.';
  assert.equal(nextSpeakable(grown, first.cut), null);

  const tail = nextSpeakable(grown, first.cut, true);
  assert.ok(tail);
  assert.equal(tail.text.trim(), 'And finally this.');
});

test('a decimal point is not the end of a sentence', () => {
  assert.equal(nextSpeakable('It went from 1.5 to 2.5 to 3.5', 0), null);
});

test('a filename is not the end of a sentence', () => {
  assert.equal(nextSpeakable('Look at a.ts and b.ts and c.ts', 0), null);
});

test('common abbreviations do not end a sentence', () => {
  assert.equal(nextSpeakable('Try e.g. this. Or i.e. that.', 0), null);
});

test('a chunk never cuts inside a code fence', () => {
  // Cutting here would hand `toSpeech` half a fence, which no longer looks
  // like a code block — so it would be read out as code, character by
  // character, which is the exact thing the speech layer exists to prevent.
  const reply = 'Here it is. Look at this.\n```ts\nconst a = 1.\nconst b = 2.\n';
  const chunk = nextSpeakable(reply, 0);

  if (chunk) assert.ok(!chunk.text.includes('```'), 'must not open a fence it does not close');
});

test('a closed code fence is not a barrier once it is complete', () => {
  const reply = 'First. Second.\n```ts\nconst a = 1;\n```\nThat is the whole change.';
  const chunk = nextSpeakable(reply, 0, true);

  assert.ok(chunk);
  assert.match(chunk.text, /whole change/);
});

test('everything available goes out together rather than three at a time', () => {
  // If the model got ahead while a chunk was being read, sending one long
  // chunk beats sending two, because the gap between utterances disappears.
  const chunk = nextSpeakable('A. B. C. D. E. F.', 0);
  assert.ok(chunk);
  assert.equal(chunk.text, 'A. B. C. D. E. F.');
});

test('an empty or whitespace-only reply says nothing, even at the end', () => {
  assert.equal(nextSpeakable('', 0, true), null);
  assert.equal(nextSpeakable('   \n  ', 0, true), null);
});

test('a reply that is already fully spoken produces nothing more', () => {
  const reply = 'One. Two. Three.';
  const first = nextSpeakable(reply, 0);
  assert.ok(first);
  assert.equal(nextSpeakable(reply, first.cut, true), null);
});
