/**
 * "Open that conversation", asked from outside the app's own furniture.
 *
 * The desktop pet's notification bubble is a button in a *different window*.
 * Clicking it has to end with the app showing that chat — but choosing a chat
 * belongs to the sidebar, which owns the session list and the selection, and
 * the shell has no way to reach into it.
 *
 * So: the pet's side publishes an intent, and the sidebar acts on it through
 * exactly the same path a click on a row takes. Nothing here knows what opening
 * a chat involves, which is the point — the alternative was reaching across
 * modules for a setter, or synthesising a click on a row in the DOM.
 *
 * A plain module-level set rather than context: the two ends are in different
 * subtrees, one of them is a hook inside another component, and a context would
 * have to be mounted above both by the app shell.
 */

type Listener = (sessionId: string) => void;

const listeners = new Set<Listener>();

/** Ask for a conversation to be shown. Silently does nothing if nobody is listening. */
export function requestSession(sessionId: string): void {
  if (!sessionId) return;
  for (const listener of [...listeners]) listener(sessionId);
}

export function onSessionRequested(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
