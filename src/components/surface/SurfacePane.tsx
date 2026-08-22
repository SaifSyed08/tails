import { X } from 'lucide-react';
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
 * ## Why it is keyed by conversation
 *
 * A panel is the output of a particular piece of work. Making it global would
 * repeat the bug the preview pane already had, where one chat's output appeared
 * beside every other one.
 *
 * ## Why the state is here and not in a store
 *
 * Unlike the preview, nothing else in the app needs to know about a surface —
 * there is no header button to reopen one, because there is nothing to reopen:
 * closing a panel is the agent finishing with it or the user dismissing it, and
 * the way to get it back is to ask. A module-level store would be machinery for
 * one reader.
 */
export function SurfacePane({ sessionId }: { sessionId: string | null }) {
  const { subscribe } = useWebSocket();
  const [surface, setSurface] = useState<Surface | null>(null);
  const [dismissed, setDismissed] = useState(false);

  /*
    A panel built before this client was looking at the conversation.

    The broadcast is the live path and cannot replay, so arriving at a chat — or
    reloading into one — needs a single read. Nothing polls after this: a monitor
    that only updated when something asked would be a monitor that is wrong
    between asks.

    There is no reset here because there is nothing to reset: the pane is
    mounted under a key of the conversation id, so switching chats gives it a
    fresh instance rather than a stale one to clear. Clearing in an effect would
    also mean a render where this chat's pane still holds the last one's panel.
  */
  useEffect(() => {
    if (!sessionId) return undefined;

    let cancelled = false;
    void fetch(`/api/surface/${encodeURIComponent(sessionId)}`)
      .then((response) => response.json() as Promise<{ surface: Surface | null }>)
      .then((body) => { if (!cancelled) setSurface(body.surface); })
      // A panel that cannot be read is a panel that is not shown. There is
      // nothing here worth interrupting the conversation to report.
      .catch(() => {});

    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => subscribe((message) => {
    if (message.kind !== 'surface_changed' || !message.content) return;

    let payload: { sessionId?: string; surface?: Surface | null };
    try {
      payload = JSON.parse(message.content) as typeof payload;
    } catch {
      return;
    }

    if (!payload.sessionId || payload.sessionId !== sessionId) return;
    // A new panel is a new thing to look at, so a previous dismissal does not
    // carry over — otherwise the agent builds one, the user closes it, and
    // every panel after that is invisible with no way to discover why.
    setDismissed(false);
    setSurface(payload.surface ?? null);
  }), [subscribe, sessionId]);

  /*
    The one widget that raises its voice.

    Keyed on the revision rather than on the status, because two consecutive
    matches are two events: a monitor that finds something, gets rebuilt, and
    finds something again would otherwise chime once. Skipped on the first
    render of a panel that arrived already matching — the client that reloads
    into an old match should not be told it just happened.
  */
  const matched = surface?.widgets.some(
    (widget) => widget.kind === 'monitor' && widget.status === 'match',
  ) ?? false;
  const lastAnnounced = useRef<number | null>(null);
  useEffect(() => {
    if (!surface || !matched) return;
    if (lastAnnounced.current === null) { lastAnnounced.current = surface.revision; return; }
    if (lastAnnounced.current === surface.revision) return;
    lastAnnounced.current = surface.revision;
    chimeMatch();
  }, [surface, matched]);

  const dismiss = useCallback(() => setDismissed(true), []);

  if (!surface || dismissed) return null;

  return (
    <Reveal
      variant="rise"
      as="section"
      label={`Panel: ${surface.title}`}
      className="flex w-full min-w-0 shrink-0 flex-col border-l border-border md:w-80 lg:w-96"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="truncate text-xs font-semibold">{surface.title}</h3>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close panel"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </header>

      {/* The pulse wraps the list rather than the pane, so the header and its
          close button stay still while the content announces itself. */}
      <AttentionPulse trigger={matched ? surface.revision : 'quiet'} className="min-h-0 flex-1">
        <div className="h-full space-y-2 overflow-y-auto p-3">
          {surface.widgets.map((widget) => (
            <WidgetView key={widget.id} widget={widget} />
          ))}
        </div>
      </AttentionPulse>
    </Reveal>
  );
}
