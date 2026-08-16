/**
 * The deterministic second pass over a transcript.
 *
 * ## Why this is not a language model
 *
 * The obvious way to make dictation read like writing is a second LLM pass —
 * it is what the product this feature was modelled on does. Locally that costs
 * several hundred megabytes and one to three seconds *after* transcription has
 * already finished, which is where dictation starts losing to the keyboard. And
 * a small model rewriting your sentence fails unpredictably: when it quietly
 * changes a word you did say, you have to proofread every dictation, and the
 * feature has cost more than it saved.
 *
 * So this pass is rules. It is worse at open-ended rewriting and better at
 * being trusted: every transformation here is one a person can learn, predict,
 * and rely on. Saying "scratch that" always deletes the last clause.
 *
 * Whisper already does the other half for free — it drops "um" and "uh" on its
 * own, an artifact of being trained on normalised captions — so what is left is
 * the narrow set below.
 */

/**
 * Mis-hearings of project vocabulary, mapped back.
 *
 * Benchmarking against this codebase's own vocabulary found the residual errors
 * were not spread out: with the decoder seeded, two words accounted for most of
 * them. `sqlite` failed in every single condition — the model reliably hears
 * "Sleight", "Sclyte" or "splite" — and `execPath` degraded to "execpack" and
 * similar. Seeding the decoder does not fix these; they are close enough
 * acoustically that the language prior does not rescue them.
 *
 * Kept deliberately small and specific. A broad fuzzy-match against every
 * identifier in the repo would start correcting words the user actually said,
 * which is the failure this whole module exists to avoid.
 */
const MISHEARINGS: ReadonlyArray<readonly [RegExp, string]> = [
  // The package name has to be matched before the bare word, or the general
  // rule rewrites the middle of it and leaves the hyphenation broken.
  [/\bbetter[\s-]+(?:s(?:c?l|kl)(?:y|i|ei)te|sleight|splite)\s*(?:3|three)\b/gi, 'better-sqlite3'],
  [/\b(?:s(?:c?l|kl)(?:y|i|ei)te|sleight|splite)\b/gi, 'sqlite'],
  [/\bexec\s*(?:pack|pak|path)\b/gi, 'execPath'],
  [/\bnode\s+pty\b/gi, 'node-pty'],
  [/\btype\s+check\b/gi, 'typecheck'],
  [/\bweb\s+socket\b/gi, 'websocket'],
];

/**
 * Phrases that retract what was just said.
 *
 * Ordered longest-first so "actually no" is matched before "no" would be, and
 * kept to markers that are unambiguous retractions — "I mean" qualifies,
 * "actually" alone does not, because people say it without retracting anything.
 */
const RETRACTIONS = [
  'scratch that',
  'actually no',
  'no wait',
  'wait no',
  'i mean',
  'sorry',
];

/** Fillers Whisper sometimes keeps, usually when they carry stress. */
const FILLERS = /\b(?:u+m+|u+h+|er+|erm+|hmm+)\b[,.]?\s*/gi;

/**
 * Splits on clause boundaries, keeping the separators.
 *
 * A retraction deletes back to the previous boundary rather than to the start
 * of the sentence, because "open the file, no wait, the other one" should lose
 * one clause and not the instruction.
 */
function clauses(text: string): string[] {
  return text.split(/(?<=[,;])\s+/);
}

/** Collapses an immediately repeated word: "the the file" → "the file". */
function collapseRepeats(text: string): string {
  return text.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
}

/**
 * Applies retraction markers by dropping what they retract.
 *
 * The rule is one sentence, which is the point — a person can learn it and
 * predict it: **a retraction deletes back to the start of the clause it sits
 * in, and if it sits at the very start of its clause, it deletes the clause
 * before it instead.** Whatever follows the marker is what the speaker settled
 * on and always survives.
 *
 * That second half is what makes "open that one, I mean the other one" work.
 * Without it the marker only ever cleared text inside its own clause, so the
 * thing being retracted — sitting in the previous clause — was kept, and the
 * output contradicted itself.
 */
function applyRetractions(text: string): string {
  const parts = clauses(text);
  const kept: string[] = [];

  for (const part of parts) {
    const lower = part.toLowerCase();
    const hit = RETRACTIONS
      .map((marker) => ({ marker, at: lower.indexOf(marker) }))
      .filter((entry) => entry.at >= 0)
      .sort((a, b) => a.at - b.at)[0];

    if (!hit) {
      kept.push(part);
      continue;
    }

    const before = part.slice(0, hit.at).replace(/[\s,.:;-]+$/, '');
    const after = part.slice(hit.at + hit.marker.length).replace(/^[\s,.:;-]+/, '');

    if (!before) kept.pop();
    if (after) kept.push(after);
  }

  return kept.join(' ');
}

/** Restores the sentence case that dropping a leading clause can destroy. */
function recase(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_, lead: string, ch: string) => lead + ch.toUpperCase());
}

/**
 * Cleans one transcript.
 *
 * Order matters: mis-hearings are repaired before retractions, so a retraction
 * marker is never hidden inside a mangled word, and repeats are collapsed last
 * so that joining clauses cannot leave a duplicate at the seam.
 */
export function cleanTranscript(raw: string): string {
  if (!raw.trim()) return '';

  let text = raw.trim().replace(/\s+/g, ' ');

  for (const [pattern, replacement] of MISHEARINGS) {
    text = text.replace(pattern, replacement);
  }

  text = text.replace(FILLERS, '');
  text = applyRetractions(text);
  text = collapseRepeats(text);
  text = text.replace(/\s+([,.;:!?])/g, '$1').replace(/\s+/g, ' ').trim();

  return recase(text);
}
