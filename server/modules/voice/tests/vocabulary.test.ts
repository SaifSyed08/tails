import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildInitialPrompt } from '@/modules/voice/vocabulary.js';

function scratchDir(entries: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tails-vocab-'));
  for (const entry of entries) fs.writeFileSync(path.join(dir, entry), '');
  return dir;
}

test('the static project vocabulary is present with no folder at all', () => {
  const prompt = buildInitialPrompt(null);
  assert.match(prompt, /typecheck/);
  assert.match(prompt, /better-sqlite3/);
});

test('an unreadable folder degrades to the static vocabulary instead of throwing', () => {
  const prompt = buildInitialPrompt(path.join(os.tmpdir(), 'tails-does-not-exist-9f3a'));
  assert.match(prompt, /typecheck/);
});

test('filenames in the folder reach the prompt, extensions included', () => {
  // The measured failure was hearing "tsx" as part of a filename, so the
  // extension is the part that has to survive.
  const dir = scratchDir(['ChatPet.tsx', 'sprite-metrics.ts']);
  const prompt = buildInitialPrompt(dir);

  assert.match(prompt, /ChatPet\.tsx/);
  assert.match(prompt, /sprite-metrics\.ts/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the folder name itself is included, since that is what people call it', () => {
  const dir = scratchDir([]);
  assert.ok(buildInitialPrompt(dir).includes(path.basename(dir)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('build output and dotfiles are left out', () => {
  const dir = scratchDir(['.env', 'realfile.ts']);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, 'dist'));

  const prompt = buildInitialPrompt(dir);
  assert.doesNotMatch(prompt, /node_modules/);
  assert.doesNotMatch(prompt, /dist/);
  assert.doesNotMatch(prompt, /\.env/);
  assert.match(prompt, /realfile\.ts/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a huge folder does not produce a huge prompt', () => {
  // This runs on the send path. A directory with thousands of entries must not
  // turn into a prompt that competes with the audio for the decoder.
  const dir = scratchDir(Array.from({ length: 400 }, (_, i) => `generated-file-${i}.ts`));
  const prompt = buildInitialPrompt(dir);

  assert.ok(prompt.length <= 701, `prompt was ${prompt.length} chars`);
  assert.ok(prompt.endsWith('.'), 'prompt should not end mid-identifier');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a term appearing in both the folder and the static list is not repeated', () => {
  const dir = scratchDir(['petstage']);
  const prompt = buildInitialPrompt(dir);
  assert.equal(prompt.match(/petstage/gi)?.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
