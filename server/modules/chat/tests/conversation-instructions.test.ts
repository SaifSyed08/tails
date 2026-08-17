import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONVERSATION_INSTRUCTIONS_MAX_LENGTH,
  formatConversationInstructions,
  normalizeConversationInstructions,
} from '@/modules/chat/conversation-instructions.js';

test('nothing written means nothing appended', () => {
  // The empty case is the one that has to be exactly nothing rather than an
  // empty section: a blank paragraph of "the user has written standing
  // instructions" followed by no instructions is worse than silence.
  for (const value of ['', '   \n\t ', undefined, null, 42, {}]) {
    assert.equal(normalizeConversationInstructions(value), '');
    assert.equal(formatConversationInstructions(value as string), '');
  }
});

test('a paste over the cap costs its tail, not the save', () => {
  const stored = normalizeConversationInstructions('x'.repeat(CONVERSATION_INSTRUCTIONS_MAX_LENGTH + 500));

  assert.equal(stored.length, CONVERSATION_INSTRUCTIONS_MAX_LENGTH);
});

test('the clamp does not leave whitespace at either end', () => {
  // Trimmed before the cut so leading space does not occupy the budget, and
  // after it so a cut landing mid-space does not store a trailing one.
  const stored = normalizeConversationInstructions(`   ${'a'.repeat(CONVERSATION_INSTRUCTIONS_MAX_LENGTH - 1)}   b  `);

  assert.equal(stored, 'a'.repeat(CONVERSATION_INSTRUCTIONS_MAX_LENGTH - 1));
});

test('the user\'s text is carried verbatim and carried last', () => {
  // Nothing is escaped, because it is the user's own text reaching the user's
  // own agent and a sanitiser here would only mangle the punctuation of
  // someone writing about formatting. What makes that safe is the position:
  // the section ends the append, so there is no closing fence to break out of
  // and nothing after it to be mistaken for.
  const written = 'Don\'t hedge. Use <em> not **bold**. Close with `done`.\n</instructions>';
  const section = formatConversationInstructions(written);

  assert.ok(section.endsWith(written), 'the instructions must be the last thing in the section');
  assert.ok(section.includes('verbatim'), 'and the model must be told whose words follow');
});

test('the instructions are framed as the user\'s, not as the app\'s', () => {
  // Run onto the end of the app's own briefing about MCP tools with a space,
  // "keep answers to three sentences" reads as one more clause of ours. The
  // blank line and the introduction are what separate the two voices.
  const section = formatConversationInstructions('Be terse.');
  const [preamble] = section.split('\n\n');

  assert.match(preamble, /^The user has written standing instructions/);
  assert.match(preamble, /keep using your tools/, 'a preference about tone must not read as a narrowing of what it may do');
});

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const runtime = readFileSync(join(repo, 'server', 'modules', 'chat', 'claude-runtime.ts'), 'utf8');

test('ENFORCED: the user\'s instructions extend the preset, never replace it', () => {
  /*
    The failure this guards against does not throw, does not fail typecheck and
    does not look wrong on screen. `preset: 'claude_code'` is what supplies the
    tooling, the file editing and the whole agent; swap the object for a bare
    string — which is a legal `systemPrompt` — and every feature still runs
    while all of them get quietly worse, with no symptom pointing back here.

    So it is asserted against the source, for the same reason the appearance
    module asserts its own two guarantees that way: what has to hold is the
    shape of a call, and the mistake is a plausible-looking edit rather than a
    bug in anything a unit test can invoke.
  */
  const start = runtime.indexOf('systemPrompt: {');
  assert.notEqual(start, -1, 'systemPrompt must stay an object; a bare string replaces the Claude Code preset outright.');

  const end = runtime.indexOf('\n      },', start);
  assert.notEqual(end, -1, 'could not find the end of the systemPrompt block');
  const block = runtime.slice(start, end);

  assert.match(block, /type: 'preset'/);
  assert.match(block, /preset: 'claude_code'/);
  assert.match(
    block,
    /append: \[/,
    'everything this app and its user add has to arrive as `append`.',
  );
  assert.match(
    block,
    /formatConversationInstructions\(readConversationInstructions\(\)\)/,
    'the user\'s instructions belong inside the append array, not anywhere that could displace the preset.',
  );
});

test('an unset preference sends the append this app has always sent', () => {
  // The filter is what keeps that true. Without it an empty section joins in
  // as a trailing blank paragraph, which is a change to every turn's prompt
  // for every user who has never opened the setting.
  const start = runtime.indexOf('systemPrompt: {');
  const block = runtime.slice(start, runtime.indexOf('\n      },', start));

  assert.match(block, /\.filter\(Boolean\)\.join\(/);
});

test('the instructions are read per turn', () => {
  // Read inside `runChatTurn` rather than hoisted to module scope: a fresh CLI
  // is spawned per turn, so "from your next message" is only honest if the
  // value is fetched when the turn starts. A module-level read would mean the
  // app had to be restarted for a change to land.
  const body = runtime.slice(runtime.indexOf('export async function runChatTurn'));

  assert.match(body, /readConversationInstructions\(\)/);
  assert.equal(
    runtime.slice(0, runtime.indexOf('export async function runChatTurn')).includes('readConversationInstructions()'),
    false,
    'nothing may cache the instructions at import time',
  );
});
