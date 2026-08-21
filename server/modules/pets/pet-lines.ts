import { askHaiku } from '@/modules/pets/haiku.js';

/**
 * A pet's own lines, written once by a cheap model and used for free after that.
 *
 * ## Why a bank instead of a live call
 *
 * The first instinct is to ask a small model for a reaction each time, and it
 * gives lovely results — measured, in character, exactly the register asked for:
 * "Whoa, now that's what I call speed!". It also took **twelve seconds**, almost
 * all of it spawning the CLI. A bubble that appears twelve seconds after the
 * reply it is reacting to has stopped being a reaction.
 *
 * So the model writes a *bank* — one call per pet, cached — and picking from it
 * afterwards is instant and free. What that trades away is reference to the
 * specific request: the pet cannot say "nice retry loop", only "neat idea!".
 * That is the right trade for this feature. A companion is judged on personality
 * and timing, not on comprehension; a spectator who reacts a beat late and
 * quotes your variable names is stranger than one who is simply enthusiastic.
 *
 * ## Volume belongs to the character
 *
 * The thing that makes this work is that the *same* generator produces a
 * shouting hedgehog, a duck that mostly quacks, and a bombastic caricature —
 * because it is told to take its energy from the character rather than from a
 * house style. That was the specific complaint: everything sounded equally loud.
 */

/**
 * The situations worth having lines for.
 *
 * Small on purpose. Each one has to be distinguishable from the others by a
 * cheap look at the turn — a category the app cannot detect is a category that
 * never gets used — and every extra one dilutes the model's attention across a
 * single generation call.
 */
export const LINE_KINDS = ['approve', 'done', 'explain', 'problem', 'idle'] as const;

export type LineKind = (typeof LINE_KINDS)[number];

export type LineBank = Record<LineKind, string[]>;

/** Lines per situation. Enough that a repeat is rare in a working session. */
const PER_KIND = 5;

/** The longest line that fits the bubble without becoming a dialog box. */
export const MAX_LINE = 70;

/**
 * Anything the bubble's font cannot draw.
 *
 * The bubble is set in a pixel typeface with a monospace fallback, and neither
 * has glyphs beyond Latin — so a line in another script renders as a row of
 * empty boxes. Not hypothetical: asked for duck noises, the generator offered
 * 咕嘎, which is a good answer to the question and unreadable on screen.
 *
 * The prompt asks for plain English too. This is the half that is guaranteed.
 * Accented Latin survives, because "café" is fine and dropping it would be
 * fixing a different problem. The range starts at a space rather than at NUL
 * for the same reason a control character has no business in a speech bubble.
 */
const UNDRAWABLE = /[^ -ɏ‐-›]/;

export const emptyBank = (): LineBank => ({
  approve: [], done: [], explain: [], problem: [], idle: [],
});

const BRIEF: Record<LineKind, string> = {
  approve: 'the user has just asked for something — a change, a fix, an idea. React to the *request*, keen and encouraging.',
  done: 'the assistant has just finished doing something successfully. React like a spectator who saw it happen.',
  explain: 'the assistant has just explained something. React to having been told a thing.',
  problem: 'something went wrong — an error, a failure, a dead end. React without being discouraging.',
  idle: 'nothing is happening. The user is reading or thinking. Mutter something to yourself — a stray thought, a bit of advice from your own strange life, impatience, boredom, or almost falling asleep.',
};

/**
 * What the generator is told.
 *
 * The constraints that matter, in the order they matter: who you are, that you
 * are *not* the assistant, first person, short, and take your volume from the
 * character. The last one is the point of the whole prompt — without it every
 * pet comes back sounding like the same eager sidekick.
 */
export function buildPrompt(pet: { name: string; description: string; persona: string }): string {
  return [
    `You are writing dialogue for a small on-screen pet called ${pet.name}.`,
    pet.description ? `Appearance and nature: ${pet.description}` : '',
    pet.persona ? `How the user describes them: ${pet.persona}` : '',
    '',
    `The pet sits at the corner of a chat window and watches the user work with an AI assistant. The pet is a SPECTATOR — it is not the assistant, it never answers the user's questions, it just reacts.`,
    '',
    'Write lines it can say. Rules:',
    '- First person, as the pet. Never refer to the pet by name.',
    /*
      Two numbers on purpose. The target is what shapes the writing; the cap is
      what the parser enforces. Given only the cap, the generator writes to it —
      thirty-eight characters of warm chat where four words would land better.
    */
    '- BRUTALLY short. Three to six words. A single sound or word is often best.',
    `- Never longer than ${MAX_LINE} characters.`,
    '- Funny, entertaining, and unmistakably this character.',
    /*
      The two rules that variance made visible.

      The generator is high-variance: the same prompt gave a famously fast
      hedgehog "Finally" and "About time" on one run — generic impatience, the
      character's mood with none of the character in it — and something much
      better on the next. These two narrow that spread by naming what the good
      runs were doing anyway.
    */
    '- Reach for what the character is FAMOUS for: their catchphrases, the noise they make, the thing they cannot stop talking about. Put the task in their own terms — a fast character measures work in laps, a boastful one in how nobody does it better.',
    '- Match their VOLUME and ENERGY. An excitable character is genuinely thrilled and uses exclamation marks; a brash one boasts; a mostly-wordless animal mostly just makes its own sound and says very little. Do not level everyone out to the same polite enthusiasm.',
    '- No markdown, no quotes around the line, no emoji, no stage directions.',
    // Measured: a duck called Guga came back saying 咕嘎 — a perfectly good
    // Chinese rendering of a quack, and a row of empty boxes in a pixel font.
    '- English, and plain keyboard characters only. No other scripts.',
    '- Never mention the assistant, the tool, the app, or that you are a pet.',
    '',
    /*
      Invented characters, so nothing is copied verbatim — and picked to show the
      range rather than a house style: one shouts, one barely speaks, one turns
      everything into its own obsession.
    */
    'For register, here is the range wanted — for characters that are not yours:',
    '  a boastful old general -> "Nobody plans better. Nobody!"',
    '  a very sleepy cat -> "mrrrp..."',
    '  a hyperactive squirrel -> "I could do that twice before lunch!"',
    '  a shy moth -> "oh. ok."',
    '',
    'Produce exactly these groups, in this order, each as a JSON array of '
      + `${PER_KIND} strings:`,
    ...LINE_KINDS.map((kind) => `"${kind}": ${BRIEF[kind]}`),
    '',
    'Reply with ONLY a JSON object with those five keys and nothing else.',
  ].filter((line) => line !== undefined).join('\n');
}

