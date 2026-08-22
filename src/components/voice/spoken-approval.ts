/**
 * Answering a permission prompt out loud.
 *
 * Voice mode already listens, sends, and reads the reply back. It stops being
 * hands-free the moment Claude Code asks to run something: the request lands as
 * a card on screen, and a card needs a hand. This module is the part of closing
 * that gap which has rules — what a spoken answer means, and which answers are
 * too consequential to take on one word.
 *
 * Import-free on purpose: the repo's only test runner is the server's, and it
 * reaches this file by path. See `server/modules/voice/tests/spoken-approval.test.ts`.
 *
 * ## The asymmetry that decides every judgement call here
 *
 * A false "I did not understand" costs one repeated question. A false "yes"
 * runs a command the user did not agree to, possibly while they are on a walk
 * with the laptop shut. Those are not comparable, so every ambiguous case in
 * this file resolves to `unknown`, and every rule that guesses is written to
 * guess toward asking again.
 */

/** What a spoken answer to a permission request was understood to mean. */
export type SpokenIntent =
  /** Run it, this once. */
  | 'approve'
  /** Do not run it. */
  | 'deny'
  /** Say more about what this would do, then ask again. Commits to nothing. */
  | 'explain'
  /** Run it, and stop asking about this tool. Always needs a confirmation. */
  | 'always'
  /** Not understood, or understood as two contradictory things. Ask again. */
  | 'unknown';

/**
 * Strips an utterance down to the words, so matching is not defeated by
 * punctuation the recogniser chose to add.
 *
 * Apostrophes are removed rather than kept, so "don't" and "dont" are the same
 * token — recognisers disagree about them and the difference means nothing.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when `phrase` appears in `text` as whole words, not inside a longer one. */
function says(text: string, phrase: string): boolean {
  return new RegExp(`(^| )${phrase}( |$)`).test(text);
}

const APPROVE = [
  'yes', 'yeah', 'yep', 'yup', 'ya', 'sure', 'ok', 'okay', 'approve', 'approved',
  'allow', 'allowed', 'accept', 'go ahead', 'go for it', 'do it', 'run it',
  'sounds good', 'please do', 'affirmative', 'confirm', 'confirmed',
];

const DENY = [
  'no', 'nope', 'nah', 'deny', 'denied', 'dont', 'do not', 'stop', 'cancel',
  'reject', 'skip', 'never', 'no thanks', 'negative', 'hold off', 'not now',
];

const EXPLAIN = [
  'explain', 'what', 'what is it', 'what is that', 'why', 'details', 'detail',
  'tell me more', 'say again', 'repeat', 'come again', 'pardon', 'huh',
  'what does that do', 'more',
];

const ALWAYS = [
  'always', 'always allow', 'remember', 'remember that', 'dont ask again',
  'do not ask again', 'stop asking', 'every time', 'from now on', 'trust it',
];

function matches(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => says(text, phrase));
}

/**
 * Reads a spoken answer to a permission request.
 *
 * The precedence is not arbitrary:
 *
 * 1. **`explain` wins outright**, even mixed with something else. It is the one
 *    answer that commits to nothing, so treating "no, what does that do" as a
 *    request for detail costs a sentence and treating it as either commitment
 *    could be wrong. Explaining always ends by asking again.
 * 2. **`deny` alongside `approve` or `always` is `unknown`.** Two commitments in
 *    one breath is a recogniser error or a person changing their mind mid
 *    sentence, and neither is a mandate.
 * 3. **`always` outranks `approve`**, because "yes, always" is one answer rather
 *    than two — and it is caught by the confirmation rule below regardless.
 */
export function hearApproval(spoken: string): SpokenIntent {
  const text = normalize(spoken);
  if (!text) return 'unknown';

  if (matches(text, EXPLAIN)) return 'explain';

  /*
    The "always" phrases are read and then removed before anything else is
    looked for, because two of them contain a refusal: "dont ask again" and "do
    not ask again" both carry "dont", and scoring them against the raw utterance
    made the clearest possible way of saying "always" come out as a
    contradiction. What matters is whether a yes or a no survives *outside* the
    always phrase — "no, always" still contradicts itself, and still refuses.
  */
  const always = matches(text, ALWAYS);
  const rest = always
    ? ALWAYS.reduce((carry, phrase) => carry.replace(new RegExp(`(^| )${phrase}( |$)`, 'g'), ' '), text)
    : text;

  const approve = matches(rest, APPROVE);
  const deny = matches(rest, DENY);

  if (deny && (approve || always)) return 'unknown';
  if (always) return 'always';
  if (deny) return 'deny';
  if (approve) return 'approve';
  return 'unknown';
}

/**
 * Reads the answer to a yes-or-no confirmation.
 *
 * Deliberately stricter than `hearApproval`: this is the second question about
 * something already identified as consequential, so "explain" and "always" are
 * not answers to it, and anything that is not plainly one or the other is
 * `unknown`.
 */
