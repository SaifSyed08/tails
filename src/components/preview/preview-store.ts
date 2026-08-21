/**
 * What each conversation is previewing, and what it was previewing last.
 *
 * A module-level store rather than React state, because two components need it
 * and they are nowhere near each other: the pane lives beside the chat column
 * and the reopen button lives in the header. Threading it through `App` would
 * mean the shell holding a piece of the preview feature's state and passing it
 * down two unrelated branches.
 *
 * ## Why it is keyed by conversation
 *
 * It was not, and that was a bug rather than a simplification: a Pong game
 * started in one chat appeared beside every other conversation in the app. A
 * preview is the output of a particular piece of work, so it belongs to the
 * conversation that produced it — open another chat and you see that chat's
 * preview, or nothing.
 *
 * ## Why "last" is remembered separately from "current"
 *
 * Closing has to be a real close — the pane goes, the iframe unmounts, the
 * previewed page stops running in the background. But the address is worth
 * keeping: without it the reopen button has nothing to offer and would have to
 * be hidden the moment it became useful, or reopen something stale. So
 * `current` is what is on screen and `last` is what the button offers, and
 * closing moves one to the other — per conversation, so reopening in one chat
 * cannot resurrect another's.
 */

export type PreviewTarget = { url: string; title: string };

type Entry = {
  current: PreviewTarget | null;
  /** The most recent target, kept after a close so it can be reopened. */
  last: PreviewTarget | null;
};

const EMPTY: Entry = { current: null, last: null };

let entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

const publish = (): void => {
  for (const listener of listeners) listener();
};

const read = (sessionId: string | null): Entry =>
  (sessionId ? entries.get(sessionId) : null) ?? EMPTY;

function write(sessionId: string, next: Entry): void {
  // A fresh Map each time, so a consumer comparing identity re-renders. The
  // alternative — mutating in place — is a store that is correct and invisible.
  entries = new Map(entries).set(sessionId, next);
  publish();
}

export function subscribePreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** What this conversation is showing, and what it could reopen. */
export const readPreviewState = (sessionId: string | null): Entry => read(sessionId);

/** Opens, or re-points, this conversation's pane. Called when the tool fires. */
export function openPreview(sessionId: string, target: PreviewTarget): void {
  write(sessionId, { current: target, last: target });
}

/** Closes this conversation's pane but keeps the address, so it can be reopened. */
export function closePreview(sessionId: string | null): void {
  if (!sessionId) return;
  const entry = read(sessionId);
  write(sessionId, { current: null, last: entry.last ?? entry.current });
}

/** The header button. Silent when there is nothing to go back to. */
export function reopenPreview(sessionId: string | null): void {
  if (!sessionId) return;
  const entry = read(sessionId);
  if (!entry.last) return;
  write(sessionId, { current: entry.last, last: entry.last });
}
