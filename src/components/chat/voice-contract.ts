/**
 * The seam between the composer's voice control and the voice module.
 *
 * The button is the chat module's; everything behind it — permission, capture,
 * wake words, the on-device model, transcription, speaking — belongs to the
 * voice module. This file is the whole of what passes between them, kept
 * import-free so the repo's test runner can execute the parts worth testing.
 *
 * Transcribed text does not travel through this type. It arrives by calling
 * `ComposerHandle.append(text)`, which is what lets dictation land in a draft
 * someone has already started typing rather than replacing it.
 *
 * ## One mode, not two buttons
 *
 * Dictation and wake-word listening were separate controls and are now one.
 * They are the same capability seen at two moments — the microphone is either
 * open or it is not — and giving them two buttons made the user answer a
 * question the app should answer for itself.
 */

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
  /** Wake words currently armed. Empty means voice mode is push-to-talk only. */
  armed: readonly string[];
  /**
   * Input level, 0–1, for the indicator. **Zero whenever the microphone is
   * closed** — it is what lets an open microphone visibly show it is hearing.
   */
  level: number;
  /** Enters voice mode: opens the microphone. */
  enable: () => void;
  /** Leaves voice mode: closes the microphone. */
  disable: () => void;
  /** Captures now, without waiting for a wake word. */
  capture: () => void;
  /** Ends capture and transcribes. */
  endCapture: () => void;
  /** Stops playback immediately. */
  hush: () => void;
};

/** What pressing the control should do, resolved from the mode. */
export type VoiceAction = 'enable' | 'disable' | 'capture' | 'endCapture' | 'hush' | 'none';

/** The icon to draw. Named by meaning so the shape is part of the contract. */
export type VoiceGlyph = 'muted' | 'mic' | 'armed' | 'capturing' | 'working' | 'speaking';

export type VoiceControl = {
  mode: VoiceMode;
  label: string;
  title: string;
  disabled: boolean;
  pressed: boolean;
  /** True while the microphone is open, in any mode. Drives the live styling. */
  live: boolean;
  glyph: VoiceGlyph;
  action: VoiceAction;
};

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
 */
export function describeVoiceControl(voice: VoiceModeState | undefined): VoiceControl {
  const mode = voice?.mode ?? 'unavailable';
  const armed = voice?.armed ?? [];

  switch (mode) {
    case 'waiting':
      return {
        mode,
        // Names the open microphone explicitly. Someone reading this aloud
        // should learn that the app is listening, not merely that it is ready.
        label: armed.length > 0
          ? `Listening for a wake word — microphone on. ${armed.length} armed`
          : 'Microphone on, waiting',
        title: 'Microphone is on, waiting for a wake word. Press to turn it off.',
        disabled: false,
        pressed: true,
        live: true,
        glyph: 'armed',
        action: 'disable',
      };

    case 'listening':
      return {
        mode,
        label: 'Recording — press to stop and transcribe',
        title: 'Recording. Press to stop.',
        disabled: false,
        pressed: true,
        live: true,
        glyph: 'capturing',
        action: 'endCapture',
      };

    case 'transcribing':
      return {
        mode,
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
        label: armed.length > 0 ? 'Turn on voice mode' : 'Start dictation',
        title: armed.length > 0
          ? 'Turn on voice mode — runs on this machine'
          : 'Dictate a message — runs on this machine',
        disabled: false,
        pressed: false,
        live: false,
        glyph: 'mic',
        action: 'enable',
      };

    default:
      return {
        mode: 'unavailable',
        label: 'Voice mode unavailable',
        // The reason is the whole point of the disabled state: a button that is
        // off and silent about why is indistinguishable from one that is broken.
        title: voice?.reason ?? 'Voice mode is not available yet',
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
  if (action === 'enable') voice.enable();
  else if (action === 'disable') voice.disable();
  else if (action === 'capture') voice.capture();
  else if (action === 'endCapture') voice.endCapture();
  else if (action === 'hush') voice.hush();
}
