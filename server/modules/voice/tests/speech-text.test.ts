import assert from 'node:assert/strict';
import test from 'node:test';

// Client code, reached by path: it imports nothing, and this is the repo's
// only test runner. Same arrangement as chat's transcript tests.
import {
  clampVoiceSettings,
  MAX_UTTERANCE_CHARS,
  toSpeech,
} from '../../../../src/components/voice/speech-text.js';

test('an empty reply produces nothing to say', () => {
  assert.deepEqual(toSpeech(''), []);
  assert.deepEqual(toSpeech('   \n\n '), []);
});

test('prose is split into sentences so speech can start before the end', () => {
  assert.deepEqual(
    toSpeech('I changed the gateway. It now claims its own path. Tests pass.'),
    ['I changed the gateway.', 'It now claims its own path.', 'Tests pass.'],
  );
});

test('a fenced code block becomes a short spoken marker, not its contents', () => {
  const spoken = toSpeech('Here is the fix:\n\n```ts\nconst x: number = 1;\n```\n\nThat should do it.');

  assert.ok(!spoken.join(' ').includes('const'), 'code was read aloud');
  assert.match(spoken.join(' '), /a ts code block/);
  assert.match(spoken.join(' '), /That should do it\./);
});

test('a reply that is only code says nothing at all', () => {
  // The marker on its own is worse than silence — it is a notification with no
  // information in it.
  assert.deepEqual(toSpeech('```js\nconsole.log(1);\n```'), []);
});

test('inline code keeps its contents because it is usually the point', () => {
  const spoken = toSpeech('Run `npm run typecheck` first.').join(' ');
  assert.match(spoken, /npm run typecheck/);
  assert.ok(!spoken.includes('`'));
});

test('emphasis and headings are not pronounced', () => {
  const spoken = toSpeech('## Summary\n\nThis is **important** and _urgent_.').join(' ');
  assert.ok(!spoken.includes('*'));
  assert.ok(!spoken.includes('#'));
  assert.ok(!spoken.includes('_'));
  assert.match(spoken, /important/);
});

test('a link is read as its text, never its url', () => {
  const spoken = toSpeech('See [the docs](https://example.com/a/b?c=1).').join(' ');
  assert.match(spoken, /the docs/);
  assert.ok(!spoken.includes('example.com'));
});

test('bullets become separate utterances rather than one run-on sentence', () => {
  const spoken = toSpeech('- first thing\n- second thing');
  assert.equal(spoken.length, 2);
  assert.match(spoken[0], /first thing/);
  assert.match(spoken[1], /second thing/);
});

test('an over-long sentence is wrapped at a comma, and every chunk is speakable', () => {
  const long = `We changed ${'the gateway, the router, the composer, '.repeat(12)}and the tests.`;
  const spoken = toSpeech(long);

  assert.ok(spoken.length > 1, 'should have been split');
  for (const chunk of spoken) {
    assert.ok(chunk.length <= MAX_UTTERANCE_CHARS, `chunk was ${chunk.length} chars`);
    assert.ok(chunk.trim().length > 0);
  }
});

test('no utterance is only punctuation left over from stripping', () => {
  for (const chunk of toSpeech('```py\nx=1\n```\n\n---\n\n- ok\n')) {
    assert.match(chunk, /[a-z0-9]/i);
  }
});

test('pet voice settings are clamped to what the platform accepts', () => {
  assert.deepEqual(clampVoiceSettings(1, 1), { rate: 1, pitch: 1 });
  // petVoiceSchema permits rate down to 0.1 and pitch 0-2; anything outside
  // that would make the synthesiser throw rather than clamp.
  assert.deepEqual(clampVoiceSettings(0, 5), { rate: 0.1, pitch: 2 });
  assert.deepEqual(clampVoiceSettings(99, -3), { rate: 3, pitch: 0 });
});

test('a missing or broken voice setting falls back rather than throwing', () => {
  assert.deepEqual(clampVoiceSettings(Number.NaN, Number.NaN), { rate: 1, pitch: 1 });
});
