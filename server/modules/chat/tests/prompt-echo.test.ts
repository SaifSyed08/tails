import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { normalizeSdkMessage } from '@/modules/chat/normalize.js';
import { applySpokenSteer, SPOKEN_TURN_STEER } from '@/modules/chat/spoken-turn.js';

/**
 * The prompt is rendered once, and the expansion is never rendered.
 *
 * Two facts about this bug made it survive: it was invisible, and then it was
 * alarming.
 *
 * Invisible, because the runtime echoes the user's message itself *and* the
 * SDK echoes back the prompt it was handed. For a typed message those are the
 * same string, so a duplicated message looked like a rendering quirk rather
 * than a second copy from a second source.
 *
 * Alarming, because the SDK's copy is of the *expanded* prompt. The moment
 * voice mode began appending an instruction the transcript is not meant to
 * show, that instruction appeared on screen — the user reading their own words
 * with a paragraph of stage directions stapled to them.
 *
 * So this pins both halves: the transcript shows what was said, and never what
 * was added to it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(HERE, '..', 'claude-runtime.ts');
const runtime = (): string => fs.readFileSync(RUNTIME, 'utf8');

/** An SDK `user` event carrying text, which is how the echo arrives. */
const userEvent = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

test('the steer never reaches the transcript', () => {
  // The normaliser is shared with history replay, so it *does* render user
  // text — that is correct and must stay. What must not happen is the live
  // runtime forwarding it.
  const expanded = applySpokenSteer('what did you change', true);
  const rendered = normalizeSdkMessage(userEvent(expanded), 'session-1');

  assert.ok(
    rendered.some((message) => message.content?.includes(SPOKEN_TURN_STEER)),
    'the normaliser renders user text, which history depends on',
  );

  // ...which is exactly why the runtime has to drop it.
  assert.match(
    runtime(),
    /event\?\.type === 'user'[\s\S]{0,200}normalized\.role === 'user'/,
    'claude-runtime must skip the SDK echo of a user text message; without it '
    + 'every message renders twice and a spoken turn leaks its steer on screen',
  );
});

test('tool results are not swept up with the echo', () => {
  // They arrive under the same `user` event type and are genuinely new
  // information. A filter that dropped these would silently empty every tool
  // call's output, which is a worse bug than the one being fixed.
  const rendered = normalizeSdkMessage({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }],
    },
  }, 'session-1');

  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].kind, 'tool_result');
  assert.equal(rendered[0].role, undefined, 'a tool result is not a user turn');
});

test('the steer is one sentence', () => {
  /*
    Length is the requirement, not a preference. It rides on every spoken turn,
    it is paid for in tokens each time, and when the leak above was live it was
    what the user actually read. A paragraph of stage directions dominated the
    message it was meant to qualify.
  */
  const sentences = SPOKEN_TURN_STEER.split(/[.!?](?:\s|$)/).filter((part) => part.trim());
  assert.equal(sentences.length, 1, `steer is ${sentences.length} sentences: ${SPOKEN_TURN_STEER}`);
  assert.ok(
    SPOKEN_TURN_STEER.length <= 140,
    `steer is ${SPOKEN_TURN_STEER.length} characters; keep it to one ordinary sentence`,
  );
});

test('a typed turn carries no steer at all', () => {
  // The flag has to be the only thing that adds it. A steer that leaked onto
  // typed messages would quietly reformat every answer in the app.
  assert.equal(applySpokenSteer('hello', false), 'hello');
});
