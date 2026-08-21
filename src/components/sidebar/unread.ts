import { useEffect, useRef, useState } from 'react';

import { useWebSocket } from '@/contexts/WebSocketContext';

/**
 * Conversations that finished while you were looking at something else.
 *
 * ## Why this is a module and not a piece of component state
 *
 * Two components care and neither contains the other: the sidebar draws the
 * dot, and the thing that knows a turn has finished is a websocket subscription
 * that has to keep running whichever view is on screen. Lifting the set into the
 * app's own state would mean threading a setter through every layer between
 * them, and re-rendering the whole tree each time a background chat produced a
 * token.
 *
 * So it is a small store with subscribers, and the two halves — `useUnreadWatch`
 * to fill it, `useUnread` to read it — meet here rather than in a component.
 *
 * ## Why it persists
 *
 * The dot's whole job is to survive not being looked at. A reload with three
 * unread conversations that comes back showing none has thrown away the only
 * thing it was keeping.
 */

const KEY = 'tails.unreadSessions';

/** A cap, so a long-running app cannot grow this without bound. */
const MAX_TRACKED = 200;

let unread: Set<string> = load();
const listeners = new Set<() => void>();

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...unread].slice(-MAX_TRACKED)));
  } catch {
    // A blocked store costs the dots across a reload, not the feature.
  }
}

function announce(): void {
  persist();
  for (const listener of listeners) listener();
}

export function markUnread(sessionId: string): void {
  if (!sessionId || unread.has(sessionId)) return;
  unread = new Set(unread).add(sessionId);
  announce();
}

export function markRead(sessionId: string | null): void {
  if (!sessionId || !unread.has(sessionId)) return;
  const next = new Set(unread);
  next.delete(sessionId);
  unread = next;
  announce();
}

export function isUnread(sessionId: string): boolean {
  return unread.has(sessionId);
}

/**
 * Subscribes a component to the set.
 *
 * Returns the set itself rather than a boolean per row, because the sidebar
 * renders a list: one subscription for the list beats one per row, and a new
 * `Set` identity on every change is what makes the re-render happen at all.
 */
export function useUnread(): Set<string> {
  const [snapshot, setSnapshot] = useState(unread);

  useEffect(() => {
    const listener = () => setSnapshot(unread);
    listeners.add(listener);
    // Re-read on subscribe: the store may have changed between this component
    // rendering and its effect running.
    listener();
    return () => { listeners.delete(listener); };
  }, []);

  return snapshot;
}

/**
 * Watches for turns finishing somewhere the user is not looking.
 *
 * Mounted once, high up. The test is *active view*, not window focus, which is
 * what was asked for and is also the more useful of the two: a reply that
 * finished in the chat you are reading is not news, and one that finished in
 * another chat is, whether or not the app happened to be in front.
 *
 * The conversation on screen is read through a ref rather than captured, because
 * a turn can finish minutes after this subscription was set up and the answer
 * has to be "where are you now", not "where were you then".
 */
function useUnreadWatch(sessionId: string | null): void {
  const { subscribe } = useWebSocket();

  const viewing = useRef(sessionId);
  useEffect(() => {
    viewing.current = sessionId;
    // Opening a conversation is reading it. Done here rather than in a click
    // handler so every route to a chat clears it — the sidebar, a pet's
    // notification bubble, a new chat, a deep link.
    markRead(sessionId);
  });

  useEffect(() => subscribe((message) => {
    if (message.kind !== 'complete' || !message.sessionId) return;
    if (message.sessionId === viewing.current) return;
    markUnread(message.sessionId);
  }), [subscribe]);
}

/**
 * Mounts the watcher inside the websocket provider.
 *
 * A component rather than a hook called from `App`, and that distinction was a
 * runtime error before it was a design: `App` renders the provider, so it is
 * *outside* it, and a hook there throws "useWebSocket must be used inside a
 * WebSocketProvider" — which takes the whole render down and leaves a chat that
 * spins with nothing in it.
 *
 * Renders nothing. It exists to be somewhere in the tree that a subscription can
 * legally live, and to keep that subscription out of any component whose
 * lifetime is shorter than the app's.
 */
export function UnreadWatcher({ sessionId }: { sessionId: string | null }): null {
  useUnreadWatch(sessionId);
  return null;
}
