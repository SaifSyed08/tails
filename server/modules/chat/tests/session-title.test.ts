import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseAdoptedTitle } from '@/modules/sessions/sessions.service.js';

const base = { current: 'Fix the parser bug in the tokenizer', pinned: false };

test('the title Claude Code generated replaces the one derived from the first message', () => {
  assert.equal(
    chooseAdoptedTitle({ ...base, customTitle: 'Tokenizer bug' }),
    'Tokenizer bug',
  );
});

test('a name the user chose is never overwritten', () => {
  assert.equal(
    chooseAdoptedTitle({ ...base, pinned: true, customTitle: 'Tokenizer bug' }),
    null,
    'pinned wins over anything the CLI generated',
  );
});

test('nothing is written when there is nothing better to write', () => {
  assert.equal(chooseAdoptedTitle({ ...base }), null, 'no title at all');
  assert.equal(chooseAdoptedTitle({ ...base, customTitle: '   ' }), null, 'blank');
  assert.equal(
    chooseAdoptedTitle({ ...base, summary: base.current }),
    null,
    'the SDK falling back to the first prompt is the text we already have',
  );
});

test('the custom title wins over the summary', () => {
  assert.equal(
    chooseAdoptedTitle({ ...base, customTitle: 'Tokenizer bug', summary: 'Something else' }),
    'Tokenizer bug',
  );
});

test('an over-long generated title is shortened the same way ours are', () => {
  const long = 'A very long generated title that runs well past the sixty character limit';
  const adopted = chooseAdoptedTitle({ ...base, customTitle: long });

  assert.ok(adopted && adopted.length <= 60, `got ${adopted?.length} characters`);
  assert.ok(adopted?.endsWith('…'), 'and says it was shortened');
});
