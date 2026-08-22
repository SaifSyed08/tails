import { Pin, PinOff, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { WidgetView } from '@/components/surface/Widgets';
import { chimeMatch } from '@/components/voice/voice-chime';
import { useWebSocket } from '@/contexts/WebSocketContext';
import { AttentionPulse, Reveal } from '@/shared/ui/Motion';
import type { Surface } from '@/types/surface';

/**
 * The panel the agent built, beside the conversation that produced it.
 *
 * A sibling of the chat column rather than something over it, for the reason
 * the preview pane is: the point is seeing the result and the conversation at
 * once. It renders nothing until a tool builds one, so it costs no layout when
 * unused.
 *
 * ## Why it is keyed by conversation, and when it is not
 *
 * A panel is the output of a particular piece of work, so it belongs to the
 * chat that produced it — making it global would repeat the bug the preview
 * pane already had, where one chat's output appeared beside every other one.
 *
 * The exception is the case that keying gets wrong. You set something watching,
 * then go and work somewhere else, and *that* is when you want to keep seeing
 * it. So one panel can be pinned, and a pinned panel follows the user into
 * conversations that have none of their own — labelled, so it is never mistaken
 * for something this chat produced.
 */

type PinnedSurface = Surface & { sessionId: string };

type PaneState = { surface: Surface | null; pinned: PinnedSurface | null };

export function SurfacePane({ sessionId }: { sessionId: string | null }) {
  const { subscribe } = useWebSocket();
  const [state, setState] = useState<PaneState>({ surface: null, pinned: null });
  const [dismissed, setDismissed] = useState(false);

  // Chained rather than awaited: the state lands in a callback, which is what
  // keeps the mount effect below from being a synchronous setState.
  const load = useCallback((): void => {
    if (!sessionId) return;
    void fetch(`/api/surface/${encodeURIComponent(sessionId)}`)
      .then((response) => response.json() as Promise<PaneState>)
      .then(setState)
      // A panel that cannot be read is a panel that is not shown. There is
      // nothing here worth interrupting the conversation to report.
      .catch(() => {});
  }, [sessionId]);

  /*
    A panel built before this client was looking at the conversation.

    The broadcast is the live path and cannot replay, so arriving at a chat — or
    reloading into one — needs a single read. Nothing polls after this: a monitor
    that only updated when something asked would be a monitor that is wrong
    between asks.

    There is no reset here because there is nothing to reset: the pane is
    mounted under a key of the conversation id, so switching chats gives it a
    fresh instance rather than a stale one to clear.
  */
  useEffect(load, [load]);

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  /*
    Live updates.

    Handled in place for the two panels this pane could be showing, rather than
    re-reading on every event: a watcher elsewhere finding something would
    otherwise cost every open window a request. The one case that cannot be
    handled in place is a panel in a third conversation being pinned — nothing
    here knows about it yet — so that is the single condition that goes back to
    the server, and only while there is nothing on screen to disturb.
  */
  useEffect(() => subscribe((message) => {
    if (message.kind !== 'surface_changed' || !message.content) return;

    let payload: { sessionId?: string; surface?: Surface | null };
    try {
      payload = JSON.parse(message.content) as typeof payload;
    } catch {
      return;
    }
    const from = payload.sessionId;
    if (!from) return;

    const surface = payload.surface ?? null;
    const current = stateRef.current;

    if (from === sessionId) {
      // A new panel is a new thing to look at, so a previous dismissal does not
      // carry over — otherwise the agent builds one, the user closes it, and
      // every panel after that is invisible with no way to discover why.
      setDismissed(false);
      setState((previous) => ({ ...previous, surface }));
      return;
    }

    if (from === current.pinned?.sessionId) {
      setDismissed(false);
      setState((previous) => ({
        ...previous,
        pinned: surface ? { ...surface, sessionId: from } : null,
      }));
      return;
    }

    if (!current.surface && !current.pinned) load();
  }), [subscribe, sessionId, load]);

  const ownIsPinned = state.pinned?.sessionId === sessionId;
  // A pinned panel is not "following you" into its own conversation; there it
  // is simply the panel.
  const following = state.pinned && !ownIsPinned ? state.pinned : null;
  const shown = state.surface ?? following;
  const shownSessionId = state.surface ? sessionId : following?.sessionId ?? null;

  /*
    The one widget that raises its voice.

    Keyed on *what* is matching rather than on the revision. A watching monitor
    revises itself every few seconds for as long as it runs, and a match that is
    simply still true is not a new event — chiming on the revision would turn the
    concept's "make a sound when you find one" into a metronome. The signature
    changes when a monitor starts matching, stops, or finds something it had not
    found before, which is exactly the set of moments worth a sound.

    The first signature is recorded silently: a client that reloads into a match
    from an hour ago should not be told it just happened.
  */
  const matchSignature = shown?.widgets
    .filter((widget) => widget.kind === 'monitor' && widget.status === 'match')
    .map((widget) => `${widget.id}:${widget.kind === 'monitor' ? widget.matches?.[0] ?? '' : ''}`)
    .join('|') ?? '';
  const matched = matchSignature !== '';

  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (announced.current === null) { announced.current = matchSignature; return; }
    if (announced.current === matchSignature) return;
    announced.current = matchSignature;
    if (matchSignature !== '') chimeMatch();
  }, [matchSignature]);

  const pinnedHere = shownSessionId !== null && state.pinned?.sessionId === shownSessionId;

  const togglePin = useCallback(async (): Promise<void> => {
    if (!shownSessionId) return;
    try {
      const response = await fetch(
        `/api/surface/${encodeURIComponent(shownSessionId)}/${pinnedHere ? 'unpin' : 'pin'}`,
        { method: 'POST' },
      );
      setState(await response.json() as PaneState);
    } catch {
      // Leaving the button as it was is the honest outcome: the pin did not
      // happen, and showing it as though it had would be worse than nothing.
    }
  }, [shownSessionId, pinnedHere]);

  if (!shown || dismissed) return null;

  return (
    <Reveal
      variant="rise"
      as="section"
      label={`Panel: ${shown.title}`}
      className="flex w-full min-w-0 shrink-0 flex-col border-l border-border md:w-80 lg:w-96"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h3 className="truncate text-xs font-semibold">{shown.title}</h3>
          {/* Said plainly, because a panel from somewhere else looking exactly
              like one this chat produced is how a number gets read as an answer
              to the wrong question. */}
          {following ? (
            <p className="truncate text-[11px] text-muted-foreground">From another conversation</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void togglePin()}
            aria-pressed={pinnedHere}
            aria-label={pinnedHere
              ? 'Stop this panel following you'
              : 'Keep this panel while you work elsewhere'}
            className="rounded-md p-1 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground aria-pressed:text-primary"
          >
            {pinnedHere
              ? <PinOff className="size-3.5" aria-hidden="true" />
              : <Pin className="size-3.5" aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Close panel"
            className="rounded-md p-1 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* The pulse wraps the list rather than the pane, so the header and its
          buttons stay still while the content announces itself. */}
      <AttentionPulse trigger={matched ? matchSignature : 'quiet'} className="min-h-0 flex-1">
        <div className="h-full space-y-2 overflow-y-auto p-3">
          {shown.widgets.map((widget) => (
            <WidgetView key={widget.id} widget={widget} />
          ))}
        </div>
      </AttentionPulse>
    </Reveal>
  );
}