export function hearConfirmation(spoken: string): 'yes' | 'no' | 'unknown' {
  const text = normalize(spoken);
  if (!text) return 'unknown';
  const yes = matches(text, APPROVE);
  const no = matches(text, DENY);
  if (yes === no) return 'unknown';
  return yes ? 'yes' : 'no';
}

/** Reads a spoken answer to a plan. Plans are approve-or-not; nothing else. */
export function hearPlanAnswer(spoken: string): 'approve' | 'deny' | 'explain' | 'unknown' {
  const intent = hearApproval(spoken);
  // "Always" means nothing for a plan — there is no next identical plan to
  // remember an answer for — so it reads as the approval it contains.
  if (intent === 'always') return 'approve';
  return intent;
}

/** How each position is said when the options are read out. */
const ORDINAL_WORDS = ['one', 'two', 'three', 'four'] as const;

/**
 * Ways of naming a position, in two tiers.
 *
 * The tiers exist because "one" is not only a number in English, it is also the
 * word that ends "the second one". Scored together, the bare numeral wins on
 * position and every "the second one" picks the first option — the worst
 * possible failure for this function, since it answers confidently and wrongly.
 *
 * So the unambiguous forms are tried across every option first, and the bare
 * numerals only get a turn when none of them matched.
 */
const STRONG_ORDINALS: readonly (readonly string[])[] = [
  ['1', 'first', 'number one', 'option one'],
  ['2', 'second', 'number two', 'option two'],
  ['3', 'third', 'number three', 'option three'],
  ['4', 'fourth', 'number four', 'option four'],
];

const WEAK_ORDINALS: readonly (readonly string[])[] = [
  ['one'], ['two'], ['three'], ['four'],
];

/** The single position an utterance names, or null if none or more than one. */
function readOrdinal(
  text: string,
  count: number,
  tier: readonly (readonly string[])[],
): number | null {
  const hits: number[] = [];
  for (let index = 0; index < Math.min(count, tier.length); index += 1) {
    if (matches(text, tier[index])) hits.push(index);
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Reads a spoken answer to one multiple-choice question.
 *
 * Two ways to answer, because people use both: the position ("the second one")
 * and the label ("the local one"). Position is tried first — it is exact, and a
 * label match is a guess about words the model chose.
 *
 * A label matches only if it is the *only* label the utterance could mean. Two
 * options whose labels both appear is `null`, not the first one: picking for
 * someone who named two things is the same failure as picking for someone who
 * named none.
 */
export function hearQuestionAnswer(spoken: string, labels: readonly string[]): number | null {
  const text = normalize(spoken);
  if (!text || labels.length === 0) return null;

  const strong = readOrdinal(text, labels.length, STRONG_ORDINALS);
  if (strong !== null) return strong;
  const weak = readOrdinal(text, labels.length, WEAK_ORDINALS);
  if (weak !== null) return weak;

  const hits: number[] = [];
  for (let index = 0; index < labels.length; index += 1) {
    const label = normalize(labels[index]);
    if (!label) continue;
    // Single-word labels have to match as a word; longer ones may appear inside
    // a sentence, which is how someone actually says them out loud.
    if (label.includes(' ') ? text.includes(label) : says(text, label)) hits.push(index);
  }
  return hits.length === 1 ? hits[0] : null;
}

/** Tools that change a file on disk. Never approved on a single word. */
const WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Shell commands worth a second question, and what to call them out loud.
 *
 * Ordered: the first match is the reason spoken, so the more alarming patterns
 * come first. They are deliberately over-eager — a pattern that fires on a
 * harmless command costs one extra spoken question, and one that fails to fire
 * can delete a repository. There is no version of this list that is exactly
 * right, so it is wrong in the direction that asks.
 */
const CONSEQUENCE: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(rm|rmdir|unlink|shred|truncate|del)\b|remove-item/i, reason: 'deletes files' },
  { pattern: /\bmkfs|\bdd\s+if=|\bformat\b|\bfdisk\b/i, reason: 'writes to a disk directly' },
  { pattern: /\bgit\s+push\b/i, reason: 'pushes to a remote' },
  { pattern: /\bgit\s+(reset\s+--hard|clean|branch\s+-d)\b/i, reason: 'throws away local work' },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b|\bgh\s+release\b/i, reason: 'publishes a release' },
  {
    pattern: /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\bcargo\s+install\b|\b(winget|choco|brew|apt|apt-get)\s+install\b/i,
    reason: 'installs packages',
  },
  {
    pattern: /(curl|wget|iwr|invoke-webrequest)[^|]*\|\s*(ba|z|fi)?sh\b/i,
    reason: 'runs a script off the internet',
  },
  { pattern: /\bsudo\b|\bchmod\b|\bchown\b|set-executionpolicy/i, reason: 'changes permissions' },
  { pattern: /\b(shutdown|reboot|kill|taskkill|pkill)\b/i, reason: 'stops running processes' },
  // Last, because it is the loosest: any redirect that writes a file. `2>&1`
  // and `>&2` are excluded — they move existing output around rather than
  // creating anything.
  { pattern: /(^|[^0-9&>])>{1,2}\s*[^\s>&|]/, reason: 'writes to a file' },
];

