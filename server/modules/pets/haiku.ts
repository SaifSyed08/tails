import { query } from '@anthropic-ai/claude-agent-sdk';

import { sessionsRepository } from '@/db/sessions.repository.js';
import { resolveClaudeCli } from '@/modules/chat/claude-cli.js';

/**
 * One short answer from a cheap model, with no agent attached.
 *
 * ## Why this goes through the CLI and not the API
 *
 * The obvious way to ask a small model for one line is the Messages API, and it
 * needs a key the user has not given us. The CLI is already installed and
 * already authenticated — it is how every other turn in this app runs — so
 * borrowing it costs nothing to set up and nothing to explain. The trade is a
 * process spawn per call, about a second, which is fine for something that
 * happens after a turn has already finished and is never on the critical path.
 *
 * It does consume the user's Claude usage. That is worth knowing and worth
 * keeping small, which is most of why this function is shaped the way it is.
 *
 * ## Nothing agentic about it
 *
 * The preset system prompt *is* Claude Code — the tools, the file editing, the
 * whole agent. For "say one funny line as a hedgehog" that is thousands of
 * tokens of irrelevant instruction and a model that might decide to read a file
 * first. So the preset is replaced with a plain string, the tool list is empty,
 * and the turn count is one. What is left is a chat completion.
 */

/** The model. Cheap and fast is the entire requirement. */
const MODEL = 'claude-haiku-4-5';

/**
 * How long to wait before giving up.
 *
 * Generous enough for a process spawn on a cold cache, short enough that a
 * wedged CLI cannot leave a caller hanging. Every caller here has a fallback,
 * so an expiry costs a flourish rather than a feature.
 */
const TIMEOUT_MS = 20_000;

export type AskOptions = {
  system: string;
  prompt: string;
  /**
   * Whether to clean the answer up as a single line.
   *
   * True for a remark, and it has to be false for anything structured. The
   * cleaner picks the longest *line* of the reply, which for a JSON object is
   * one array element — so the first version of the bank generator got back a
   * 36-character fragment, `Now THAT'S what I'm talking about!",`, and parsed
   * an empty bank from it. The cleaner was not wrong; it was being asked the
   * wrong question.
   */
  clean?: boolean;
  /**
   * How long to wait, overriding the default.
   *
   * Needed because the two callers are not the same shape of request: one line
   * comes back in a few seconds, and a bank of twenty-five takes considerably
   * longer. The first version used one timeout for both and silently aborted
   * every bank it ever tried to generate.
   */
  timeoutMs?: number;
  /**
   * Hard ceiling on the reply, in characters, applied after the fact.
   *
   * A small model told "one short line" will sometimes write three. Trimming is
   * not a substitute for asking properly — the callers do both — but it is the
   * only one of the two that is guaranteed.
   */
  limit?: number;
};

/**
 * Asks, and returns the text, or null.
 *
 * Never throws. Every use of this is decoration: a missing pet remark is a pet
 * that did not say anything, which is a state the feature already handles, and
 * turning it into an error would make a broken CLI break the chat as well.
 */
/** Once per session id, and never fatal — a visible extra chat beats a failure. */
const hidden = new Set<string>();
function hide(sessionId: string): void {
  if (hidden.has(sessionId)) return;
  hidden.add(sessionId);
  try {
    sessionsRepository.hideProviderSession(sessionId);
  } catch {
    // Worst case the user sees one conversation they did not start.
  }
}

