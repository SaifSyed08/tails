import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/*
  A real directory, and set before the module loads.

  `TAILS_HOME` is read at import time, so this has to happen before the dynamic
  import below — a static import would bind the real home directory and this
  test would grant standing tool permissions in the user's own database.
*/
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tails-trust-test-'));
process.env.TAILS_HOME = home;

const { trustRepository } = await import('@/db/trust.repository.js');

const PROJECT = 'C:\\work\\tails-app';
const OTHER = 'C:\\work\\something-else';

describe('standing tool permissions', () => {
  it('asks about everything until told not to', () => {
    assert.equal(trustRepository.isTrusted('Bash', PROJECT), false);
  });

  it('remembers a grant', () => {
    trustRepository.grant('Bash', PROJECT);
    assert.equal(trustRepository.isTrusted('Bash', PROJECT), true);
  });

  it('does not answer for another folder', () => {
    // The reason this is keyed by folder at all. "Yes, run the tests here" is a
    // statement about a project, and applying it to every project the app is
    // ever opened on would be a grant the user never made.
    assert.equal(trustRepository.isTrusted('Bash', OTHER), false);
  });

  it('does not answer for another tool', () => {
    assert.equal(trustRepository.isTrusted('Write', PROJECT), false);
  });

  it('granting twice is one grant, and keeps the original date', () => {
    const first = trustRepository.list().find((entry) => entry.toolName === 'Bash');
    trustRepository.grant('Bash', PROJECT);
    const again = trustRepository.list().filter((entry) => entry.toolName === 'Bash');

    assert.equal(again.length, 1);
    assert.equal(again[0].createdAt, first?.createdAt);
  });

  it('lists what was granted, so it can be seen and taken back', () => {
    // A grant nobody can see is a grant nobody can revoke, which is the whole
    // reason this moved out of a Map that lived and died with the process.
    trustRepository.grant('Write', OTHER);
    const listed = trustRepository.list();

    assert.equal(listed.length, 2);
    assert.deepEqual(
      new Set(listed.map((entry) => `${entry.toolName}@${entry.cwd}`)),
      new Set([`Bash@${PROJECT}`, `Write@${OTHER}`]),
    );
  });

  it('revokes exactly one, and says whether it found it', () => {
    assert.equal(trustRepository.revoke('Bash', PROJECT), true);
    assert.equal(trustRepository.isTrusted('Bash', PROJECT), false);
    assert.equal(trustRepository.isTrusted('Write', OTHER), true, 'the other survives');
    assert.equal(trustRepository.revoke('Bash', PROJECT), false, 'revoking twice finds nothing');
  });

  it('revokes everything at once, for when the answer is "start over"', () => {
    trustRepository.grant('Bash', PROJECT);
    assert.equal(trustRepository.revokeAll(), 2);
    assert.deepEqual(trustRepository.list(), []);
  });
});
