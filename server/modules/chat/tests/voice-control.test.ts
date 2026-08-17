import assert from 'node:assert/strict';
import test from 'node:test';

// Client code, reached by path: it imports nothing, and this is the repo's only
// test runner. See the note in answers.test.ts.
import {
  describeVoiceControl,
  runVoiceAction,
  type VoiceMode,
  type VoiceModeState,
} from '../../../../src/components/chat/voice-contract.js';

const ALL_MODES: VoiceMode[] = [
  'unavailable', 'off', 'waiting', 'listening', 'transcribing', 'speaking',
];

function state(mode: VoiceMode, extra: Partial<VoiceModeState> = {}): VoiceModeState {
  return {
    mode,
    armed: [],
    level: 0,
    enable: () => {},
    disable: () => {},
    capture: () => {},
    endCapture: () => {},
    hush: () => {},
    ...extra,
  };
}

test('every state has its own accessible name', () => {
  // State is carried by the name as well as by colour and motion, so someone
  // who cannot see the pulse can still tell what the microphone is doing.
  const names = ALL_MODES.map((mode) => describeVoiceControl(state(mode)).label);
  assert.equal(new Set(names).size, names.length, `not all distinct: ${names.join(' / ')}`);
});

test('every state has its own glyph, so shape carries it too', () => {
  const glyphs = ALL_MODES.map((mode) => describeVoiceControl(state(mode)).glyph);
  assert.equal(new Set(glyphs).size, glyphs.length, `not all distinct: ${glyphs.join(' / ')}`);
});

test('waiting does not look or read like off', () => {
  // The load-bearing distinction in this whole feature: in `waiting` the
  // microphone is open. If it renders like `off`, the app is lying about a
  // live microphone.
  const waiting = describeVoiceControl(state('waiting'));
  const off = describeVoiceControl(state('off'));

  assert.notEqual(waiting.label, off.label);
  assert.notEqual(waiting.glyph, off.glyph);
  assert.equal(waiting.live, true, 'waiting must report the microphone as live');
  assert.equal(off.live, false, 'off must not');
  assert.equal(waiting.pressed, true, 'and must read as on to assistive tech');
  assert.equal(off.pressed, false);
});

test('the accessible name for waiting says the microphone is on', () => {
  // Not "ready", not "armed" — someone hearing this read aloud has to learn
  // that the microphone is currently open.
  assert.match(describeVoiceControl(state('waiting')).label, /microphone on/i);
});

test('both open-microphone states report themselves as live', () => {
  for (const mode of ['waiting', 'listening'] as const) {
    assert.equal(describeVoiceControl(state(mode)).live, true, `${mode} should be live`);
  }
  for (const mode of ['off', 'unavailable', 'transcribing'] as const) {
    assert.equal(describeVoiceControl(state(mode)).live, false, `${mode} should not be live`);
  }
});

test('the same button stops what it started', () => {
  const listening = describeVoiceControl(state('listening'));

  assert.equal(listening.disabled, false, 'stopping is never harder to find than starting');
  assert.equal(listening.action, 'endCapture');
  assert.match(listening.label, /stop/i);
});

test('pressing while waiting turns the microphone off', () => {
  assert.equal(describeVoiceControl(state('waiting')).action, 'disable');
});

test('a disabled control explains itself', () => {
  const reason = 'Needs a one-time 78 MB model download.';
  const described = describeVoiceControl(state('unavailable', { reason }));

  assert.equal(described.disabled, true);
  assert.equal(described.title, reason, 'the tooltip is the reason, not a shrug');
});

test('no voice module at all is the unavailable state, not a crash', () => {
  const described = describeVoiceControl(undefined);

  assert.equal(described.mode, 'unavailable');
  assert.equal(described.disabled, true);
  assert.ok(described.title.length > 0, 'and still says something');
});

test('transcribing is busy, and offers nothing to press', () => {
  const described = describeVoiceControl(state('transcribing'));

  assert.equal(described.disabled, true, 'capture has already stopped');
  assert.equal(described.pressed, false);
  assert.equal(described.action, 'none');
});

test('speaking can always be interrupted', () => {
  const described = describeVoiceControl(state('speaking'));

  assert.equal(described.disabled, false, 'silencing it must never be unavailable');
  assert.equal(described.action, 'hush');
});

test('with wake words armed, off invites voice mode rather than dictation', () => {
  const plain = describeVoiceControl(state('off'));
  const armed = describeVoiceControl(state('off', { armed: ['tails'] }));

  assert.match(plain.label, /dictation/i);
  assert.match(armed.label, /voice mode/i);
});

test('each action reaches exactly its own handler', () => {
  const called: string[] = [];
  const spy = state('off', {
    enable: () => called.push('enable'),
    disable: () => called.push('disable'),
    capture: () => called.push('capture'),
    endCapture: () => called.push('endCapture'),
    hush: () => called.push('hush'),
  });

  for (const action of ['enable', 'disable', 'capture', 'endCapture', 'hush'] as const) {
    runVoiceAction(spy, action);
  }
  assert.deepEqual(called, ['enable', 'disable', 'capture', 'endCapture', 'hush']);
});

test('a press with no voice module does nothing rather than throwing', () => {
  assert.doesNotThrow(() => runVoiceAction(undefined, 'enable'));
  assert.doesNotThrow(() => runVoiceAction(state('off'), 'none'));
});
