import fs from 'node:fs';
import path from 'node:path';

import { TAILS_HOME } from '@/db/connection.js';

/**
 * Where the model actually runs, and how this app finds it.
 *
 * ## What this does not do
 *
 * It does not download models and it does not run one. That is deliberate, and
 * not laziness: model weights are gigabytes, quantisation choices are personal,
 * and there are already four good programs whose whole job is holding a local
 * model and serving it — Ollama, llama.cpp's own server, LM Studio, vLLM. This
 * app's job is to *find* one and speak to it.
 *
 * It also keeps the app's standing rule intact. Nothing here can start a
 * multi-gigabyte download, because nothing here downloads at all: the weights
 * on the machine are the ones the user chose in their runner, and this can only
 * list what is already there.
 *
 * ## Why the addresses are hard-coded
 *
 * These four are the defaults of the four programs, and a user who has changed
 * theirs can type it in. Scanning ports to discover a model server would be
 * scanning the user's machine, which is not a thing a chat app should do
 * uninvited.
 */

/** The runners worth looking for, with the port each installs itself on. */
export const KNOWN_RUNNERS = [
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'llama-cpp', label: 'llama.cpp server', baseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'lm-studio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'vllm', label: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
] as const;

export type RoutingSettings = {
  /** `anthropic` is Claude Code as shipped. `local` routes it elsewhere. */
  provider: 'anthropic' | 'local';
  /** An OpenAI-compatible base URL, ending in `/v1`. */
  baseUrl: string;
  /** The model name as the runner knows it. */
  model: string;
  /**
   * Sent as the bearer token to the runner.
   *
   * Most local runners ignore it. vLLM behind a key and a remote OpenAI-shaped
   * endpoint do not, so it exists — and it is stored beside the OpenAI key,
   * with the same rules: write-only, never returned, never logged.
   */
  apiKey?: string;
};

const SETTINGS_FILE = path.join(TAILS_HOME, 'routing.json');

const DEFAULTS: RoutingSettings = {
  provider: 'anthropic',
  baseUrl: KNOWN_RUNNERS[0].baseUrl,
  model: '',
};

export function readRouting(): RoutingSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>;

    return {
      // Anything but the exact string is the default, which is the safe one:
      // an unreadable settings file must not silently move the user's work onto
      // a 3B model.
      provider: raw.provider === 'local' ? 'local' : 'anthropic',
      baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : DEFAULTS.baseUrl,
      model: typeof raw.model === 'string' ? raw.model : '',
      ...(typeof raw.apiKey === 'string' && raw.apiKey ? { apiKey: raw.apiKey } : {}),
    };
  } catch {
    return DEFAULTS;
  }
}

export function writeRouting(next: Partial<RoutingSettings>): RoutingSettings {
  const merged = { ...readRouting(), ...next };
  const clean: RoutingSettings = {
    provider: merged.provider === 'local' ? 'local' : 'anthropic',
    baseUrl: normaliseBaseUrl(merged.baseUrl),
    model: merged.model.trim(),
    ...(merged.apiKey ? { apiKey: merged.apiKey } : {}),
  };

  fs.mkdirSync(TAILS_HOME, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(clean, null, 2), { mode: 0o600 });
  return clean;
}

/**
 * Tidies an address the user typed.
 *
 * Two mistakes are near-universal and both produce a 404 that says nothing:
 * pasting the bare host without `/v1`, and pasting the full completions path.
 * Both are recognisable, so both are corrected here rather than diagnosed by
 * the user.
 */
export function normaliseBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!url) return DEFAULTS.baseUrl;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;

  url = url.replace(/\/chat\/completions$/i, '');
  if (!/\/v\d+$/i.test(url)) url = `${url}/v1`;
  return url;
}

/**
 * Whether routing is on *and* usable.
 *
 * A provider set to `local` with no model chosen is a half-finished setting, and
 * running a turn against it would fail inside the CLI with an error about a
 * model name — several layers away from the empty field that caused it. So an
 * incomplete configuration reports itself as not active, and the turn goes to
 * Anthropic as it always did.
 */
export const localRoutingActive = (settings = readRouting()): boolean =>
  settings.provider === 'local' && settings.model.length > 0;

export type RunnerProbe = {
  id: string;
  label: string;
  baseUrl: string;
  reachable: boolean;
  models: string[];
};

/** How long to wait for a runner that is not there. Short: this is a probe. */
const PROBE_TIMEOUT_MS = 1_200;

/**
 * Asks one OpenAI-compatible endpoint what it is serving.
 *
 * Never throws. "Not running" is the expected answer for three of the four
 * addresses on any given machine, and it is not an error worth a stack trace.
 */
export async function probeRunner(
  runner: { id: string; label: string; baseUrl: string },
  apiKey?: string,
): Promise<RunnerProbe> {
  const empty = { ...runner, reachable: false, models: [] as string[] };

  try {
    const response = await fetch(`${runner.baseUrl}/models`, {
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return empty;

    const payload = await response.json() as { data?: { id?: unknown }[] };
    const models = (payload.data ?? [])
      .map((entry) => (typeof entry.id === 'string' ? entry.id : null))
      .filter((id): id is string => id !== null)
      .sort((a, b) => a.localeCompare(b));

    return { ...runner, reachable: true, models };
  } catch {
    return empty;
  }
}

/**
 * Looks for every runner at once, plus the address the user configured.
 *
 * In parallel because three of them will time out, and doing that in sequence
 * is four seconds of a settings panel looking broken.
 */
export async function discoverRunners(): Promise<RunnerProbe[]> {
  const settings = readRouting();
  const custom = KNOWN_RUNNERS.some((runner) => runner.baseUrl === settings.baseUrl)
    ? []
    : [{ id: 'custom', label: 'Configured address', baseUrl: settings.baseUrl }];

  return Promise.all(
    [...KNOWN_RUNNERS, ...custom].map((runner) => probeRunner(runner, settings.apiKey)),
  );
}

/**
 * What the settings panel reads. Never includes the key.
 */
export function readRoutingStatus() {
  const settings = readRouting();
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    keySaved: Boolean(settings.apiKey),
    active: localRoutingActive(settings),
    runners: KNOWN_RUNNERS,
  };
}

/**
 * The environment that makes Claude Code talk to the local model instead.
 *
 * ## The whole mechanism, in three variables
 *
 * The CLI has no setting for "use a different model provider". What it has is an
 * address (`ANTHROPIC_BASE_URL`) and a credential, and it will send its ordinary
 * Anthropic-shaped traffic to whatever is there. So routing is not a feature the
 * CLI exposes; it is a consequence of pointing it at this app.
 *
 * The token is a placeholder. The endpoint it reaches is on loopback, in this
 * same process, and ignores it — but the CLI refuses to run with no credential
 * at all, so something has to be there. It is deliberately not a real key: if
 * this ever leaked into a log it should be obviously worthless.
 *
 * `ANTHROPIC_API_KEY` is set as well as `ANTHROPIC_AUTH_TOKEN` because which of
 * the two the CLI prefers has moved between versions, and the cost of setting
 * both is nothing.
 *
 * Returns an empty object when routing is off, so the caller can spread it
 * unconditionally and the default path stays byte for byte what it was.
 */
export function localRoutingEnv(serverPort: number): Record<string, string> {
  const settings = readRouting();
  if (!localRoutingActive(settings)) return {};

  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${serverPort}/api/routing`,
    ANTHROPIC_AUTH_TOKEN: 'tails-local-routing',
    ANTHROPIC_API_KEY: 'tails-local-routing',
  };
}
