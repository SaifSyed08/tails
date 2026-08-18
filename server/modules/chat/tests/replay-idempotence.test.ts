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

test('every message is handled at most once, whatever kind it is', () => {
  /*
    The guard has to be at the door, not per branch.

    The first attempt keyed `setRealtime` on the message id. That fixed the
    duplicated *message* and left the duplicated *stream* completely untouched,
    because `stream_delta` returns early and accumulates into a ref with `+=`
    — it never reaches that branch. A replay therefore appended the reply to
    itself: measured, a second subscribe re-fed all five deltas of a
    198-character answer.

    Matching on the early return means a kind added later is covered by
    existing, which is the property a per-branch check cannot have.
  */
  assert.match(
    source(),
    /seenRef\.current\.has\(message\.id\)\)\s*return;/,
    'the handler must drop already-seen ids before dispatching on kind',
  );
  assert.match(source(), /seenRef\.current\.add\(message\.id\)/);
});

test('the seen set is dropped with the rest of the conversation state', () => {
  // Ids are unique, so this only grows within one transcript. Carrying it
  // between conversations would keep a set alive for every chat ever opened.
  assert.match(source(), /seenRef\.current = new Set\(\)/);
});

test('the stream accumulator is still additive, which is why the guard matters', () => {
  // If this ever stops being `+=`, the reasoning above changes and the comment
  // at the guard should be revisited rather than silently left wrong.
  assert.match(
    source(),
    /streamBufferRef\.current \+= message\.content/,
    'deltas accumulate; a replayed delta is appended, not re-rendered',
  );
});
