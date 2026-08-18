import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * A protocol that can re-deliver needs a consumer that can absorb it.
 *
 * `chat.subscribe` replays the run buffer from `lastSeq`, and that is a
 * feature — it is what makes a mid-stream refresh or a dropped connection
 * recover the turn instead of losing it. The client consumed it with a plain
 * append, so every replay added a second copy of messages it already had.
 *
 * Verified against the running gateway rather than inferred: two subscribes
 * with the same `lastSeq` delivered the identical message twice, same `id` and
 * same `seq`. React's StrictMode makes it routine in development because the
 * subscribe effect has no cleanup and fires twice on mount, but the fault was
 * never StrictMode's — it only made a latent bug reliable.
 *
 * This pins the client side by shape, because the behaviour lives in a React
 * state updater that the server test runner cannot execute.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.resolve(
  HERE, '..', '..', '..', '..', 'src', 'components', 'chat', 'useChatSession.ts',
);

const source = (): string => fs.readFileSync(SESSION, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*/g, '');

test('realtime messages are added at most once', () => {
  assert.match(
    source(),
    /setRealtime\(\(current\) => \(?\s*current\.some\(\(existing\) => existing\.id === message\.id\)/,
    'realtime delivery must be keyed on message id; chat.subscribe replays the '
    + 'run buffer and an append-only consumer shows every replayed message twice',
  );
});

test('the naive append is gone', () => {
  assert.doesNotMatch(
    source(),
    /setRealtime\(\(current\) => \[\s*\.\.\.current,\s*message\s*\]\)/,
    'this is the append that duplicated every replayed message',
  );
});

test('deduping is by identity, not by content', () => {
  // Two identical messages are two messages — someone who says "ok" twice sent
  // two. `mergeTranscript` already treats that as a multiset. This layer is
  // only about the *same* message arriving more than once, so it must key on
  // the id and nothing else.
  assert.doesNotMatch(
    source(),
    /setRealtime[\s\S]{0,220}existing\.content === message\.content/,
    'content matching would collapse two genuinely repeated messages into one',
  );
});
