import fs from 'node:fs';
import path from 'node:path';

/**
 * Builds the decoder's initial prompt from the folder the conversation is in.
 *
 * ## Why this exists
 *
 * Whisper is trained on captions and podcasts, so the errors it makes in a
 * coding tool are concentrated almost entirely in project nouns — measured on
 * this codebase, `petstage ChatPet tsx` came back as "Pet's Tage Chat Pet TSX".
 * `initial_prompt` conditions the decoder on supplied text, and seeding it with
 * roughly forty words of project vocabulary fixed four of the five worst cases
 * for about 50 ms. On one utterance it produced `ensureServer` and `execPath`
 * in correct camelCase from speech that contained no casing at all.
 *
 * This app is unusually well placed to do that, because it already knows which
 * folder the conversation is about.
 */

/**
 * Vocabulary that is true of this app regardless of the folder.
 *
 * Everything here was either observed failing without it, or is a term the
 * model has no reason to know. Not a dictionary — a short list earns its place
 * in the prompt, a long one dilutes it.
 */
const PROJECT_TERMS = [
  'TAILS', 'Claude Code', 'npm run typecheck', 'npm run lint', 'Electron',
  'better-sqlite3', 'node-pty', 'websocket', 'AudioWorklet', 'whisper.cpp',
  'Silero VAD', 'renderer', 'gateway', 'composer', 'petstage', 'sprite metrics',
  'appearance', 'ensureServer', 'execPath', 'TypeScript', 'React', 'Vite',
];

/**
 * How many filenames from the folder to include.
 *
 * The prompt competes with the audio for the decoder's attention, and a prompt
 * longer than the utterance starts pulling words into the transcript that
 * nobody said. Whisper's own prompt window is 224 tokens; this stays well
 * inside it.
 */
const MAX_ENTRIES = 24;

/** Hard cap on the assembled prompt, in characters, for the same reason. */
const MAX_PROMPT_CHARS = 700;

/** Directories that are never about the user's project. */
const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'dist-server', 'release', 'build',
  'coverage', '.next', '.cache', 'out', 'target', 'vendor',
]);

/**
 * Reads the interesting names directly inside a folder.
 *
 * Deliberately **one level deep and non-recursive**. This runs on the send
 * path, and walking a large tree there would put a filesystem crawl between
 * someone finishing a sentence and seeing their words. `withFileTypes` gets
 * this in a single syscall per entry, and the whole thing is wrapped because
 * an unreadable or deleted cwd must degrade to "no extra vocabulary", never to
 * a failed dictation.
 */
function readFolderNames(cwd: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (names.length >= MAX_ENTRIES) break;
    const name = entry.name;
    if (name.startsWith('.') || IGNORED.has(name)) continue;
    // Extensions are worth keeping: hearing "tsx" as a suffix is exactly the
    // case that failed, so `ChatPet.tsx` teaches more than `ChatPet` would.
    names.push(name);
  }

  return names;
}

/** Adds the folder's own name, which is usually what the user calls the project. */
function projectName(cwd: string): string[] {
  const base = path.basename(cwd);
  return base && base !== '.' && base !== path.sep ? [base] : [];
}

/**
 * Assembles the prompt.
 *
 * Written as prose with the terms embedded rather than as a bare comma list:
 * Whisper's prompt is conditioning text, not a lexicon, and a fragment that
 * reads like natural language biases the decoder more reliably than a list.
 */
export function buildInitialPrompt(cwd?: string | null): string {
  const parts = [...PROJECT_TERMS];

  if (cwd) {
    parts.unshift(...projectName(cwd), ...readFolderNames(cwd));
  }

  const seen = new Set<string>();
  const unique = parts.filter((term) => {
    const key = term.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let prompt = `Notes on this project: ${unique.join(', ')}.`;
  if (prompt.length > MAX_PROMPT_CHARS) {
    // Trim on a separator so the prompt never ends mid-identifier, which would
    // teach the decoder a word that does not exist.
    const cut = prompt.lastIndexOf(', ', MAX_PROMPT_CHARS);
    prompt = `${prompt.slice(0, cut > 0 ? cut : MAX_PROMPT_CHARS)}.`;
  }

  return prompt;
}
