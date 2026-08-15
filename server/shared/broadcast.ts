import type { NormalizedMessage } from '@/shared/types.js';

type Listener = (event: NormalizedMessage) => void;

const listeners = new Set<Listener>();

/**
 * A one-way channel for events that are not part of a chat run.
 *
 * The run registry owns per-session sequencing and replay; this is for
 * app-wide facts — an appearance change, a settings update — that every open
 * window should see immediately and that nothing needs to replay. Keeping them
 * apart means a theme change can never consume a chat sequence number.
 */
export const appBroadcast = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  publish(event: NormalizedMessage): void {
    for (const listener of listeners) listener(event);
  },
};
