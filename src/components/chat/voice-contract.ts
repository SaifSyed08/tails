/**
 * The seam between the composer's microphone button and the capture path.
 *
 * The button is the chat module's; everything behind it — permission, capture,
 * the on-device model, transcription — belongs to the voice module. This file
 * is the whole of what passes between them, kept import-free so the repo's
 * test runner can execute the parts worth testing.
 *
 * Transcribed text does not travel through this type. It arrives by calling
 * `ComposerHandle.append(text)`, which is what lets dictation land in a draft
 * someone has already started typing rather than replacing it.
 */

export type VoiceStatus =
  /** No capture path, no model, or permission refused. The button is disabled. */
  | 'unavailable'
  /** Ready. Pressing starts capture. */
  | 'idle'
  /** Capturing right now. Pressing again stops it. */
  | 'listening'
  /** Capture finished, turning audio into text. */
  | 'transcribing';

export type VoiceDictation = {
  status: VoiceStatus;
  /**
   * Why it cannot be used, in words a person can act on.
   *
   * Shown as the disabled button's tooltip, so it has to name the actual
   * obstacle — "needs a one-time 78 MB download" tells someone what to do,
   * "unavailable" does not.
   */
  reason?: string;
  /** Begins capture. Only called from `idle`. */
  start: () => void;
  /** Ends capture immediately. Only called from `listening`. */
  stop: () => void;
};

/**
 * What the microphone button says and does in each state.
 *
 * Pulled out of the component because it is the part with rules: every state
 * needs a distinct accessible name, and the disabled one has to explain itself
 * rather than going quiet.
 */
export function describeVoiceControl(dictation: VoiceDictation | undefined): {
  status: VoiceStatus;
  label: string;
  title: string;
  disabled: boolean;
  pressed: boolean;
} {
  const status = dictation?.status ?? 'unavailable';

  if (status === 'listening') {
    return {
      status,
      // Stopping must never be harder to find than starting, so it is the same
      // button and it says so.
      label: 'Stop dictation',
      title: 'Stop dictation',
      disabled: false,
      pressed: true,
    };
  }

  if (status === 'transcribing') {
    return {
      status,
      label: 'Transcribing your speech',
      title: 'Transcribing…',
      disabled: true,
      pressed: false,
    };
  }

  if (status === 'idle') {
    return {
      status,
      label: 'Start dictation',
      title: 'Dictate a message — runs on this machine',
      disabled: false,
      pressed: false,
    };
  }

  return {
    status: 'unavailable',
    label: 'Dictation unavailable',
    // The reason is the whole point of the disabled state: a button that is
    // off and silent about why is indistinguishable from one that is broken.
    title: dictation?.reason ?? 'Dictation is not available yet',
    disabled: true,
    pressed: false,
  };
}
