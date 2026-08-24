import assert from 'node:assert/strict';
import test from 'node:test';

/*
  Client code, reached by path, like the other tests in this folder.

  It reads `localStorage`, which does not exist here — every access is already
  wrapped, because a browser can refuse the store too, so importing it in Node
  exercises exactly the path a user with storage blocked gets: the drafts live
  in memory and nothing throws.
*/
import {
  clearDrafts,
  MAX_DRAFTS,
  MAX_LENGTH,
  NEW_CHAT_DRAFT,
  readDraft,
  writeDraft,
} from '../../../../src/components/chat/draft-store.js';

test('a draft comes back under its own key', () => {
  clearDrafts();
  writeDraft('a', 'half a sentence');
  assert.equal(readDraft('a'), 'half a sentence');
  assert.equal(readDraft('b'), '', 'another conversation is unaffected');
});

test('the conversation that does not exist yet has a slot of its own', () => {
  // The draft nobody can recover from a transcript, because there is no
  // transcript — so it is the one that must not be dropped.
  clearDrafts();
  writeDraft(NEW_CHAT_DRAFT, 'the thing I was about to ask');
  assert.equal(readDraft(NEW_CHAT_DRAFT), 'the thing I was about to ask');
});

test('emptying a draft removes it rather than storing a blank', () => {
  // So the cap counts conversations someone is genuinely mid-sentence in.
  clearDrafts();
  writeDraft('a', 'text');
  writeDraft('a', '');
  assert.equal(readDraft('a'), '');
});

test('the oldest drafts fall off rather than accumulating for ever', () => {
  clearDrafts();
  for (let index = 0; index < MAX_DRAFTS + 5; index += 1) writeDraft(`s${index}`, `draft ${index}`);

  assert.equal(readDraft('s0'), '', 'the first one is gone');
  assert.equal(readDraft('s4'), '', 'and so are the next four');
  assert.equal(readDraft(`s${MAX_DRAFTS + 4}`), `draft ${MAX_DRAFTS + 4}`, 'the newest survived');
});

test('touching a draft makes it recent again', () => {
  // Recency, not insertion: the conversation being typed in right now is the
  // last one that should be evicted, however long ago it was started.
  clearDrafts();
  writeDraft('old', 'still working on this');
  for (let index = 0; index < MAX_DRAFTS - 1; index += 1) writeDraft(`s${index}`, 'x');

  writeDraft('old', 'still working on this, revised');
  writeDraft('newcomer', 'pushes one out');

  assert.equal(readDraft('old'), 'still working on this, revised');
});

test('an enormous paste is truncated rather than stored whole', () => {
  // Writing megabytes to disk on every keystroke is how typing starts to
  // stutter. Past the cap the box still works; the draft simply stops being one
  // of the things that survives a reload.
  clearDrafts();
  writeDraft('a', 'x'.repeat(MAX_LENGTH + 500));
  assert.equal(readDraft('a').length, MAX_LENGTH);
});
