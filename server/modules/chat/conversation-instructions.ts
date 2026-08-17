import { preferencesRepository } from '@/db/preferences.repository.js';

/**
 * How much of the user's own prompt is carried.
 *
 * This text is not sent once, it is appended to the system prompt of *every*
 * turn in every conversation, forever. So the cost of a runaway paste is not a
 * one-off — it is a permanent tax on a request that already resends its whole
 * history, and nothing in the UI would ever show it being paid.
 *
 * Two thousand characters is roughly five hundred tokens: a paragraph of house
 * style plus a handful of specific rules, which is what people actually write
 * here, and small enough that pasting a document into the box is refused at the
 * field where the user can see it rather than silently billed.
 */
export const CONVERSATION_INSTRUCTIONS_MAX_LENGTH = 2000;

const PREFERENCE_KEY = 'chat.conversationInstructions';

/**
 * The storable form of whatever arrived.
 *
 * Clamped rather than rejected: a paste a few characters over the limit should
 * cost the user the tail of their text, not the save. Trimmed on both sides of
 * the clamp — before, so leading whitespace does not eat the budget, and after,
 * so a cut that lands mid-space does not store a trailing one.
 */
export function normalizeConversationInstructions(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, CONVERSATION_INSTRUCTIONS_MAX_LENGTH).trim();
}

/**
 * The user's instructions as a section of the system prompt's `append`.
 *
 * Three decisions here, none of them cosmetic.
 *
 * **It appends, and it can only ever append.** The preset underneath is the
 * Claude Code system prompt — the tooling, the file editing, the entire agent —
 * and the text this joins is the app's own briefing about its appearance tools.
 * A setting that replaced either would produce an app that still runs every
 * feature and is quietly worse at all of them, which is close to undiagnosable
 * from the outside.
 *
 * **It introduces itself as the user's words.** The briefing it follows is
 * app-authored prose about MCP tools; run onto the end of that with a space,
 * "keep answers to three sentences" reads as one more clause of ours and the
 * model has no way to tell who asked for it. It is also told what it does not
 * outrank, because a standing preference about tone should not be able to talk
 * the agent out of using a tool.
 *
 * **It goes last, unfenced.** Nothing is escaped — it is the user's text
 * reaching the user's own agent, and sanitising it would only mangle the
 * apostrophes and angle brackets of someone writing about formatting. Being
 * last is what makes that safe rather than merely permitted: there is no
 * closing delimiter to break out of and nothing after it to be mistaken for, so
 * the worst a stray backtick or `</instructions>` can do is look odd. Anything
 * added to this append later belongs *above* the call to this function.
 */
export function formatConversationInstructions(text: string): string {
  const instructions = normalizeConversationInstructions(text);
  if (!instructions) return '';

  return `${[
    'The user has written standing instructions for how they want you to converse in this app.',
    'They govern how you say things — tone, length, formatting, how much you explain — and they apply to every reply.',
    'They do not narrow what you may do: keep using your tools exactly as you otherwise would, and where they conflict with a direct request in the conversation itself, the conversation wins.',
    "Everything from the next line to the end of this message is the user's own text, verbatim:",
  ].join(' ')}\n\n${instructions}`;
}

/**
 * The instructions in force.
 *
 * Read from sqlite per turn rather than cached in memory. It is a primary-key
 * lookup on a one-row table, and the alternative is a window that has just
 * saved a change disagreeing with a run that starts a moment later about what
 * the user asked for.
 */
export function readConversationInstructions(): string {
  // Normalised on the way out as well as in. The cap can only ever be lowered
  // by someone who has already thought about the token cost, and when it is,
  // text stored under the old one must not keep being sent.
  return normalizeConversationInstructions(preferencesRepository.read(PREFERENCE_KEY));
}

/** Returns what was actually stored, which is the clamped form of the input. */
export function writeConversationInstructions(value: unknown): string {
  const instructions = normalizeConversationInstructions(value);
  preferencesRepository.write(PREFERENCE_KEY, instructions);
  return instructions;
}
