import assert from 'node:assert/strict';
import test from 'node:test';

// Client code, reached by path: it imports nothing, and this is the repo's only
// test runner. See the note in answers.test.ts.
import {
  describeVoiceControl,
  listPhrases,
  runVoiceAction,
  type VoiceIntent,
  type VoiceMode,
  type VoiceModeState,
} from '../../../../src/components/chat/voice-contract.js';

const ALL_MODES: VoiceMode[] = [
  'unavailable', 'off', 'waiting', 'listening', 'transcribing', 'speaking', 'asking',
];

function state(mode: VoiceMode, extra: Partial<VoiceModeState> = {}): VoiceModeState {
  return {
    mode,
    // Defaults to whichever intent the mode implies, so a test that only cares
    // about the moment does not have to state both.
    intent: (mode === 'off' || mode === 'unavailable' ? 'off' : 'dictation') as VoiceIntent,
    armed: [],
    armedLabels: [],
    level: 0,
    wakeCount: 0,
    start: () => {},
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
  for (const intent of ['dictation', 'voice'] as const) {
    assert.match(
      describeVoiceControl(state('waiting', { intent })).label,
      /microphone (is )?(on|open)/i,
      `${intent} must say the microphone is open`,
    );
  }
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

test('the button always offers dictation, never voice mode', () => {
  // The regression this replaces: with a wake word armed, the microphone
  // button silently became a wake-word arm, so pressing it captured nothing
  // and dictation appeared to be broken. Voice mode is a deliberate choice in
  // the menu now, because it is the one that sends on its own.
  const plain = describeVoiceControl(state('off'));
  const armed = describeVoiceControl(state('off', { armed: ['tails'], armedLabels: ['TAILS'] }));

  assert.equal(plain.action, 'dictate');
  assert.equal(armed.action, 'dictate', 'an armed wake word must not change what the button does');
  assert.equal(plain.label, armed.label);
});

test('while capturing, the label says whether this will send', () => {
  // The one difference that can cost the user something. Dictation fills the
  // box; voice mode sends when you stop talking. A control that does not say
  // which is running will eventually send a half-finished thought.
  const dictating = describeVoiceControl(state('listening', { intent: 'dictation' }));
  const spoken = describeVoiceControl(state('listening', { intent: 'voice' }));

  assert.notEqual(dictating.label, spoken.label);
  assert.match(spoken.label, /send/i);
  assert.doesNotMatch(dictating.label, /send/i);
});

test('waiting names the phrase the user is supposed to say', () => {
  // Voice mode used to give no indication at all that a wake word was
  // expected, let alone which one.
  const described = describeVoiceControl(state('waiting', {
    intent: 'voice',
    armed: ['hey_jarvis'],
    armedLabels: ['Hey Jarvis'],
  }));

  assert.match(described.label, /Hey Jarvis/);
  assert.match(described.title, /Hey Jarvis/);
});

test('phrases are listed the way a person would say them', () => {
  assert.equal(listPhrases([]), '');
  assert.equal(listPhrases(['Hey Jarvis']), 'Hey Jarvis');
  assert.equal(listPhrases(['Hey Jarvis', 'Timer']), 'Hey Jarvis or Timer');
  assert.equal(listPhrases(['Hey Jarvis', 'Timer', 'TAILS']), 'Hey Jarvis, Timer or TAILS');
});

test('each action reaches exactly its own handler', () => {
  const called: string[] = [];
  const spy = state('off', {
    start: (intent) => called.push(`start:${intent}`),
    disable: () => called.push('disable'),
    capture: () => called.push('capture'),
    endCapture: () => called.push('endCapture'),
    hush: () => called.push('hush'),
  });

  for (const action of ['dictate', 'disable', 'capture', 'endCapture', 'hush'] as const) {
    runVoiceAction(spy, action);
  }
  assert.deepEqual(called, ['start:dictation', 'disable', 'capture', 'endCapture', 'hush']);
});

test('the button can never start voice mode by accident', () => {
  // There is no action that reaches `start('voice')`. Sending without the user
  // pressing send is a consequence that has to be chosen explicitly, and the
  // menu is where that choice is made.
  const started: string[] = [];
  const spy = state('off', { start: (intent) => started.push(intent) });

  for (const action of ['dictate', 'disable', 'capture', 'endCapture', 'hush', 'none'] as const) {
    runVoiceAction(spy, action);
  }
  assert.deepEqual(started, ['dictation']);
});

test('a press with no voice module does nothing rather than throwing', () => {
  assert.doesNotThrow(() => runVoiceAction(undefined, 'dictate'));
  assert.doesNotThrow(() => runVoiceAction(state('off'), 'none'));
});

/*
  Answering a permission request out loud.

  `asking` is the one mode whose microphone opens and closes partway through —
  the app reads the request, then listens for the answer — so it is the one mode
  where "is my microphone on" cannot be answered by the mode alone.
*/

test('asking does not look or read like speaking', () => {
  // The failure this guards: a request to run a shell command that renders like
  // a reply being read back, so the user does not know an answer is expected.
  const asking = describeVoiceControl(state('asking'));
  const speaking = describeVoiceControl(state('speaking'));

  assert.notEqual(asking.label, speaking.label);
  assert.notEqual(asking.glyph, speaking.glyph);
});

test('asking reports the microphone as live only once it is listening', () => {
  const reading = describeVoiceControl(state('asking', {
    asking: { prompt: 'run npm test. Approve, deny, or explain?', awaiting: false },
  }));
  const listening = describeVoiceControl(state('asking', {
    asking: { prompt: 'run npm test. Approve, deny, or explain?', awaiting: true },
  }));

  assert.equal(reading.live, false, 'the app is talking; the microphone is not capturing');
  assert.equal(listening.live, true, 'now it is');
  // Shape carries the open microphone, in this mode as in every other.
  assert.notEqual(reading.glyph, listening.glyph);
  assert.equal(listening.glyph, 'capturing');
});

test('the name for asking says what to say', () => {
  const listening = describeVoiceControl(state('asking', {
    asking: { prompt: 'anything', awaiting: true },
  }));
  assert.match(listening.label, /approve/i);
  assert.match(listening.label, /deny/i);
});

test('the request being asked about is on the control itself', () => {
  const prompt = 'run rm -rf build. Approve, deny, or explain?';
  const described = describeVoiceControl(state('asking', { asking: { prompt, awaiting: true } }));
  assert.ok(described.title.includes(prompt), described.title);
});

test('pressing during a request escapes to the screen rather than answering', () => {
  // Nothing here may approve by touch: the button's meaning would depend on a
  // question the presser may not have heard.
  for (const awaiting of [false, true]) {
    const described = describeVoiceControl(state('asking', {
      asking: { prompt: 'anything', awaiting },
    }));
    assert.equal(described.action, 'disable', `awaiting: ${awaiting}`);
    assert.equal(described.disabled, false, 'the escape hatch is never disabled');
  }
});