export async function askHaiku(
  { system, prompt, limit, timeoutMs, clean = true }: AskOptions,
): Promise<string | null> {
  let cli;
  try {
    cli = resolveClaudeCli();
  } catch {
    return null;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs ?? TIMEOUT_MS);

  try {
    const instance = query({
      prompt,
      options: {
        model: MODEL,
        // A plain string, which *replaces* the Claude Code preset rather than
        // extending it. See the note above: the preset is the wrong instrument.
        systemPrompt: system,
        /*
          No tools at all, and this is the line that makes it cheap.

          `allowedTools: []` gates tool *use*; the schemas still travel with
          every request. Measured on "say the word ok": 22,457 tokens of
          cache-creation and $0.0458 a call, seventy-seven times the cost of the
          actual work. With the tool list emptied it is 684 tokens, no cache
          write, and $0.0012 — a thirty-nine-fold difference for one field.
        */
        tools: [] as never,
        allowedTools: [],
        maxTurns: 1,
        // No project settings, no CLAUDE.md, no MCP servers. This is not the
        // user's agent; it is a sentence generator.
        settingSources: [],
        abortController: abort,
        // Spread, never assigned: `options.env` replaces `process.env` in the
        // SDK, and a bare object strips PATH and the spawn fails.
        env: { ...process.env } as Record<string, string>,
        ...(cli.path ? { pathToClaudeCodeExecutable: cli.path } : {}),
      },
    });

    let text = '';
    for await (const message of instance) {
      const event = message as {
        type?: string;
        session_id?: string;
        message?: { content?: unknown };
      };

      /*
        Hide the session this call is creating.

        Every `query()` is a real Claude Code session, and Claude Code's own
        history is half of what the sidebar lists — so each pet whose lines were
        written left a conversation called "Write dialogue for Sonic pet
        character" sitting in the user's list. Eleven of them, after an
        afternoon's testing.

        Hidden rather than avoided, because there is no way to ask the CLI not to
        persist. The app already has this mechanism for the twin of an owned
        conversation; this is the same problem with a different cause. Done on
        the first event that carries the id, so a call that dies partway has
        still hidden what it made.
      */
      if (event.session_id) hide(event.session_id);

      if (event.type !== 'assistant') continue;

      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const block of blocks) {
        const part = block as { type?: string; text?: string };
        if (part.type === 'text' && part.text) text += part.text;
      }
    }

    const cleaned = clean ? tidy(text) : text.trim();
    if (!cleaned) return null;
    return limit && cleaned.length > limit ? `${cleaned.slice(0, limit - 1).trimEnd()}…` : cleaned;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/**
 * Strips the things a small model adds when asked for one line.
 *
 * Wrapping quotes, a leading "Sure!", markdown emphasis, a trailing newline.
 * None of these are failures worth discarding the answer over, and all of them
 * look wrong in a speech bubble two inches wide.
 */
/**
 * A line that introduces the answer rather than being it.
 *
 * Narrow deliberately: a false positive here deletes the pet's actual line, so
 * this matches an opener followed by nothing much, or a line ending in a colon,
 * and not merely a line that happens to begin with "sure".
 */
const SCAFFOLDING = /^(sure|okay|ok|of course|here (you go|are|is)|certainly|got it)\b.{0,24}$|:$/i;

export function tidy(text: string): string {
  let out = text.trim();

  /*
    One line out of several, and picking it by *length* was wrong.

    The first version took the longest line on the theory that the short ones are
    scaffolding. "Sure! Here you go:" is eighteen characters and "Gotta go fast!"
    is fourteen, so it reliably returned the preamble and discarded the answer.

    Scaffolding is recognisable by shape rather than by size — it opens with an
    acknowledgement, or it ends in a colon — so those lines are dropped and the
    content is taken from the end, which is where an answer that was introduced
    ends up.
  */
  const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const content = lines.filter((line) => !SCAFFOLDING.test(line));
  out = content[content.length - 1] ?? lines[lines.length - 1] ?? '';

  out = out
    /*
      Stage directions, whole.

      Stripping asterisks from the ends was worse than leaving them: asked for a
      line in character, the model offered `*perks up and curls into a happy
      little ball* Ooh, changes` — and trimming the edge asterisks turned a
      recognisable stage direction into prose the pet appeared to be saying.
      Removed as a span, so what is left is the dialogue.
    */
    .replace(/\*[^*]{0,80}\*/g, ' ')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/^\*+|\*+$/g, '')
    // A leading label the model added to itself, e.g. `Sonic: gotta go fast`.
    .replace(/^[A-Z][A-Za-z .'-]{0,20}:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return out;
}
