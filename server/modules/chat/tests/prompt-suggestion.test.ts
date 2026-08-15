import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSdkMessage } from '@/modules/chat/normalize.js';

/** The shape the CLI emits after a turn, verified against a live two-turn run. */
const suggestionEvent = (suggestion: unknown) => ({
  type: 'prompt_suggestion',
  suggestion,
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: 'provider-session',
});

test('a prompt suggestion becomes its own event, scoped to the app session', () => {
  const [message, ...rest] = normalizeSdkMessage(suggestionEvent('write the README'), 'app-session');

  assert.equal(rest.length, 0);
  assert.equal(message.kind, 'prompt_suggestion');
  assert.equal(message.sessionId, 'app-session');
  assert.equal(message.content, 'write the README');
  // Not a chat row: it carries no role, so nothing can render it as a bubble.
  assert.equal(message.role, undefined);
});

test('an empty suggestion is dropped rather than offered as blank ghost text', () => {
  assert.deepEqual(normalizeSdkMessage(suggestionEvent('   '), 'app-session'), []);
  assert.deepEqual(normalizeSdkMessage(suggestionEvent(undefined), 'app-session'), []);
});
