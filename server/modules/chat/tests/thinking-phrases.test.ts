import assert from 'node:assert/strict';
import test from 'node:test';

// Client code, reached by path: it imports nothing, and this is the repo's only
// test runner. See the note in answers.test.ts.
import {
  buildThinkingRotation,
  isSpinnerVerb,
  readPetPhrases,
  SPINNER_VERBS,
} from '../../../../src/components/chat/thinkingPhrases.js';

const BASE = SPINNER_VERBS;
/**
 * A seeded uniform source, so the ratio and ordering rules can be asserted
 * rather than sampled. Mulberry32 — small, uniform enough for this.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every entry across many rotations, so ratios are measured on a real sample. */
function sample(phrases: readonly string[], runs = 200): string[] {
  return Array.from({ length: runs }, (_, i) => buildThinkingRotation(phrases, seeded(i + 1))).flat();
}

const SONIC = ['collecting rings...', 'pondering around at the speed of sound...'];

test('no pet leaves the rotation exactly as it was', () => {
  assert.deepEqual(buildThinkingRotation(undefined), BASE.map((word) => `${word}…`));
  assert.deepEqual(buildThinkingRotation([]), BASE.map((word) => `${word}…`));
});

test("a pet's lines are mixed in, not substituted for the rotation", () => {
  const entries = sample(SONIC);
  const petLines = entries.filter((entry) => SONIC.includes(entry));

  assert.ok(petLines.length > 0, 'the pet should get a word in');
  assert.ok(
    petLines.length < entries.length,
    'but the ordinary verbs are what say work is happening, so they cannot vanish',
  );
});

test('a pet speaks in roughly three slots out of five', () => {
  const entries = sample(SONIC);
  const share = entries.filter((entry) => SONIC.includes(entry)).length / entries.length;

  // Measured over ~8000 slots, so the band is tight; the point is that the
  // split is deliberate and better than even, not exactly 0.6 on any one run.
  assert.ok(share > 0.5 && share < 0.7, `pet share was ${share.toFixed(3)}`);
});

test('nothing ever follows itself, including around the loop', () => {
  // Adjacent pet lines are expected now — three slots in five — but the *same*
  // line twice in a row reads as the indicator having frozen. The indicator
  // walks the rotation cyclically, so the last entry and the first are
  // neighbours as well; that seam is only visible once a lap, which is exactly
  // the kind of repeat that survives a casual look.
  for (const phrases of [SONIC, ['only one thing to say']]) {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rotation = buildThinkingRotation(phrases, seeded(seed));
      for (let index = 1; index < rotation.length; index += 1) {
        assert.notEqual(rotation[index], rotation[index - 1], `repeated ${rotation[index]}`);
      }
      assert.notEqual(
        rotation[rotation.length - 1],
        rotation[0],
        'the loop wraps onto a repeat',
      );
    }
  }
});

test('a pet with a single line falls back to a verb rather than repeating it', () => {
  const rotation = buildThinkingRotation(['gotta go fast'], seeded(7));
  const petSlots = rotation.filter((entry) => entry === 'gotta go fast').length;

  assert.ok(petSlots > 0, 'it still speaks');
  assert.ok(petSlots <= Math.ceil(rotation.length / 2), 'but cannot occupy neighbouring slots');
});

test('the same seed always produces the same rotation', () => {
  assert.deepEqual(
    buildThinkingRotation(SONIC, seeded(42)),
    buildThinkingRotation(SONIC, seeded(42)),
  );
  assert.notDeepEqual(
    buildThinkingRotation(SONIC, seeded(42)),
    buildThinkingRotation(SONIC, seeded(43)),
    'and a different one does not',
  );
});

test('a pet with one line still says it more than once in a long run', () => {
  const rotation = buildThinkingRotation(['gotta go fast'], seeded(3));
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
  assert.ok(cleaned[2].length <= 72, 'and nothing runs off the end of the row');
  assert.ok(cleaned[2].endsWith('…'), 'a truncated line says it was truncated');
});

test('a pet cannot flood the rotation with phrases', () => {
  const many = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  assert.equal(readPetPhrases(many).length, 12);
});

test('non-strings from an unvalidated pet definition are ignored', () => {
  const messy = [null, 42, { text: 'nope' }, 'real one'] as unknown as string[];
  assert.deepEqual(readPetPhrases(messy), ['real one']);
});

test('the pet may only ever talk over a generic spinner verb', () => {
  // The gate. Everything the rotation can show is either one of our own
  // interchangeable verbs or a line the pet's author wrote; nothing carrying
  // information from the run can appear in it at all.
  const rotation = buildThinkingRotation(SONIC, seeded(11));
  const petLines = new Set(SONIC);

  for (const entry of rotation) {
    assert.ok(
      isSpinnerVerb(entry) || petLines.has(entry),
      `${entry} is neither a spinner verb nor one of the pet's lines`,
    );
  }
});

test('real status text is not mistaken for a generic verb', () => {
  // These are the shapes that must never be substitutable. `detail` carries
  // them, and it is rendered on a path that never reaches this module.
  for (const status of [
    'Compacting context',
    'Running Bash',
    'Context automatically compacted.',
    'Waiting for permission',
    'Editing src/index.css',
  ]) {
    assert.equal(isSpinnerVerb(status), false, status);
  }
});

test('a verb is recognised however the rotation draws it', () => {
  assert.equal(isSpinnerVerb('Thinking'), true);
  assert.equal(isSpinnerVerb('Thinking…'), true, 'with the ellipsis the rotation adds');
  assert.equal(isSpinnerVerb('thinking...'), true, 'and case- and dot-insensitively');
  assert.equal(isSpinnerVerb('Thinking hard about the parser'), false, 'but not as a prefix');
});