function readCommand(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : '';
}

function readPath(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as { file_path?: unknown; path?: unknown };
  const path = record.file_path ?? record.path;
  return typeof path === 'string' ? path : '';
}

/** The last segment of a path, in either slash convention. */
function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/**
 * Whether a spoken approval needs a second, explicit yes — and what to call the
 * consequence when asking for it.
 *
 * Returns the phrase to speak, or `null` when one answer is enough. Naming the
 * consequence is the point: "are you sure" teaches nothing and gets a reflexive
 * yes, while "that deletes files — yes or no" is a question someone can
 * actually get right while walking down a street.
 */
export function needsConfirmation(
  toolName: string,
  input: unknown,
  remember: boolean,
): string | null {
  // Widening future autonomy is its own consequence, and a bigger one than the
  // single call in front of the user: everything this tool does for the rest of
  // the session stops being asked about.
  if (remember) return `that lets ${toolName} run from now on without asking`;

  if (WRITING_TOOLS.has(toolName)) {
    const name = basename(readPath(input));
    return name ? `that changes ${name}` : 'that changes a file on disk';
  }

  if (toolName === 'Bash') {
    const command = readCommand(input);
    for (const { pattern, reason } of CONSEQUENCE) {
      if (pattern.test(command)) return `that ${reason}`;
    }
  }

  return null;
}

/** How long a spoken summary of a command may run before it is cut short. */
export const MAX_SPOKEN_SUMMARY = 140;

function shorten(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * What to call a tool call out loud when the SDK gave us no title.
 *
 * `context.title` and `context.description` are optional, and the generic
 * "Allow Bash?" that fills in for them on screen is useless in the ear — a
 * spoken prompt that does not say *what* is being approved is a prompt that
 * trains the user to say yes.
 */
export function describeTool(toolName: string, input: unknown): string {
  if (toolName === 'Bash') {
    const command = readCommand(input);
    return command ? `run ${shorten(command, MAX_SPOKEN_SUMMARY)}` : 'run a shell command';
  }
  if (WRITING_TOOLS.has(toolName)) {
    const name = basename(readPath(input));
    return name ? `change ${name}` : 'change a file';
  }
  return `use ${toolName}`;
}

/** The sentence spoken when a permission request arrives. */
export function speakPermission(toolName: string, input: unknown, title?: string): string {
  const what = title?.trim() || describeTool(toolName, input);
  return `${what}. Approve, deny, or explain?`;
}

/** The sentence spoken when an answer was not understood. */
export function speakRetry(): string {
  return 'I did not catch that. Say approve, deny, or explain.';
}

/** The sentence spoken when a consequential answer needs its second yes. */
export function speakConfirmation(reason: string): string {
  return `${reason}. Yes or no?`;
}

/**
 * What to say when asked to explain.
 *
 * Falls back to the tool and its input rather than to an apology: the user
 * asked what this would do, and "no description available" is not an answer
 * they can act on. Ends by asking again, because explaining is not deciding.
 */
export function speakExplanation(
  toolName: string,
  input: unknown,
  description?: string,
): string {
  const detail = description?.trim() || describeTool(toolName, input);
  return `${shorten(detail, 400)}. Approve, or deny?`;
}

/**
 * The spoken form of one question from `AskUserQuestion`.
 *
 * Options are numbered aloud because the number is the answer that cannot be
 * misheard — a label can be a phrase the recogniser mangles, "two" cannot.
 */
export function speakQuestion(question: string, labels: readonly string[]): string {
  const numbered = labels
    .slice(0, ORDINAL_WORDS.length)
    .map((label, index) => `${ORDINAL_WORDS[index]}, ${label}`)
    .join('. ');
  return `${question} ${numbered}. Say the number, or the name.`;
}

/**
 * A plan, shortened to something worth hearing before deciding.
 *
 * Two sentences, not the whole plan: a plan is written to be read, and reading
 * a page of markdown aloud to someone waiting to say "go" is a worse experience
 * than the card they were trying to avoid. The full text stays on screen.
 */
export function speakPlan(plan: string, limit = 320): string {
  const flat = plan.replace(/\s+/g, ' ').trim();
  const opening = flat.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
  return `${shorten(opening || flat, limit)} Approve this plan, or deny it?`;
}

/**
 * Whether a question can be answered by voice at all.
 *
 * Multi-select and multi-question prompts are handed back to the screen. Both
 * are answerable out loud in principle and neither is answerable *reliably*:
 * "the first and third" is a parse this module would get wrong often enough to
 * matter, and getting it wrong means answering a question on the user's behalf.
 * Saying so and leaving the card is the honest outcome.
 */
export function canAnswerByVoice(
  questions: readonly { multiSelect: boolean; options: readonly unknown[] }[],
): boolean {
  return questions.length === 1
    && !questions[0].multiSelect
    && questions[0].options.length > 0;
}
