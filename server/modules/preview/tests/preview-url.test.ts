import assert from 'node:assert/strict';
import test from 'node:test';

import { readLocalUrl } from '@/modules/preview/preview.tools.js';

/**
 * The loopback check is the whole security story of the preview pane.
 *
 * It is the one place the model chooses what gets *rendered inside the app
 * window*, and the pane has no address bar for the user to check. So the
 * failure mode is not an ugly preview, it is a page that looks like it belongs
 * to this application.
 *
 * Every case below is a string that contains "localhost" or "127.0.0.1" and is
 * not loopback. They are the reason the check parses the URL and compares the
 * hostname rather than searching the text — a substring test passes all of them
 * and looks perfectly reasonable while doing it.
 */

test('ordinary local addresses are allowed', () => {
  for (const url of [
    'http://localhost:5173',
    'http://localhost:5173/some/path?q=1',
    'http://127.0.0.1:3000',
    'https://localhost:8443',
  ]) {
    assert.ok(readLocalUrl(url), `${url} should be allowed`);
  }
});

test('a hostname that merely contains a loopback name is refused', () => {
  // The attack a substring check cannot see. `localhost.evil.com` resolves
  // wherever its owner wants it to.
  for (const url of [
    'http://localhost.evil.com/',
    'http://127.0.0.1.evil.com/',
    'http://notlocalhost/',
    'http://evil.com/?next=http://localhost:5173',
    'http://evil.com/#localhost',
  ]) {
    assert.equal(readLocalUrl(url), null, `${url} must be refused`);
  }
});

test('credentials in the authority are refused', () => {
  // `http://localhost@evil.com/` has hostname `evil.com`; the part before the
  // `@` is a username. It reads as loopback to a person and is not.
  assert.equal(readLocalUrl('http://localhost@evil.com/'), null);
  assert.equal(readLocalUrl('http://127.0.0.1@evil.com/'), null);
  // Even genuinely-loopback ones, because there is no reason for a preview to
  // carry credentials and their only effect here is to disguise a host.
  assert.equal(readLocalUrl('http://user:pw@localhost:5173/'), null);
});

test('non-http schemes are refused', () => {
  // `file:` would expose the disk, and the javascript/data pair would execute
  // in the frame — all three are ways to make "preview" mean something else.
  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,<h1>hi', 'about:blank']) {
    assert.equal(readLocalUrl(url), null, `${url} must be refused`);
  }
});

test('malformed input is refused rather than thrown on', () => {
  // A tool argument comes from a model and may be anything at all. Throwing
  // here would fail the turn instead of returning a correctable error.
  for (const url of ['', 'not a url', 'localhost:5173', '//localhost:5173']) {
    assert.equal(readLocalUrl(url), null, `${JSON.stringify(url)} must be refused`);
  }
});
