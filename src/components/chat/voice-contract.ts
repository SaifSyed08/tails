/**
 * The seam between the composer's voice controls and the voice module.
 *
 * The buttons are the chat module's; everything behind them — permission,
 * capture, wake words, the on-device model, transcription, speaking — belongs
 * to the voice module. This file is the whole of what passes between them,
 * kept import-free so the repo's test runner can execute the parts worth
 * testing.
 *
 * Transcribed text does not travel through this type. It arrives by calling
 * `ComposerHandle.append(text)`, which is what lets dictation land in a draft
 * someone has already started typing rather than replacing it.
 *
 * ## One microphone, two intents
 *
 * These were merged into a single control on the theory that dictation and
 * wake-word listening are one capability seen at two moments. The moments part
 * is right and the merge was wrong, and the bug it produced says why: with a
 * wake word armed, pressing the microphone silently stopped capturing and
 * started *waiting*, so dictation appeared to do nothing at all.
 *
 * They differ in the thing that matters most — what happens to your words.
 * Dictation fills the box and stops there; voice mode sends. That is not a
 * detail of presentation, it is a difference in consequence, and a control
 * that quietly switches between the two is a control that will eventually
 * send something you were still editing.
 *
 * So: one device, one state machine, two declared intents.
 */

export type VoiceIntent =
  /** Microphone closed. */
  | 'off'
  /**
   * Dictating. Fills the composer and **never sends** — the user presses send.
   *
   * Reached from the microphone button beside the composer.
   */
  | 'dictation'
  /**
   * Voice mode. Waits for a wake word, then captures, **sends on its own**,
   * and reads the reply back.
   *
   * Reached from the plus panel.
   */
  | 'voice';

export type VoiceMode =
  /** No engine, no model, or permission refused. The control is disabled. */
  | 'unavailable'
  /** Not engaged. **The microphone is closed.** */
  | 'off'
  /**
   * Armed for a wake word. **The microphone is OPEN and nothing is captured.**
   *
   * The single most important state in this type. A permanently open
   * microphone that looks identical to a closed one is the failure this whole
   * feature has to avoid, so `waiting` must never render like `off`.
   */
  | 'waiting'
  /** Capturing an utterance right now. */
  | 'listening'
  /** Capture finished, turning audio into text. */
  | 'transcribing'
  /** Reading a reply back. */
  | 'speaking';

export type VoiceModeState = {
  /** What the user asked for. `mode` is where that intent currently stands. */
  intent: VoiceIntent;
  mode: VoiceMode;
  /**
   * Why it cannot be used, in words a person can act on.
   *
   * The whole error surface, and it now carries more cases than it started
   * with: no engine, no model, permission refused, and wake-word-unavailable
   * while dictation is fine. "Needs a one-time 78 MB download" tells someone
   * what to do; "unavailable" does not.
   */
  reason?: string;
  /**
   * Why wake-word listening is not running, while voice mode is on.
   *
   * Separate from `reason` because it does not stop voice mode — the button
   * still captures — and because it used to be swallowed entirely: the Worker
   * could fail to load its models and nothing anywhere said so.
   */
  wakeReason?: string;
  /** Wake words currently armed. Empty means voice mode is push-to-talk only. */
  armed: readonly string[];
  /** The same words as a person says them, for the on-screen prompt. */
  armedLabels: readonly string[];
  /**
   * Input level, 0–1, for the indicator. **Zero whenever the microphone is
   * closed** — it is what lets an open microphone visibly show it is hearing.
   */
  level: number;
  /**
   * Increments once per wake-word detection.
   *
   * A counter rather than a boolean or a timestamp: the glow is a one-shot
   * reaction to an event, and a counter is the only one of the three that
   * cannot miss two detections in a row or need clearing afterwards.
   */
  wakeCount: number;
  /** Opens the microphone with a declared intent. */
  start: (intent: 'dictation' | 'voice') => void;
  /** Closes the microphone, whatever it was doing. */
  disable: () => void;
  /** Captures now, without waiting for a wake word. */
  capture: () => void;
  /** Ends capture and transcribes. */
  endCapture: () => void;
  /** Stops playback immediately. */
  hush: () => void;
};

/** What pressing the control should do, resolved from the mode. */
export type VoiceAction = 'dictate' | 'disable' | 'capture' | 'endCapture' | 'hush' | 'none';

