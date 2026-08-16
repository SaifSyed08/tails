import assert from 'node:assert/strict';
import test from 'node:test';

import { expandLocalCommand } from '@/modules/chat/commands.service.js';

// Client code, reached by path: it imports nothing, and this is the repo's only
// test runner. See the note in answers.test.ts.
import { readStyledCommand } from '../../../../src/components/chat/commandNames.js';

const expands = (text: string) => expandLocalCommand(text) !== text;

test('ultracode answers to a slash, a backslash, or nothing at all', () => {
  for (const text of ['/ultracode port the panel', '\\ultracode port the panel', 'ultracode port the panel']) {
    assert.equal(expands(text), true, text);
    assert.match(expandLocalCommand(text), /port the panel/, `${text} keeps its argument`);
    assert.match(expandLocalCommand(text), /Task tool/, `${text} reaches the real expansion`);
  }
});

test('the bare word is case-insensitive and works with no argument', () => {
  assert.equal(expands('ULTRACODE'), true);
  assert.equal(expands('Ultracode the parser'), true);
});

test('ultracode mid-sentence is a sentence', () => {
  // The whole reason bare triggering is opt-in: this has to send as prose.
  for (const text of [
    'can you ultracode this',
    'what does ultracode do?',
    'look at src/ultracode.ts',
  ]) {
    assert.equal(expands(text), false, text);
  }
});

test('a word that merely begins with the command is left alone', () => {
  assert.equal(expands('ultracoded the parser already'), false);
  assert.equal(expands('ultracodex'), false);
});

test('bare triggering does not leak to the other commands', () => {
  assert.equal(expands('personalize make it warmer'), false, 'a word people write in sentences');
  assert.equal(expands('\\personalize'), false);
  assert.equal(expands('/personalize make it warmer'), true, 'but the slash still works');
});

test('the styled token matches wherever the command is armed', () => {
  for (const [text, token] of [
    ['/ultracode go', '/ultracode'],
    ['\\ultracode go', '\\ultracode'],
    ['ultracode go', 'ultracode'],
    ['  ultracode go', 'ultracode'],
  ] as const) {
    const styled = readStyledCommand(text);
    assert.equal(styled?.name, 'ultracode', text);
    // Echoed exactly as typed, so the transcript reads back as what was written.
    assert.equal(styled?.token, token, text);
  }
});

test('the styled token and the expansion agree about what is a command', () => {
  const cases = [
    '/ultracode go', '\\ultracode go', 'ultracode go', 'ULTRACODE',
    'can you ultracode this', 'ultracoded already', 'personalize it',
    '/personalize it', '\\personalize it', 'look at src/ultracode.ts', 'hello',
  ];

  for (const text of cases) {
    assert.equal(
      readStyledCommand(text) !== null,
      expands(text),
      `${text}: the composer must not promise a look the runtime will not honour`,
    );
  }
});
