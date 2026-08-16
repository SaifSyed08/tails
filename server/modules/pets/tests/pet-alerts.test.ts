import assert from 'node:assert/strict';
import test from 'node:test';

// Shell code, reached by path: it imports nothing, and this is the repo's only
// test runner. Same arrangement as `pet-geometry.test.ts`.
import {
  addAlert,
  clearAlert,
  describeAlerts,
  MAX_TITLE,
  truncateTitle,
} from '../../../../electron/pet-alerts.js';

/**
 * What the pet says when work finishes while you are away.
 *
 * Worth testing because the interesting cases are the ones nobody sits and
 * reproduces: three chats finishing while the window is minimised, the same
 * chat finishing twice, a chat with no title at all. Each of those is a
 * sentence a user reads, and a wrong one is either a lie about how much is
 * waiting or a bubble that says nothing.
 */

const at = (n: number) => ({ at: n });

test('a short title is left exactly as it is', () => {
  assert.equal(truncateTitle('Fix the drag bug'), 'Fix the drag bug');
  assert.equal(truncateTitle('  Fix   the drag bug  '), 'Fix the drag bug');
});

test('a long title is cut on a word, and marked', () => {
  const long = 'Rework the desktop pet click-through handshake and the drag region';
  const short = truncateTitle(long);

  assert.ok(short.length <= MAX_TITLE, `${short.length} characters`);
  assert.ok(short.endsWith('…'));
  assert.ok(!short.includes('  '));
  // A word boundary when one is close enough, rather than a cut mid-word.
  assert.ok(long.startsWith(short.slice(0, -1).trimEnd()));
});

test('a chat with no name still gets a sentence', () => {
  // Draft conversations exist, and "is ready!" on its own is not a sentence.
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(truncateTitle(empty as unknown as string), 'A chat');
  }
});

test('the newest chat is named and the rest are counted', () => {
  let alerts = addAlert([], { sessionId: 'a', title: 'Fix the drag bug', ...at(1) });
  assert.deepEqual(describeAlerts(alerts), {
    sessionId: 'a', text: 'Fix the drag bug is ready!', others: 0,
  });

  alerts = addAlert(alerts, { sessionId: 'b', title: 'Voice input', ...at(2) });
  alerts = addAlert(alerts, { sessionId: 'c', title: 'Model picker', ...at(3) });

  assert.deepEqual(describeAlerts(alerts), {
    sessionId: 'c', text: 'Model picker is ready!', others: 2,
  });
});

test('one chat finishing twice is still one chat waiting', () => {
  let alerts = addAlert([], { sessionId: 'a', title: 'First turn', ...at(1) });
  alerts = addAlert(alerts, { sessionId: 'a', title: 'Second turn', ...at(2) });

  assert.equal(alerts.length, 1);
  assert.equal(describeAlerts(alerts)?.text, 'Second turn is ready!', 'and the newest name wins');
});

test('a chat that finished again after another one moves back to the front', () => {
  // Order is what decides who is named, so a chat that speaks last is named
  // last, even if it had already been waiting.
  let alerts = addAlert([], { sessionId: 'a', title: 'Older', ...at(1) });
  alerts = addAlert(alerts, { sessionId: 'b', title: 'Newer', ...at(2) });
  alerts = addAlert(alerts, { sessionId: 'a', title: 'Older, again', ...at(3) });

  assert.equal(describeAlerts(alerts)?.sessionId, 'a');
  assert.equal(describeAlerts(alerts)?.others, 1);
});

test('viewing a chat clears only that chat', () => {
  let alerts = addAlert([], { sessionId: 'a', title: 'One', ...at(1) });
  alerts = addAlert(alerts, { sessionId: 'b', title: 'Two', ...at(2) });

  alerts = clearAlert(alerts, 'b');
  assert.deepEqual(alerts.map((entry) => entry.sessionId), ['a']);

  alerts = clearAlert(alerts, 'a');
  assert.equal(describeAlerts(alerts), null, 'and nothing left to say');

  // Clearing something that was never there is not an error: the renderer
  // reports every chat you look at, most of which are not waiting on you.
  assert.deepEqual(clearAlert(alerts, 'nobody'), []);
});
