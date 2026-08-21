/**
 * The messages you have sent, walkable with the arrow keys.
 *
 * ## Why this is not the transcript
 *
 * The transcript is what a conversation *contains*; this is what you have typed.
 * They diverge in the ways that matter for recall: a message sent in one chat is
 * worth reusing in another, a draft abandoned mid-turn never reaches a transcript
 * at all, and the transcript of a long conversation is mostly the assistant's
 * words, which are never what you want back.
 *
 * So it is its own list — per machine, not per conversation — and it behaves like
 * a shell's history, because that is the thing everyone already knows how to
 * use.
 *
 * ## The rules that make it feel right
 *
 * **Up from a draft keeps the draft.** Walking back and then forward again has to
 * return you to what you were writing, or the feature costs you a sentence the
 * first time you press it by accident. The draft is held at index -1.
 *
 * **A repeat does not double up.** Sending the same thing twice — which happens
 * constantly with "go on" or "try again" — should not mean pressing up twice to
 * get past it.
 *
 * **Editing cancels the walk.** Once a recalled line has been changed it is a
 * draft, not a history entry, so the next Up starts again from the end rather
 * than from wherever the cursor happened to be.
 */

const KEY = 'tails.inputHistory';

/** Entries kept. Enough for a session's worth of recall, bounded on purpose. */
const MAX = 100;

/** The longest entry worth remembering. A pasted file is not a command. */
const MAX_LENGTH = 4000;

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

let entries: string[] = load();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // A blocked store costs recall across restarts, not the feature.
  }
}

/** Oldest first, so the last entry is the most recent. */
export const readHistory = (): string[] => entries;

/**
 * Records a sent message.
 *
 * Skips a repeat of the most recent entry rather than de-duplicating the whole
 * list: "try again" three times in a row should collapse, but the same question
 * asked again an hour later is a genuinely separate thing to walk back to.
 */
export function rememberInput(text: string): void {
  const value = text.trim();
  if (!value || value.length > MAX_LENGTH) return;
  if (entries[entries.length - 1] === value) return;

  entries = [...entries, value].slice(-MAX);
  persist();
}

export type Walk = {
  /** Where in history we are. -1 is the live draft. */
  index: number;
  /** What the user was writing before they started walking. */
  draft: string;
};

export const atDraft = (draft: string): Walk => ({ index: -1, draft });

/**
 * One step towards older entries, or null at the end of the list.
 *
 * Null rather than clamping, so the caller can leave the keystroke alone and let
 * the cursor move — a held Up key at the top of the list should not feel like
 * the field is stuck.
 */
export function older(walk: Walk, current: string): { walk: Walk; text: string } | null {
  const list = entries;
  if (list.length === 0) return null;

  // Starting the walk: remember what is being abandoned so Down can restore it.
  const from = walk.index < 0 ? { index: list.length, draft: current } : walk;
  const next = from.index - 1;
  if (next < 0) return null;

  return { walk: { index: next, draft: from.draft }, text: list[next] };
}

/** One step towards newer entries, ending at the draft that was interrupted. */
export function newer(walk: Walk): { walk: Walk; text: string } | null {
  if (walk.index < 0) return null;

  const next = walk.index + 1;
  if (next >= entries.length) {
    return { walk: { index: -1, draft: walk.draft }, text: walk.draft };
  }
  return { walk: { index: next, draft: walk.draft }, text: entries[next] };
}
