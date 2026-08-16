import { query, type EffortLevel, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';

/** One model the account can actually pick, as the composer needs it. */
export type ModelChoice = {
  /** The wire id passed straight back as `options.model`. */
  id: string;
  /** What to show a person, e.g. `Opus (1M context)`. */
  displayName: string;
  description?: string;
  /**
   * Effort levels this model accepts, in the SDK's own order.
   *
   * Empty for a model with no effort control, which is not the same as a model
   * that accepts every level — the picker has to be able to tell those apart.
   */
  effortLevels: EffortLevel[];
};

export type SessionModels = {
  /**
   * What Claude Code resolves to here with no override.
   *
   * Null when it could not be read, which is also what makes the badge absent
   * rather than approximate.
   */
  current: ModelChoice | null;
  /** Everything the account may choose. Empty when the catalogue is unreadable. */
  models: ModelChoice[];
};

/**
 * How long a resolved catalogue is reused.
 *
 * Reading it spawns a CLI subprocess, so it must not happen per render. The
 * answer only changes when the user changes their Claude Code configuration,
 * which is not something that happens inside a chat.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** How long to wait for the init event before giving up and reporting nothing. */
const RESOLVE_TIMEOUT_MS = 8000;

const EMPTY: SessionModels = { current: null, models: [] };

const cache = new Map<string, { models: SessionModels; expiresAt: number }>();

/**
 * The alias row, which is a pointer rather than a model.
 *
 * `supportedModels()` returns a row whose value is `default` and whose display
 * name is "Default (recommended)". It resolves to whichever model the user has
 * configured, so it answers a different question than the picker asks — and
 * offering it alongside the model it points at would give the same choice two
 * names. Reverting to the configured default is expressed by choosing nothing.
 */
const ALIAS_VALUE = 'default';

function toChoice(entry: ModelInfo): ModelChoice {
  return {
    id: entry.value,
    displayName: entry.displayName,
    ...(entry.description ? { description: entry.description } : {}),
    effortLevels: entry.supportsEffort ? [...(entry.supportedEffortLevels ?? [])] : [],
  };
}

/**
 * Resolves the wire id the CLI announced back to a catalogue row.
 *
 * Two rows can resolve to the same wire id: the alias the user selected and
 * the model it points at. The alias's name is the last resort, because the
 * badge exists to say *which* model, not that a default is in force.
 */
function resolveCurrent(id: string, catalogue: ModelInfo[]): ModelChoice {
  const named = catalogue.filter((entry) => entry.value !== ALIAS_VALUE);
  const match = named.find((entry) => entry.value === id)
    ?? named.find((entry) => entry.resolvedModel === id)
    ?? catalogue.find((entry) => entry.value === id || entry.resolvedModel === id);

  // Falling back to the raw id rather than inventing a marketing name: a wrong
  // model name is worse than an unfamiliar one.
  return match ? toChoice(match) : { id, displayName: id, effortLevels: [] };
}

/**
 * Reads the models available in this folder, and which one is in force.
 *
 * Both come from one throwaway subprocess: the catalogue from a control
 * request, and the resolved model from the CLI's own `system`/`init` event —
 * the only authoritative source, since it reflects settings, config and any
 * per-project override that this app cannot see. It arrives about a hundred
 * milliseconds in and needs no prompt.
 */
export async function readSessionModels(cwd: string): Promise<SessionModels> {
  const cached = cache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) return cached.models;

  let resolved: SessionModels = EMPTY;

  try {
    // `persistSession: false` keeps this from leaving an empty conversation in
    // the sidebar, exactly as the command listing does.
    const instance = query({
      prompt: '',
      options: { cwd, persistSession: false, env: { ...process.env } as Record<string, string> },
    });

    try {
      const catalogue = await instance.supportedModels().catch((): ModelInfo[] => []);
      const models = catalogue.filter((entry) => entry.value !== ALIAS_VALUE).map(toChoice);
      resolved = { current: null, models };

      const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
      for await (const message of instance) {
        const event = message as { type?: string; model?: unknown };
        if (event.type === 'system' && typeof event.model === 'string' && event.model) {
          resolved = { current: resolveCurrent(event.model, catalogue), models };
          break;
        }
        // A stream that never announces a model must not hold the request open.
        if (Date.now() > deadline) break;
      }
    } finally {
      instance.close();
    }
  } catch {
    // No CLI, no auth, an unreadable folder. All of them mean the same thing to
    // the caller: we cannot say what is available, so we do not say.
    resolved = EMPTY;
  }

  cache.set(cwd, { models: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
  return resolved;
}

/**
 * The catalogue if it is already known, without going and fetching it.
 *
 * Used on the send path, which must not pay for a subprocess: a cold cache
 * means the turn runs unvalidated rather than slowly. The composer warms it on
 * mount, so in practice it is there.
 */
export function peekSessionModels(cwd: string): SessionModels | null {
  const cached = cache.get(cwd);
  return cached && cached.expiresAt > Date.now() ? cached.models : null;
}
