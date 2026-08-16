import { useEffect, useRef, useState } from 'react';

import { useWebSocket } from '@/contexts/WebSocketContext';

/**
 * What Claude is doing in a conversation, as the pet needs to know it.
 *
 * Derived from the run events already on the websocket rather than from the
 * chat components, which belong to another surface. Everything a run emits
 * carries a `sessionId`, so this is a filter and a small state machine over a
 * stream that is already flowing for the sidebar and the appearance engine.
 *
 * Four states, because the pet has four things to say:
 *
 * - `thinking` — the model is composing. The pet waits with it.
 * - `working` — a tool is running. Something is happening, so the pet moves.
 * - `done` — the turn finished. A brief celebration, then back to normal; a pet
 *   that celebrated indefinitely would just be a pet that looked stuck.
 * - `idle` — nothing in flight.
 */

export type ChatActivity = 'idle' | 'thinking' | 'working' | 'done';

/** How long the finish is celebrated before returning to idle. */
const DONE_MS = 2600;

/**
 * How long without any event before a run is assumed over.
 *
 * A crashed or abandoned run emits no `complete`, and a pet left thinking
 * forever is the most obviously broken thing on screen.
 */
const STALE_MS = 20000;

export function useChatActivity(sessionId: string | null): ChatActivity {
  const { subscribe } = useWebSocket();
  // Tagged with the conversation it describes rather than reset when the
  // conversation changes: a leftover 'thinking' from the chat you just left is
  // not this chat's state, and deriving that is cheaper and more honest than
  // clearing it in an effect.
  const [reading, setReading] = useState<{ sessionId: string; activity: ChatActivity } | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!sessionId) return undefined;

    const setActivity = (activity: ChatActivity) => setReading({ sessionId, activity });

    const clear = () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };

    /** Any activity resets the staleness clock; only `complete` schedules a return. */
    const settle = (next: ChatActivity, after: number) => {
      clear();
      timerRef.current = window.setTimeout(() => setActivity('idle'), after);
      setActivity(next);
    };

    const unsubscribe = subscribe((message) => {
      if (message.sessionId !== sessionId) return;

      switch (message.kind) {
        case 'thinking':
        case 'text':
        case 'stream_delta':
          settle('thinking', STALE_MS);
          break;
        case 'tool_use':
          settle('working', STALE_MS);
          break;
        // A tool finishing means the model is composing again, not that the
        // turn is over.
        case 'tool_result':
          settle('thinking', STALE_MS);
          break;
        case 'complete':
          settle('done', DONE_MS);
          break;
        case 'error':
          settle('idle', 0);
          break;
        default:
          break;
      }
    });

    return () => {
      unsubscribe();
      clear();
    };
  }, [sessionId, subscribe]);

  return reading && reading.sessionId === sessionId ? reading.activity : 'idle';
}
