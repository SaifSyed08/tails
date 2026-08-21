import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openPreviewFor, readLocalUrl, readPreview } from '@/modules/preview/preview.tools.js';

/**
 * The preview belongs to the conversation that produced it.
 *
 * It did not, and the symptom was concrete: a Pong game started in one chat
 * appeared beside every other conversation in the app. A preview is the output
 * of a particular piece of work, so opening a different chat has to show that
 * chat's preview or none at all.
 */
describe('previews are per conversation', () => {
  it('shows only in the chat that opened it', () => {
    assert.equal(openPreviewFor('chat-a', 'http://localhost:5173'), true);

    assert.equal(readPreview('chat-a')?.url, 'http://localhost:5173/');
    assert.equal(readPreview('chat-b'), null, 'another chat must not inherit it');
  });

  it('keeps two conversations apart', () => {
    openPreviewFor('chat-a', 'http://localhost:3000');
    openPreviewFor('chat-b', 'http://127.0.0.1:8080');

    assert.match(readPreview('chat-a')?.url ?? '', /3000/);
    assert.match(readPreview('chat-b')?.url ?? '', /8080/);
  });

  it('names the pane after the host and port when no title is given', () => {
    openPreviewFor('chat-c', 'http://localhost:4321');
    assert.equal(readPreview('chat-c')?.title, 'localhost:4321');
  });

  it('refuses an address it cannot show, and opens nothing', () => {
    assert.equal(openPreviewFor('chat-d', 'https://example.com'), false);
    assert.equal(readPreview('chat-d'), null);
  });
});

/*
  The loopback check is the whole security story for the one tool that puts
  arbitrary rendered content inside the window, so it is tested on the shapes
  that are *designed* to look loopback rather than on the obvious ones.
*/
describe('readLocalUrl', () => {
  it('accepts real loopback', () => {
    assert.ok(readLocalUrl('http://localhost:5173'));
    assert.ok(readLocalUrl('http://127.0.0.1:8080/path'));
  });

  it('refuses a host that merely contains one', () => {
    assert.equal(readLocalUrl('http://127.0.0.1.evil.com/'), null);
    assert.equal(readLocalUrl('http://localhost.evil.com/'), null);
  });

  it('refuses credentials, which only ever disguise a host', () => {
    assert.equal(readLocalUrl('http://localhost@evil.com/'), null);
  });

  it('refuses anything that is not http', () => {
    assert.equal(readLocalUrl('file:///etc/passwd'), null);
    assert.equal(readLocalUrl('not a url'), null);
  });
});
