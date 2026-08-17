import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLAUDE_PATH_ENV, findOnPath, resolveClaudeCli } from '@/modules/chat/claude-cli.js';

const EXECUTABLE = process.platform === 'win32' ? 'claude.exe' : 'claude';

/** A directory holding a fake `claude`, plus whatever shims a case needs. */
function fakeInstall(...names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tails-cli-'));
  for (const name of names) fs.writeFileSync(path.join(dir, name), '');
  return dir;
}

/**
 * These pass an environment in rather than mutating `process.env`, which is
 * what keeps them from depending on each other's order and from being affected
 * by the real machine's `PATH`.
 *
 * One case is deliberately missing: "nothing anywhere". A checkout always has
 * the SDK's optional platform package installed, so the not-found branch cannot
 * be reached from here — it is reached only in a packaged build, where that
 * package is excluded, and it is verified there.
 */

test('an explicit override outranks the package npm installed', () => {
  const dir = fakeInstall(EXECUTABLE);
  const status = resolveClaudeCli({ [CLAUDE_PATH_ENV]: path.join(dir, EXECUTABLE), PATH: '' });

  assert.equal(status.found, true);
  assert.equal(status.source, 'override');
  assert.equal(status.path, path.join(dir, EXECUTABLE));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an override pointing at nothing is skipped rather than used or thrown over', () => {
  const missing = path.join(os.tmpdir(), 'tails-cli-does-not-exist', EXECUTABLE);
  const status = resolveClaudeCli({ [CLAUDE_PATH_ENV]: missing, PATH: '' });

  // The bundled package is what a checkout falls through to, and the whole
  // point of keeping it second is that `npx electron electron/main.js` still
  // works with no configuration at all.
  assert.equal(status.found, true);
  assert.equal(status.source, 'bundled');
  assert.ok(status.searched.includes(`${CLAUDE_PATH_ENV}=${missing}`));
});

test('the trail records the override slot even when the variable is unset', () => {
  const status = resolveClaudeCli({ PATH: '' });
  assert.ok(status.searched.some((entry) => entry.startsWith(`${CLAUDE_PATH_ENV} (not set)`)));
});

test('a directory on PATH holding the real executable is accepted', () => {
  const dir = fakeInstall(EXECUTABLE);
  const result = findOnPath([dir, path.join(dir, 'nope')].join(path.delimiter));

  assert.equal(result.path, path.join(dir, EXECUTABLE));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty PATH is not an error, just an empty answer', () => {
  assert.equal(findOnPath('').path, null);
});

// Windows only: `.cmd`/`.ps1` are what a global npm install leaves behind, and
// Node cannot spawn them without a shell. Reporting them beats handing the SDK
// something that fails with EINVAL three layers down.
test('a script shim on PATH is reported but never returned', { skip: process.platform !== 'win32' }, () => {
  const dir = fakeInstall('claude.cmd', 'claude.ps1');
  const result = findOnPath(dir);

  assert.equal(result.path, null);
  assert.match(result.note, /script shims/);
  assert.ok(result.note.includes(path.join(dir, 'claude.cmd')));
  fs.rmSync(dir, { recursive: true, force: true });
});
