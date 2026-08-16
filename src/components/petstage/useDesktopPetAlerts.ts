import { useEffect, useRef } from 'react';

import { useWebSocket } from '@/contexts/WebSocketContext';

import { readSessionSummary } from './chat-pet-api';
import { requestSession } from './session-requests';

/**
 * The desktop pet telling you a conversation has finished.
 *
 * ## Why the decision is split across three places
 *
 * Three facts have to be true at once, and no single process knows all three:
 *
 * - **A turn finished.** The server knows, and already broadcasts it. This
 *   renderer hears it over the websocket, which keeps running while the window
 *   is minimised — so nothing new has to be published for this feature.
 * - **The chat that finished has the desktop pet in it.** Only the app can
 *   answer that: it means comparing the session's `petId` against the pet the
 *   desktop window is showing, which is the active one.
 * - **The user is not looking at the app.** Only the *shell* can answer that,
 *   so it is not answered here. This reports what it knows and the shell drops
 *   it on the floor when the window is in front of the user.
 *
 * The alternative — routing this through the pet page's own poll — would have
 * made both edges wrong: up to 2.5 seconds late to appear, and still up for
 * 2.5 seconds after the chat had been read. The shell pushes instead.
 *
 * ## Clearing
 *
 * On viewing the chat, not on focusing the window: those are different things
 * and he asked for the first. The window coming forward is reported too, but
 * only because that is when the chat on screen starts counting as read.
 */

type Options = {
  /** The conversation on screen, or null when the app is showing something else. */
  sessionId: string | null;
  /** The pet the desktop window is showing, which is always the active one. */
  activePetId: string | null;
};

type AlertBridge = {
  completed?: (sessionId: string, title: string) => void;
  viewing?: (sessionId: string) => void;
};

const bridge = (): AlertBridge | null => (
  (window as unknown as { tailsDesktop?: { desktopPet?: AlertBridge } }).tailsDesktop?.desktopPet
  ?? null
);

const onOpenSession = (handler: (sessionId: string) => void): void => {
  (window as unknown as {
    tailsDesktop?: { onOpenSession?: (handler: (sessionId: string) => void) => void };
  }).tailsDesktop?.onOpenSession?.(handler);
};

export function useDesktopPetAlerts({ sessionId, activePetId }: Options): void {
  const { subscribe } = useWebSocket();

  // Read at delivery time rather than captured: a turn can finish minutes after
  // this effect was set up, by which time the active pet may be someone else.
  const activeRef = useRef(activePetId);
  const viewingRef = useRef(sessionId);
  useEffect(() => {
    activeRef.current = activePetId;
    viewingRef.current = sessionId;
  });

  useEffect(() => subscribe((message) => {
    if (message.kind !== 'complete' || !message.sessionId) return;

    const finished = message.sessionId;
    const active = activeRef.current;
    // No pet on the desktop means nobody to do the telling. Checked before the
    // request so an ordinary turn in an ordinary chat costs nothing.
    if (!active) return;

    void readSessionSummary(finished)
      .then((session) => {
        // His chat, or somebody else's. A pet only speaks for the conversation
        // he lives in — that is the whole of what makes this his to say.
        if (session.petId !== active) return;
        bridge()?.completed?.(finished, session.title);
      })
      .catch(() => {
        // A conversation that cannot be read is one we cannot name, and an
        // unnamed bubble is worse than none.
      });
  }), [subscribe]);

  // What is on screen, whenever that changes and whenever the window comes
  // forward — the shell ignores it unless the window is genuinely in front.
  useEffect(() => {
    if (!sessionId) return undefined;

    const report = () => bridge()?.viewing?.(sessionId);
    report();
    window.addEventListener('focus', report);
    return () => window.removeEventListener('focus', report);
  }, [sessionId]);

  // The bubble was clicked. The shell has already raised the window; the
  // sidebar picks the conversation up from here.
  useEffect(() => {
    onOpenSession((requested) => requestSession(requested));
  }, []);
}
