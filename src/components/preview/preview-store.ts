/**
 * What the preview pane is showing, and what it was showing last.
 *
 * A module-level store rather than React state, because two components need it
 * and they are nowhere near each other: the pane lives beside the chat column
 * and the reopen button lives in the header. Threading it through `App` would
 * mean the shell holding a piece of the preview feature's state and passing it
 * down two unrelated branches.
 *
 * ## Why "last" is remembered separately from "current"
 *
 * Closing the pane has to be a real close — the pane disappears, the iframe
 * unmounts, the previewed app stops running in the background. But the address
 * is the one thing worth keeping: without it the reopen button has nothing to
 * reopen and would have to be hidden the moment it became useful, or reopen
 * something stale and wrong. So `current` is what is on screen and `last` is
 * what the button offers, and closing moves one to the other.
 */

export type PreviewTarget = { url: string; title: string };

type State = {
  current: PreviewTarget | null;
  /** The most recent target, kept after a close so it can be reopened. */
  last: PreviewTarget | null;
};

let state: State = { current: null, last: null };
const listeners = new Set<(state: State) => void>();

const publish = (): void => {
  for (const listener of listeners) listener(state);
};

export function subscribePreview(listener: (state: State) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => { listeners.delete(listener); };
}

export const readPreviewState = (): State => state;

/** Opens, or re-points, the pane. Called when the agent's tool fires. */
export function openPreview(target: PreviewTarget): void {
  state = { current: target, last: target };
  publish();
}

/** Closes the pane but keeps the address, so it can be reopened. */
export function closePreview(): void {
  state = { current: null, last: state.last ?? state.current };
  publish();
}

/** The header button. Silent when there is nothing to go back to. */
export function reopenPreview(): void {
  if (!state.last) return;
  state = { current: state.last, last: state.last };
  publish();
}
