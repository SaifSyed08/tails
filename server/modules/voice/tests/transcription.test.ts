import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/*
  A real directory, and set before the modules load.

  `TAILS_HOME` is read at import time, so this has to happen before the dynamic
  imports below — a static import would bind the real home directory and this
  test would write a provider setting and an API key into it.
*/
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tails-transcription-test-'));
process.env.TAILS_HOME = home;

const { readSettings, writeSettings, activeProvider, readTranscriptionStatus } =
  await import('@/modules/voice/transcription.js');
const { writeKey, readKey, keyHint, hasKey } =
  await import('@/modules/voice/cloud-transcribe.js');

describe('transcription provider', () => {
  it('defaults to local, so nothing uploads until it is asked to', () => {
    assert.equal(readSettings().provider, 'local');
  });

  it('treats a corrupt settings file as local rather than guessing', () => {
    fs.writeFileSync(path.join(home, 'voice-provider.json'), '{ not json');
    assert.equal(readSettings().provider, 'local');
  });

  it('refuses a provider it does not recognise', () => {
    // The narrow point: an unknown string must not fall through to the cloud.
    writeSettings({ provider: 'anthropic' as never });
    assert.equal(readSettings().provider, 'local');
  });

  it('refuses a model it does not recognise', () => {
    writeSettings({ provider: 'openai', cloudModel: 'gpt-9-omniscient' as never });
    assert.equal(readSettings().cloudModel, 'gpt-4o-transcribe');
  });

  /*
    The failure this is really about.

    Selecting the cloud without a key used to be reportable only as whatever the
    *local* engine happened to be complaining about, so the user was told to
    download a 78 MB model while the actual obstacle was an empty text field.
  */
  it('reports the cloud obstacle when the cloud is selected, not the local one', () => {
    writeKey('');
    writeSettings({ provider: 'openai' });

    const active = activeProvider();
    assert.equal(active.id, 'openai');
    assert.equal(active.ready, false);
    assert.match(active.reason ?? '', /key/i);
    assert.doesNotMatch(active.reason ?? '', /download/i);
  });

  it('is ready once a key is saved', () => {
    writeKey('sk-test-0000000000000000cafe');
    writeSettings({ provider: 'openai' });

    const active = activeProvider();
    assert.equal(active.ready, true);
  });

  /*
    Partials are produced by transcribing the same audio again a moment later, so
    on a billed API they are the same sentence charged five times. The gateway
    asks the provider rather than assuming, and this is the value it asks for.
  */
  it('does not offer live partial text on the cloud', () => {
    writeKey('sk-test-0000000000000000cafe');
    writeSettings({ provider: 'openai' });
    assert.equal(activeProvider().supportsPartials, false);

    writeSettings({ provider: 'local' });
    assert.equal(activeProvider().supportsPartials, true);
  });

  it('never exposes the key through the status the UI reads', () => {
    const secret = 'sk-test-must-not-appear-1234';
    writeKey(secret);

    const status = JSON.stringify(readTranscriptionStatus());
    assert.equal(status.includes(secret), false);
    assert.equal(status.includes('must-not-appear'), false);
    // The hint is the last four characters and nothing else.
    assert.equal(keyHint(), '…1234');
  });

  it('clears the key with an empty string', () => {
    writeKey('sk-test-0000000000000000cafe');
    assert.equal(hasKey(), true);
    writeKey('');
    assert.equal(hasKey(), false);
    assert.equal(readKey(), null);
  });

  it('trims a key pasted with a trailing newline', () => {
    // The resulting 401 says nothing about why, so the whitespace is stripped
    // where the key is read rather than left for the user to discover.
    writeKey('  sk-test-padded-0000000000  \n');
    assert.equal(readKey(), 'sk-test-padded-0000000000');
  });
});
