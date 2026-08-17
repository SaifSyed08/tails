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
  modelPresent: boolean;
  enginePresent: boolean;
  downloadMiB: number;
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

export const voiceApi = {
  status: () => get<DictationStatus>('/api/voice/status'),
  wake: () => get<WakeStatus>('/api/voice/wake'),

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

export function writeArmed(ids: string[]): void {
  try {
    localStorage.setItem(ARMED_KEY, JSON.stringify(ids));
  } catch {
    // A full or blocked localStorage costs a preference, not the feature.
  }
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
}
