import assert from 'node:assert/strict';
import test from 'node:test';

// Client code, reached by path: it imports nothing, and this is the repo's only
// test runner. See the note in answers.test.ts.
import { buildThinkingRotation, readPetPhrases } from '../../../../src/components/chat/thinkingPhrases.js';

const BASE = ['Thinking', 'Pondering', 'Noodling', 'Ruminating', 'Percolating', 'Cogitating'];
const SONIC = ['collecting rings...', 'pondering around at the speed of sound...'];

test('no pet leaves the rotation exactly as it was', () => {
  assert.deepEqual(buildThinkingRotation(BASE, undefined), BASE.map((word) => `${word}…`));
  assert.deepEqual(buildThinkingRotation(BASE, []), BASE.map((word) => `${word}…`));
});

test("a pet's lines are mixed in, not substituted for the rotation", () => {
  const rotation = buildThinkingRotation(BASE, SONIC);
  const petLines = rotation.filter((entry) => SONIC.includes(entry));

  for (const word of BASE) {
    assert.ok(rotation.includes(`${word}…`), `${word} should survive`);
  }
  assert.ok(petLines.length > 0, 'and the pet should get a word in');
  assert.ok(
    petLines.length < rotation.length / 2,
    'but never most of them — the ordinary words are what say work is happening',
  );
});

test('the lines are spaced out rather than clumped together', () => {
  const rotation = buildThinkingRotation(BASE, SONIC);
  for (let index = 1; index < rotation.length; index += 1) {
    const consecutive = SONIC.includes(rotation[index]) && SONIC.includes(rotation[index - 1]);
    assert.equal(consecutive, false, 'two pet lines in a row');
  }
});

test('a pet with one line still says it more than once in a long run', () => {
  const rotation = buildThinkingRotation(BASE, ['gotta go fast']);
  assert.ok(rotation.filter((entry) => entry === 'gotta go fast').length > 1);
});

test('user-authored text is treated as hostile input', () => {
  const cleaned = readPetPhrases([
    '  collecting   rings...  ',
    'line one\nline two',
    '',
    '   ',
    'x'.repeat(200),
  ]);

  assert.equal(cleaned[0], 'collecting rings...', 'whitespace collapsed and trimmed');
  assert.equal(cleaned[1], 'line one line two', 'a phrase cannot become two rows');
  assert.equal(cleaned.length, 3, 'empties dropped');
  assert.ok(cleaned[2].length <= 48, 'and nothing runs off the end of the row');
  assert.ok(cleaned[2].endsWith('…'), 'a truncated line says it was truncated');
});

test('a pet cannot flood the rotation with phrases', () => {
  const many = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  assert.equal(readPetPhrases(many).length, 8);
});

test('non-strings from an unvalidated pet definition are ignored', () => {
  const messy = [null, 42, { text: 'nope' }, 'real one'] as unknown as string[];
  assert.deepEqual(readPetPhrases(messy), ['real one']);
});