/**
 * Reads whatever the model sent back into a bank.
 *
 * Tolerant by design: a small model asked for JSON usually sends JSON, sometimes
 * sends JSON in a fence, and occasionally sends four of the five keys. Any line
 * that is a usable string is kept, and a missing group is simply empty — a
 * partial bank is a working pet, and rejecting the lot over one absent key would
 * throw away a call that cost a second and a half.
 */
export function parseBank(raw: string): LineBank {
  const bank = emptyBank();

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return bank;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return bank;
  }
  if (!parsed || typeof parsed !== 'object') return bank;

  const record = parsed as Record<string, unknown>;
  for (const kind of LINE_KINDS) {
    const value = record[kind];
    if (!Array.isArray(value)) continue;

    bank[kind] = value
      .filter((line): line is string => typeof line === 'string')
      .map((line) => line.trim().replace(/\s+/g, ' ').replace(/^["'“”]+|["'“”]+$/g, ''))
      .filter((line) => line.length > 0 && line.length <= MAX_LINE && !UNDRAWABLE.test(line))
      .slice(0, PER_KIND);
  }

  return bank;
}

/**
 * Anything into a full bank.
 *
 * One reader for three sources — the generator's JSON, a row from the database,
 * and a hand-edited payload from the panel — because they can all be wrong in
 * the same ways, and a bank with a missing group is an index that returns
 * `undefined` somewhere far from here. Unknown keys are dropped and new ones
 * arrive empty, so a bank written by an older build stays usable.
 */
export function readBank(value: unknown): LineBank {
  const bank = emptyBank();
  if (!value || typeof value !== 'object') return bank;

  const record = value as Record<string, unknown>;
  for (const kind of LINE_KINDS) {
    const lines = record[kind];
    if (!Array.isArray(lines)) continue;

    bank[kind] = lines
      .filter((line): line is string => typeof line === 'string')
      .map((line) => line.trim().replace(/\s+/g, ' '))
      .filter((line) => line.length > 0 && line.length <= MAX_LINE && !UNDRAWABLE.test(line))
      .slice(0, PER_KIND);
  }
  return bank;
}

export const bankIsEmpty = (bank: LineBank): boolean =>
  LINE_KINDS.every((kind) => bank[kind].length === 0);

/**
 * Writes a pet its lines.
 *
 * One call. Returns null when the model could not be reached or sent nothing
 * usable, which the caller treats as "this pet has no lines yet" — the same
 * state as a pet nobody has generated lines for.
 */
export async function generateBank(
  pet: { name: string; description: string; persona: string },
): Promise<LineBank | null> {
  const raw = await askHaiku({
    system: 'You write short character dialogue. You reply with JSON and nothing else.',
    prompt: buildPrompt(pet),
    // Structured, so the single-line cleaner must not run — see `clean` in
    // `haiku.ts` for what it did to the first attempt.
    clean: false,
    // Twenty-five lines of JSON, not one sentence. The default was tuned for the
    // latter and aborted every bank it was ever asked for.
    timeoutMs: 90_000,
  });
  if (!raw) return null;

  const bank = parseBank(raw);
  return bankIsEmpty(bank) ? null : bank;
}

/**
 * Which kind of line suits what just happened.
 *
 * A deliberately cheap read of the turn. The alternative — asking a model which
 * category applies — is a second call to classify something for a decoration,
 * and the categories were chosen to be separable this way in the first place.
 *
 * Order matters: a turn can be several of these at once, and the most specific
 * true thing is the most interesting one to react to.
 */
export function pickKind(userMessage: string, reply: string): LineKind {
  const said = reply.toLowerCase();
  if (/\b(error|failed|failure|cannot|could not|couldn't|no such|denied|broken)\b/.test(said)) {
    return 'problem';
  }

  const asked = userMessage.toLowerCase().trim();
  // An imperative or a request: "add", "fix", "can you", "please". This is the
  // "neat idea!" case, and it reads off the *user's* words rather than the
  // reply, because it is a reaction to being asked.
  if (/^(add|fix|make|change|build|write|create|remove|delete|update|refactor|rename|move|try|run|use|set|implement|can you|could you|please|let'?s)\b/.test(asked)) {
    return 'approve';
  }

  if (/\b(done|added|created|fixed|updated|removed|committed|passing|works|working)\b/.test(said)) {
    return 'done';
  }

  return 'explain';
}
