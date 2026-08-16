/**
 * Recognising the commands that carry a look of their own.
 *
 * Import-free so the repo's test runner can execute it directly.
 */

/** The commands with their own visual treatment. */
export const STYLED_COMMANDS = ['personalize', 'ultracode'] as const;

export type StyledCommandName = typeof STYLED_COMMANDS[number];

/**
 * Commands that also answer to their bare name.
 *
 * Only `ultracode`, and only because it was asked for. A slash is a deliberate
 * gesture; a bare word is one someone can type by accident, so opting a
 * command in means accepting that "ultracode the parser" can never be sent as
 * ordinary text. That is a fine trade for one command and a bad default for
 * all of them.
 */
const BARE_TRIGGERS = new Set<string>(['ultracode']);

/**
 * Anchored at the start, because that is the only place a command can be.
 *
 * `[\w-]+` is greedy on purpose: it takes the whole first word, so
 * `ultracoded` reads as `ultracoded` and matches nothing, rather than matching
 * `ultracode` and swallowing a word that merely begins with it.
 */
const COMMAND_PATTERN = /^([/\\]?)([\w-]+)/;

export type StyledCommand = {
  name: StyledCommandName;
  /** Exactly the text that triggered it, so it can be re-rendered verbatim. */
  token: string;
};

/**
 * Reads the styled command a message opens with, if it opens with one.
 *
 * Mid-sentence never counts: "can you ultracode this" is a sentence, and a
 * path like `src/a.ts` is a path. Both must send as what they are.
 */
export function readStyledCommand(text: string): StyledCommand | null {
  const match = COMMAND_PATTERN.exec(text.trimStart());
  if (!match) return null;

  const [token, prefix, rawName] = match;
  const name = rawName.toLowerCase();
  if (!STYLED_COMMANDS.some((entry) => entry === name)) return null;

  // A leading slash arms any of them. Anything else — a bare word, or the
  // backslash people reach for instead — arms only those that opted in.
  if (prefix !== '/' && !BARE_TRIGGERS.has(name)) return null;

  return { name: name as StyledCommandName, token };
}
