import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findChecksum, pickLatestLts, type NodeIndexEntry } from '../node-release.js';

/**
 * The two decisions that pick what gets executed on the user's machine.
 *
 * Weighted toward refusals, following `freeform-css` and `layer-state`: every
 * one of these is a way the wrong file could be chosen or the wrong hash
 * compared, and all of them fail silently in the happy-path-only version.
 */

const entry = (over: Partial<NodeIndexEntry>): NodeIndexEntry => ({
  version: 'v22.14.0',
  lts: 'Jod',
  files: ['win-x64-msi', 'osx-arm64-tar'],
  ...over,
});

describe('pickLatestLts', () => {
  it('takes the first LTS entry, since the index is newest first', () => {
    const picked = pickLatestLts([
      entry({ version: 'v24.1.0', lts: false }),
      entry({ version: 'v22.14.0' }),
      entry({ version: 'v20.11.0' }),
    ]);
    assert.equal(picked?.version, 'v22.14.0');
  });

  it('builds the dist paths from the version it chose', () => {
    const picked = pickLatestLts([entry({ version: 'v22.14.0' })]);
    assert.equal(picked?.fileName, 'node-v22.14.0-x64.msi');
    assert.equal(picked?.url, 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi');
    assert.equal(picked?.checksumUrl, 'https://nodejs.org/dist/v22.14.0/SHASUMS256.txt');
  });

  it('skips current releases even when they are newer', () => {
    const picked = pickLatestLts([entry({ version: 'v24.1.0', lts: false }), entry({})]);
    assert.equal(picked?.version, 'v22.14.0');
  });

  it('skips a release that does not ship the Windows x64 MSI', () => {
    const picked = pickLatestLts([
      entry({ version: 'v22.14.0', files: ['osx-arm64-tar'] }),
      entry({ version: 'v20.11.0' }),
    ]);
    assert.equal(picked?.version, 'v20.11.0');
  });

  it('treats a missing file list as not having the file', () => {
    const missing = { version: 'v22.14.0', lts: 'Jod' } as NodeIndexEntry;
    assert.equal(pickLatestLts([missing]), null);
  });

  it('refuses a version string it cannot recognise', () => {
    // The version is interpolated straight into a URL, so anything that is not
    // plainly `vX.Y.Z` is a path this code will not construct.
    assert.equal(pickLatestLts([entry({ version: '../../evil' })]), null);
    assert.equal(pickLatestLts([entry({ version: 'v22.14' })]), null);
  });

  it('returns null rather than guessing when nothing qualifies', () => {
    assert.equal(pickLatestLts([]), null);
    assert.equal(pickLatestLts([entry({ lts: false })]), null);
    // An empty codename is falsy and is not an LTS line.
    assert.equal(pickLatestLts([entry({ lts: '' })]), null);
  });
});

describe('findChecksum', () => {
  const sums = [
    'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111  node-v22.14.0-arm64.msi',
    'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222  node-v22.14.0-x64.msi',
    'cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333  node-v22.14.0.tar.gz',
  ].join('\n');

  it('finds the line for the exact file', () => {
    assert.equal(
      findChecksum(sums, 'node-v22.14.0-x64.msi'),
      'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
    );
  });

  it('does not match on a suffix', () => {
    // 'node-v22.14.0-x64.msi' ends with 'x64.msi'; a suffix match would return
    // a hash for a file nobody asked for.
    assert.equal(findChecksum(sums, 'x64.msi'), null);
  });

  it('does not match on a prefix or a partial name', () => {
    assert.equal(findChecksum(sums, 'node-v22.14.0'), null);
  });

  it('returns null when the file is absent', () => {
    assert.equal(findChecksum(sums, 'node-v22.14.0-x86.msi'), null);
  });

  it('lowercases, so the comparison against a digest is case-exact', () => {
    const upper = 'ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234  f.msi';
    assert.equal(findChecksum(upper, 'f.msi'), 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234');
  });

  it('reads the binary-mode star that some lists carry', () => {
    const starred = 'dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444 *f.msi';
    assert.equal(
      findChecksum(starred, 'f.msi'),
      'dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444',
    );
  });

  it('ignores lines that are not checksum lines', () => {
    assert.equal(findChecksum('# a comment\n\nnot a hash  f.msi', 'f.msi'), null);
    // Too short to be a SHA-256, so it is not one.
    assert.equal(findChecksum('abcd  f.msi', 'f.msi'), null);
  });

  it('handles CRLF, which is what a Windows client may receive', () => {
    const crlf = sums.split('\n').join('\r\n');
    assert.equal(
      findChecksum(crlf, 'node-v22.14.0-x64.msi'),
      'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
    );
  });
});
