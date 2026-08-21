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
 * The one thing worth having written in advance.
 *
 * There were five groups — approval, done, explained, problem, idle — and four of
 * them were wrong in the same way: a canned line pretending to be a reaction.
 * "Neat idea!" out of a bank is not a companion noticing what you asked for, it
 * is a fortune cookie, and it reads as one the second time it appears.
 *
 * Reactions are generated live now, from the actual exchange. What cannot be
 * generated live is muttering: there is nothing to react to, so a model call
 * would be spending on inventing a mood. Those are exactly the lines that are
 * *better* prebuilt — written once in the character's voice, cycled at random —
 * and it leaves one group instead of five, which is a fifth of the generation
 * cost per pet.
 */
export const LINE_KINDS = ['idle'] as const;

export type LineKind = (typeof LINE_KINDS)[number];

export type LineBank = Record<LineKind, string[]>;

/** Idle lines per pet. More than before, since it is the only group now. */
const PER_KIND = 10;

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

export const emptyBank = (): LineBank => ({ idle: [] });

export function buildPrompt(pet: { name: string; description: string; persona: string }): string {
  return [
    `You are writing dialogue for a small on-screen pet called ${pet.name}.`,
    pet.description ? `Appearance and nature: ${pet.description}` : '',
    pet.persona ? `How the user describes them: ${pet.persona}` : '',
    '',
    'The pet sits in the corner of a chat window while its owner works. Write the things it says to ITSELF when nothing is happening — the owner is reading or thinking and there is nothing to react to.',
    '',
    `Write ${PER_KIND} such lines. Rules:`,
    '- First person, as the pet. Never refer to the pet by name.',
    '- BRUTALLY short. Three to six words. A single sound or word is often best.',
    `- Never longer than ${MAX_LINE} characters.`,
    '- Funny, entertaining, and unmistakably this character.',
    /*
      The two rules that variance made visible.

      The generator is high-variance: the same prompt gave a famously fast
      hedgehog "Finally" and "About time" on one run — generic impatience, the
      character's mood with none of the character in it — and something much
      better on the next. These narrow the spread by naming what the good runs
      were doing anyway.
    */
    '- Reach for what the character is FAMOUS for: their catchphrases, the noise they make, the thing they cannot stop talking about.',
    '- Match their VOLUME and ENERGY. An excitable character is thrilled about nothing in particular; a brash one boasts to an empty room; a mostly-wordless animal just makes its own sound. Do not level everyone out to the same polite patience.',
    '',
    'Spread them across these moods: boredom, impatience, nearly falling asleep, a stray thought, a scrap of advice from their own strange life, a small boast, and being ready to go.',
    '',
    '- No markdown, no quotes around the line, no emoji, no stage directions.',
    // Measured: a duck called Guga came back saying 咕嘎 — a perfectly good
    // Chinese rendering of a quack, and a row of empty boxes in a pixel font.
    '- English, and plain keyboard characters only. No other scripts.',
    '- Never mention the owner, the chat, the assistant, or that you are a pet.',
    '',
    'For register, here is the range wanted — for characters that are not yours:',
    '  a boastful old general -> "Nobody waits better. Nobody!"',
    '  a very sleepy cat -> "mrrrp..."',
    '  a hyperactive squirrel -> "I could nap twice by now!"',
    '  a shy moth -> "oh. still here."',
    '',
    'Reply with ONLY a JSON object of the form {"idle": ["...", "..."]} and nothing else.',
  ].filter(Boolean).join('\n');
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
 * Whether a chatty pet speaks on this turn.
 *
 * Two gates answering different questions. The cooldown (in `pet-voice.tools.ts`)
 * stops a pet commenting on every message in a fast exchange; these odds are what
 * make it "occasionally" rather than "always" once it is allowed to. Seventy
 * percent was asked for and is about right: often enough to read as a companion
 * paying attention, rare enough that the bubble stays a small event — and, now
 * that a reaction is a model call, it is also the thing keeping the cost down.
 */
export const REMARK_ODDS = 0.7;

export const remarkDue = (roll: number): boolean => roll < REMARK_ODDS;
