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
/**
 * A command at the very start, slash-prefixed or bare.
 *
 * `[\w-]+` is greedy on purpose: it takes the whole first word, so
 * `ultracoded` reads as `ultracoded` and matches nothing, rather than matching
 * `ultracode` and swallowing a word that merely begins with it.
 */
const LEADING_PATTERN = /^([/\\]?)([\w-]+)/;

/**
 * An explicitly slashed command anywhere in the message.
 *
 * The boundary before the slash is the whole safety of this. `src/ultracode.ts`
 * has a letter in front of the slash and must stay a path; a command has
 * whitespace or the start of the message in front of it. Without that, every
 * file path in a conversation about this codebase would arm a command.
 *
 * Bare words are deliberately *not* matched here. "can you ultracode this" is a
 * sentence and has to send as one — the slash is what turns a word into an
 * instruction, and it is the only thing that can.
 */
const INLINE_PATTERN = /(?:^|\s)([/\\])([\w-]+)/g;

export type StyledCommand = {
  name: StyledCommandName;
  /** Exactly the text that triggered it, so it can be re-rendered verbatim. */
  token: string;
  /** Where the token starts in the original text. */
  index: number;
};

/**
 * Reads the styled command in a message, wherever it is.
 *
 * Two rules, and the asymmetry is the point:
 *
 * - **Slashed, anywhere.** `/personalize make it blue` and `make it blue
 *   /personalize` are the same instruction, and only one of them used to work.
 *   Typing the command last is natural — you describe what you want and then
 *   name the thing that does it — and it silently sent as prose.
 * - **Bare, only at the start.** "can you ultracode this" is a sentence and a
 *   path like `src/a.ts` is a path. Both must send as what they are.
 */
export function readStyledCommand(text: string): StyledCommand | null {
  const leadingOffset = text.length - text.trimStart().length;
  const leading = LEADING_PATTERN.exec(text.trimStart());

  if (leading) {
    const [token, prefix, rawName] = leading;
    const name = rawName.toLowerCase();
    if (STYLED_COMMANDS.some((entry) => entry === name)) {
      // A leading slash arms any of them. Anything else — a bare word, or the
      // backslash people reach for instead — arms only those that opted in.
      if (prefix === '/' || BARE_TRIGGERS.has(name)) {
        return { name: name as StyledCommandName, token, index: leadingOffset };
      }
    }
  }

  // Nothing at the start, so look for an explicit slash further in.
  INLINE_PATTERN.lastIndex = 0;
  for (let match = INLINE_PATTERN.exec(text); match; match = INLINE_PATTERN.exec(text)) {
    const [whole, prefix, rawName] = match;
    const name = rawName.toLowerCase();
    if (prefix !== '/') continue;
    if (!STYLED_COMMANDS.some((entry) => entry === name)) continue;

    const token = `${prefix}${rawName}`;
    return {
      name: name as StyledCommandName,
      token,
      // `whole` may include the leading whitespace the boundary matched.
      index: match.index + (whole.length - token.length),
    };
  }

  return null;
}
