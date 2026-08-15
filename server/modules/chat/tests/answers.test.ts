import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveQuestionAnswers } from '@/modules/chat/claude-runtime.js';
import type { AskUserQuestion } from '@/shared/types.js';

// The composer half of the same bug lives in the client, and this is the only
// test runner in the repo, so it is reached by path. It imports nothing, which
// is what makes that possible.
import { composeAnswer } from '../../../../src/components/chat/answers.js';

const question = (text: string, multiSelect = false): AskUserQuestion => ({
  question: text,
  header: '',
  multiSelect,
  options: [
    { label: 'First', description: '' },
    { label: 'Second', description: '' },
  ],
});

test('a typed answer with no option picked still answers the question', () => {
  const answers = resolveQuestionAnswers(
    { answers: {}, response: 'neither, do it the other way' },
    [question('Which approach?')],
  );

  assert.deepEqual(answers, { 'Which approach?': 'neither, do it the other way' });
});

test('the answer is keyed by the question text the tool sent, verbatim', () => {
  const text = 'Should I refactor the parser, or leave it? (be specific)';
  const answers = resolveQuestionAnswers({ response: 'leave it' }, [question(text)]);

  assert.deepEqual(Object.keys(answers), [text]);
});

test('picked options are passed through untouched', () => {
  const answers = resolveQuestionAnswers(
    { answers: { 'Which approach?': 'First' }, response: 'and please be quick' },
    [question('Which approach?')],
  );

  assert.equal(answers['Which approach?'], 'First');
});

test('free text against several questions is not guessed at', () => {
  const answers = resolveQuestionAnswers(
    { answers: {}, response: 'whatever you think' },
    [question('First question?'), question('Second question?')],
  );

  assert.deepEqual(answers, {}, 'attaching it to one of them would be a fabricated answer');
});

test('whitespace-only free text is not an answer', () => {
  assert.deepEqual(resolveQuestionAnswers({ response: '   ' }, [question('Which?')]), {});
});

test('multi-select answers are comma-separated, as the tool documents', () => {
  assert.equal(composeAnswer(['First', 'Second'], ''), 'First, Second');
});

test('picked options and typed text combine into one answer string', () => {
  assert.equal(composeAnswer(['First'], 'and also rename it'), 'First, and also rename it');
  assert.equal(composeAnswer([], '  just do it  '), 'just do it');
  assert.equal(composeAnswer([], ''), '');
});

test('a mixed card produces one answer per question, each a single string', () => {
  const questions = [question('Pick some', true), question('Pick one'), question('Say anything')];
  const composed = {
    [questions[0].question]: composeAnswer(['First', 'Second'], ''),
    [questions[1].question]: composeAnswer(['Second'], ''),
    [questions[2].question]: composeAnswer([], 'somewhere else entirely'),
  };

  // Nothing to fall back on: every question already carries its own answer.
  assert.deepEqual(resolveQuestionAnswers({ answers: composed }, questions), {
    'Pick some': 'First, Second',
    'Pick one': 'Second',
    'Say anything': 'somewhere else entirely',
  });
});
