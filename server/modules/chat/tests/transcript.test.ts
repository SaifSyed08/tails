import assert from 'node:assert/strict';
import test from 'node:test';

// Client code, reached by path: it imports nothing, and this is the repo's
// only test runner. See the note in answers.test.ts.
import { mergeTranscript, unaccountedFor } from '../../../../src/components/chat/transcript.js';

const text = (role: 'user' | 'assistant', content: string) => ({ kind: 'text', role, content });

test('a complete reload accounts for every live message', () => {
  const live = [text('user', 'hello'), text('assistant', 'hi there')];
  const history = [text('user', 'hello'), text('assistant', 'hi there')];

  assert.deepEqual(unaccountedFor(history, live), []);
  assert.equal(mergeTranscript(history, live).length, 2, 'and nothing renders twice');
});

test('a reload that comes back empty does not erase the turn', () => {
  // The real failure: the transcript read resolved to the wrong project
  // directory and returned zero messages instead of failing.
  const live = [text('user', 'what changed?'), text('assistant', 'Three files.')];

  assert.deepEqual(unaccountedFor([], live), live);
  assert.deepEqual(mergeTranscript([], live), live);
});

test('a partial reload keeps only what it is missing', () => {
  const live = [text('user', 'what changed?'), text('assistant', 'Three files.')];
  const history = [text('user', 'what changed?')];

  assert.deepEqual(unaccountedFor(history, live), [text('assistant', 'Three files.')]);
  assert.equal(mergeTranscript(history, live).length, 2);
});

test('the same message twice is two messages, not one', () => {
  const live = [text('user', 'ok'), text('user', 'ok')];

  assert.equal(unaccountedFor([text('user', 'ok')], live).length, 1);
  assert.equal(unaccountedFor([text('user', 'ok'), text('user', 'ok')], live).length, 0);
});

test('tool calls and their results are matched by id and payload', () => {
  const call = { kind: 'tool_use', role: 'assistant' as const, toolName: 'Bash', toolId: 'tool-1' };
  const result = { kind: 'tool_result', toolId: 'tool-1', toolResult: { content: '18 entries' } };
  const other = { kind: 'tool_result', toolId: 'tool-1', toolResult: { content: 'something else' } };

  assert.deepEqual(unaccountedFor([call, result], [call, result]), []);
  assert.deepEqual(unaccountedFor([call, other], [call, result]), [result]);
});

test('history order is preserved, with the remainder appended', () => {
  const history = [text('user', 'one'), text('assistant', 'two')];
  const live = [text('assistant', 'two'), text('user', 'three')];

  assert.deepEqual(mergeTranscript(history, live), [...history, text('user', 'three')]);
});
