import type { NormalizedMessage } from '@/shared/types.js';
import { createMessage } from '@/shared/utils.js';

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

/**
 * Announces that the conversation list changed.
 *
 * Lives here rather than in the sessions service because both the service and
 * the chat runtime need it, and routing the runtime through the service to
 * reach it would be an import cycle. The sidebar re-reads on this event; it is
 * what makes a rename, a pin, or a message landing in another window reorder
 * the list without a poll.
 */
export function publishSessionsChanged(sessionId = ''): void {
  appBroadcast.publish(createMessage('sessions_changed', sessionId));
}
