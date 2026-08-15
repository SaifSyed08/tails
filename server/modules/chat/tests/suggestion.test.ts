import assert from 'node:assert/strict';
import test from 'node:test';

import { expandLocalCommand, LOCAL_COMMANDS } from '@/modules/chat/commands.service.js';

// Client code, reached by path: it imports nothing, and this is the repo's only
// test runner. See the note in answers.test.ts.
import { endsSuggestion } from '../../../../src/components/chat/suggestion.js';

test('a turn that starts without the composer still retires the suggestion', () => {
  // The `/personalize` flow: the conversation advances through question and
  // plan cards, so `sendMessage` — the only thing that used to clear it — is
  // never called, and one suggestion sat there through the whole exchange.
  for (const kind of ['question_request', 'plan_request', 'permission_request']) {
    assert.equal(endsSuggestion(kind), true, `${kind} should retire it`);
  }
});

test('the model producing anything retires the suggestion', () => {
  for (const kind of ['text', 'thinking', 'tool_use', 'tool_result', 'stream_delta']) {
    assert.equal(endsSuggestion(kind), true, `${kind} should retire it`);
  }
});

test('the end of a turn does not retire the suggestion for that turn', () => {
  // The suggestion arrives *after* `complete`. Treating that as new activity
  // would throw away every suggestion a moment before it could be shown.
  assert.equal(endsSuggestion('complete'), false);
  assert.equal(endsSuggestion('prompt_suggestion'), false);
});

test('bookkeeping events leave it alone', () => {
  for (const kind of ['chat_subscribed', 'session_created', 'sessions_changed', 'appearance_changed']) {
    assert.equal(endsSuggestion(kind), false, `${kind} is not turn activity`);
  }
});

test('/ultracode expands into a real parallel-subagent instruction', () => {
  const expanded = expandLocalCommand('/ultracode port the settings panel');

  assert.match(expanded, /port the settings panel/, 'the task travels with it');
  assert.match(expanded, /Task tool/, 'it names the tool that actually fans out');
  assert.match(expanded, /in a single message/, 'concurrently, not one after another');
  assert.match(expanded, /same file/, 'and warns about the overlapping-edit failure');
  assert.notEqual(expanded, '/ultracode port the settings panel');
});

test('a bare /ultracode still expands', () => {
  assert.match(expandLocalCommand('/ultracode'), /Task tool/);
});

test('both styled commands are registered as local commands', () => {
  assert.ok(LOCAL_COMMANDS.personalize, 'personalize');
  assert.ok(LOCAL_COMMANDS.ultracode, 'ultracode');
});

test('a slash mid-sentence is not a command', () => {
  const text = 'look at src/ultracode.ts and tell me what it does';
  assert.equal(expandLocalCommand(text), text);
});
