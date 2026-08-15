import { query } from '@anthropic-ai/claude-agent-sdk';

/** The model a conversation will actually run on. */
export type SessionModel = {
  /** The wire id, e.g. `claude-opus-5[1m]`. */
  id: string;
  /** What to show a person, e.g. `Opus (1M context)`. Falls back to the id. */
  displayName: string;
};

/**
 * How long a resolved model is reused.
 *
 * Reading it spawns a CLI subprocess, so it must not happen per render. The
 * answer only changes when the user changes their Claude Code configuration,
 * which is not something that happens inside a chat.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** How long to wait for the init event before giving up and reporting nothing. */
const RESOLVE_TIMEOUT_MS = 8000;

const cache = new Map<string, { model: SessionModel | null; expiresAt: number }>();

/**
 * Prettifies a wire id we could not match against the model list.
 *
 * Deliberately conservative — it only tidies the id it was given. Inventing a
 * marketing name for an id this build does not recognise would be a guess, and
 * a wrong model name is worse than a raw one.
 */
function fallbackName(id: string): string {
  return id;
}

/**
 * Reads the model Claude Code would use in this folder.
 *
 * The only authoritative source is the CLI's own `system`/`init` event, which
 * reflects settings, config and any per-project override — none of which this
 * app can see. It arrives within about a hundred milliseconds of the
 * subprocess starting and needs no prompt, so this asks for it directly rather
 * than waiting for the user's first message and inferring from that.
 *
 * Returns null rather than a placeholder when anything goes wrong: the caller
 * shows nothing at all in that case, which is the honest outcome.
 */
export async function readSessionModel(cwd: string): Promise<SessionModel | null> {
  const cached = cache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) return cached.model;

  let model: SessionModel | null = null;

  try {
    // `persistSession: false` keeps this from leaving an empty conversation in
    // the sidebar, exactly as the command listing does.
    const instance = query({
      prompt: '',
      options: { cwd, persistSession: false, env: { ...process.env } as Record<string, string> },
    });

    try {
      const catalogue = await instance.supportedModels().catch(() => []);
      const deadline = Date.now() + RESOLVE_TIMEOUT_MS;

      for await (const message of instance) {
        const event = message as { type?: string; subtype?: string; model?: unknown };
        if (event.type === 'system' && typeof event.model === 'string' && event.model) {
          const id = event.model;
          /*
            Two rows can resolve to the same wire id: the alias the user
            selected ("default") and the model it actually points at
            ("opus[1m]"). The alias's display name is "Default (recommended)",
            which answers a different question than the one being asked — the
            badge is there to say *which* model — so the alias rows are the
            last resort, not the first match.
          */
          const named = catalogue.filter((entry) => entry.value !== 'default');
          const match = named.find((entry) => entry.value === id)
            ?? named.find((entry) => entry.resolvedModel === id)
            ?? catalogue.find((entry) => entry.value === id || entry.resolvedModel === id);
          model = { id, displayName: match?.displayName ?? fallbackName(id) };
          break;
        }
        // A stream that never announces a model must not hold the request open.
        if (Date.now() > deadline) break;
      }
    } finally {
      instance.close();
    }
  } catch {
    // No CLI, no auth, an unreadable folder. All of them mean the same thing
    // to the caller: we cannot say what model this is, so we do not say.
    model = null;
  }

  cache.set(cwd, { model, expiresAt: Date.now() + CACHE_TTL_MS });
  return model;
}