/** The icon to draw. Named by meaning so the shape is part of the contract. */
export type VoiceGlyph = 'muted' | 'mic' | 'armed' | 'capturing' | 'working' | 'speaking';

export type VoiceControl = {
  mode: VoiceMode;
  intent: VoiceIntent;
  label: string;
  title: string;
  disabled: boolean;
  pressed: boolean;
  /** True while the microphone is open, in any mode. Drives the live styling. */
  live: boolean;
  glyph: VoiceGlyph;
  action: VoiceAction;
};

/** "Hey Jarvis" · "Hey Jarvis or Timer" · "Hey Jarvis, Timer or Tails". */
export function listPhrases(labels: readonly string[]): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/**
 * What the voice control says and does in each state.
 *
 * Pulled out of the component because it is the part with rules: every state
 * needs a distinct accessible name, the disabled one has to explain itself,
 * and the two states where the microphone is open must be distinguishable from
 * the two where it is closed — by name and by shape, not only by colour and
 * motion. An indicator that exists only as a pulse is invisible to anyone who
 * has motion turned off, and "is my microphone on" is the one question in this
 * app that must never be a guess.
 *
 * The intent is part of every answer now, because the two intents differ in
 * what they will do with your words. "Recording" is not enough when one of
 * these sends the result on its own.
 */
export function describeVoiceControl(voice: VoiceModeState | undefined): VoiceControl {
  const mode = voice?.mode ?? 'unavailable';
  const intent = voice?.intent ?? 'off';
  const phrases = listPhrases(voice?.armedLabels ?? []);
  const spoken = intent === 'voice';

  switch (mode) {
    case 'waiting':
      return {
        mode,
        intent,
        // Names the open microphone explicitly. Someone reading this aloud
        // should learn that the app is listening, not merely that it is ready.
        label: phrases
          ? `Voice mode on, listening for ${phrases} — microphone open`
          : 'Microphone open, waiting',
        title: phrases
          ? `Voice mode is on. Say "${phrases}". Press to turn the microphone off.`
          : 'Microphone is open and waiting. Press to turn it off.',
        disabled: false,
        pressed: true,
        live: true,
        glyph: 'armed',
        action: 'disable',
      };

    case 'listening':
      return {
        mode,
        intent,
        // The consequence, not the mechanism. One of these sends when you stop
        // talking and the other does not, and that is what the user needs to
        // know while the microphone is live.
        label: spoken
          ? 'Voice mode heard you — this will send when you stop'
          : 'Dictating — press to stop and transcribe',
        title: spoken
          ? 'Listening. Your message sends when you stop talking.'
          : 'Dictating into the message box. Press to stop.',
        disabled: false,
        pressed: true,
        live: true,
        glyph: 'capturing',
        action: 'endCapture',
      };

    case 'transcribing':
      return {
        mode,
        intent,
        label: 'Transcribing your speech',
        title: 'Transcribing…',
        disabled: true,
        pressed: false,
        live: false,
        glyph: 'working',
        action: 'none',
      };

    case 'speaking':
      return {
        mode,
        intent,
        label: 'Speaking — press to stop',
        title: 'Reading the reply aloud. Press to stop.',
        disabled: false,
        pressed: false,
        live: false,
        glyph: 'speaking',
        action: 'hush',
      };

    case 'off':
      return {
        mode,
        intent,
        // Always dictation from the button. Voice mode is a deliberate choice
        // made in the menu, because it is the one that sends.
        label: 'Start dictation',
        title: 'Dictate a message — runs on this machine, and never sends on its own',
        disabled: false,
        pressed: false,
        live: false,
        glyph: 'mic',
        action: 'dictate',
      };

    default:
      return {
        mode: 'unavailable',
        intent: 'off',
        label: 'Dictation unavailable',
        // The reason is the whole point of the disabled state: a button that is
        // off and silent about why is indistinguishable from one that is broken.
        title: voice?.reason ?? 'Dictation is not available yet',
        disabled: true,
        pressed: false,
        live: false,
        glyph: 'muted',
        action: 'none',
      };
  }
}

/** Runs the action a press resolves to. Kept here so the component stays dumb. */
export function runVoiceAction(voice: VoiceModeState | undefined, action: VoiceAction): void {
  if (!voice) return;
  if (action === 'dictate') voice.start('dictation');
  else if (action === 'disable') voice.disable();
  else if (action === 'capture') voice.capture();
  else if (action === 'endCapture') voice.endCapture();
  else if (action === 'hush') voice.hush();
}
