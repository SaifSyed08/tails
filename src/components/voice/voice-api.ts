/**
 * The voice module's own HTTP client.
 *
 * Separate from `@/lib/api` because that client is shaped around sessions and
 * themes, and because everything here is about a capability that may simply be
 * absent — the interesting responses are "no engine", "no model", "not
 * downloaded", none of which are errors.
 */

export type DictationStatus = {
  ready: boolean;
  reason?: string;
  /** Which engine answered. The reason belongs to this one, not to the other. */
  provider?: TranscriptionProvider;
  /** False for the cloud: a partial is a second billed request. */
  supportsPartials?: boolean;
  modelPresent: boolean;
  enginePresent: boolean;
  downloadMiB: number;
};

export type TranscriptionProvider = 'local' | 'openai' | 'assemblyai';

export type CloudModel = { id: string; label: string; note: string };

/**
 * Everything the transcription section draws itself from.
 *
 * Note what is *not* here: the key. It is written to the server and never read
 * back — `keyHint` is its last four characters, which is enough to tell two
 * keys apart and worthless to anyone who sees a screenshot.
 */
export type TranscriptionStatus = {
  provider: TranscriptionProvider;
  cloudModel: string;
  models: CloudModel[];
  keySaved: boolean;
  keyHint: string | null;
  /** Whether the streaming provider's key is saved. Never the key. */
  streamingConfigured: boolean;
  streamingKeyHint: string | null;
  ready: boolean;
  reason?: string;
  supportsPartials: boolean;
  local: {
    ready: boolean;
    reason?: string;
    modelPresent: boolean;
    enginePresent: boolean;
    downloadMiB: number;
  };
};

export type WakeWordEntry = {
  id: string;
  /** Model filename, which the Worker fetches from the server. */
  file: string;
  label: string;
  installed: boolean;
  /** CC-BY-NC-SA weights. The toggle has to say so. */
  nonCommercial: boolean;
  threshold: number;
  /** True for a phrase known to fire by accident more often. */
  belowPhraseFloor: boolean;
  /** Bytes still to fetch before this can be armed. Zero when installed. */
  downloadBytes: number;
};

export type WakeStatus = {
  sharedModelsPresent: boolean;
  reason?: string;
  thresholdRange: { min: number; max: number };
  words: WakeWordEntry[];
};

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
  return response.json() as Promise<T>;
}

/**
 * A write, with the server's own message on failure.
 *
 * The message matters more here than in most places: the failures are "that key
 * looks wrong" and "that key was rejected", which are things the user can act
 * on, and a generic "request failed" would waste the one useful sentence the
 * server had.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? `${path} failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

export const voiceApi = {
  status: () => get<DictationStatus>('/api/voice/status'),
  wake: () => get<WakeStatus>('/api/voice/wake'),
  transcription: () => get<TranscriptionStatus>('/api/voice/transcription'),

  /** Chooses the engine. Selecting `openai` is when audio starts leaving. */
  async setTranscription(next: { provider?: TranscriptionProvider; cloudModel?: string }) {
    return post<TranscriptionStatus>('/api/voice/transcription', next);
  },

  /**
   * Saves the key, or clears it with an empty string.
   *
   * One-way on purpose: there is no companion getter. The response is the same
   * status every other control reads, so a save can be confirmed without the
   * value making the return trip.
   */
  async saveKey(key: string) {
    return post<TranscriptionStatus>('/api/voice/transcription/key', { key });
  },

  /**
   * The streaming provider's key.
   *
   * Its own call rather than a flag on `saveKey`, because the two keys belong to
   * different vendors — one endpoint deciding which by looking at the string is
   * a way to send one vendor's credential to the other.
   */
  async setStreamingKey(key: string) {
    return post<TranscriptionStatus>('/api/voice/transcription/streaming-key', { key });
  },

  /** Fetches the dictation model. Only ever called from an explicit press. */
  async downloadSpeechModel(): Promise<void> {
    const response = await fetch('/api/voice/model', { method: 'POST' });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? 'The speech model could not be downloaded.');
    }
  },

  /** Fetches one wake word's models. Same rule: explicit press only. */
  async downloadWakeWord(id: string): Promise<void> {
    const response = await fetch(`/api/voice/wake/${encodeURIComponent(id)}/download`, { method: 'POST' });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? 'That wake word could not be downloaded.');
    }
  },
};

/** Bytes as something a person can weigh a decision against. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '';
  const mb = bytes / 1_048_576;
  return mb < 1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

const ARMED_KEY = 'tails.voice.armedWakeWords';
const SENSITIVITY_KEY = 'tails.voice.wakeSensitivity';

/**
 * Which wake words are armed, and how sensitive each is.
 *
 * Kept in `localStorage` rather than the database for the same reason the
 * colour mode is: it is a per-machine preference about a per-machine
 * capability, and the models it refers to live on this machine's disk. Syncing
 * it would mean arming a wake word whose model is not there.
 */
export function readArmed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ARMED_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Announces that the wake-word preference moved.
 *
 * `localStorage` has no same-document change event — `storage` fires in *other*
 * tabs only — so a settings panel and a chat view in one window have no way to
 * hear each other. Without this, arming a wake word in Settings did nothing
 * until the app was restarted, which reads exactly like the wake word being
 * broken.
 *
 * Published from the writers below rather than from the settings panel, so
 * there is no way to change the preference and forget to say so.
 */
const WAKE_CHANGED_EVENT = 'tails:voice-wake-changed';

export function onWakeSettingsChanged(listener: () => void): () => void {
  window.addEventListener(WAKE_CHANGED_EVENT, listener);
  return () => window.removeEventListener(WAKE_CHANGED_EVENT, listener);
}

function announce(): void {
  window.dispatchEvent(new Event(WAKE_CHANGED_EVENT));
}

export function writeArmed(ids: string[]): void {
  try {
    localStorage.setItem(ARMED_KEY, JSON.stringify(ids));
  } catch {
    // A full or blocked localStorage costs a preference, not the feature.
  }
  announce();
}

export function readSensitivity(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(SENSITIVITY_KEY) ?? '{}') as unknown;
    return typeof raw === 'object' && raw !== null ? raw as Record<string, number> : {};
  } catch {
    return {};
  }
}

export function writeSensitivity(values: Record<string, number>): void {
  try {
    localStorage.setItem(SENSITIVITY_KEY, JSON.stringify(values));
  } catch {
    // As above.
  }
  announce();
}
