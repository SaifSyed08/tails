import { X } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { AmbientCanvas } from '@/components/scene/AmbientCanvas';
import { CustomScene } from '@/components/scene/CustomScene';
import { Pong, Snake } from '@/components/scene/Games';
import { useWebSocket } from '@/contexts/WebSocketContext';
import { Reveal } from '@/shared/ui/Motion';
import type { AmbientScene, Scene } from '@/types/scene';

/**
 * What the conversation is sitting in.
 *
 * Two mount points from one piece of state, because a scene is one choice with
 * two possible placements and splitting it into two components would mean two
 * subscriptions racing to agree about which one is showing.
 *
 * ## Scenery is never in the way
 *
 * The `behind` layer sits under the whole interface at low opacity with
 * `pointer-events: none`. Not a stylistic preference: it is what makes it safe
 * to run agent-authored content there at all, because a fake control drawn
 * behind everything cannot be clicked however convincing it looks.
 *
 * The opacity is the other half. Scenery has to lose every legibility contest
 * with the text in front of it — a background that competes with a conversation
 * is a background someone turns off within a minute, and takes the whole
 * feature with it.
 */

const AMBIENT_KINDS = new Set(['clouds', 'stars', 'grid', 'rain', 'meadow', 'voxel']);

function useScene(sessionId: string | null): { scene: Scene | null; clear: () => void } {
  const { subscribe } = useWebSocket();
  const [scene, setScene] = useState<Scene | null>(null);

  const load = useCallback((): void => {
    if (!sessionId) return;
    void fetch(`/api/scene/${encodeURIComponent(sessionId)}`)
      .then((response) => response.json() as Promise<{ scene: Scene | null }>)
      .then((body) => setScene(body.scene))
      // Scenery that cannot be read is scenery that is not drawn. Nothing here
      // is worth interrupting the conversation to report.
      .catch(() => {});
  }, [sessionId]);

  useEffect(load, [load]);

  useEffect(() => subscribe((message) => {
    if (message.kind !== 'scene_changed' || !message.content) return;
    try {
      const payload = JSON.parse(message.content) as { sessionId?: string; scene?: Scene | null };
      if (payload.sessionId !== sessionId) return;
      setScene(payload.scene ?? null);
    } catch {
      // A frame we cannot read changes nothing.
    }
  }), [subscribe, sessionId]);

  const clear = useCallback((): void => {
    if (!sessionId) return;
    void fetch(`/api/scene/${encodeURIComponent(sessionId)}/clear`, { method: 'POST' })
      .then(() => setScene(null))
      .catch(() => {});
  }, [sessionId]);

  return { scene, clear };
}

/** The full-bleed layer. Rendered by the shell, under everything it draws. */
export function SceneBackdrop({ sessionId }: { sessionId: string | null }) {
  const { scene } = useScene(sessionId);
  if (!scene || scene.layer !== 'behind') return null;

  const body = scene.scene;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden opacity-60"
    >
      {body.kind === 'custom'
        ? <CustomScene title={body.title} html={body.html} interactive={false} />
        : AMBIENT_KINDS.has(body.kind)
          ? <AmbientCanvas scene={body as AmbientScene} />
          : null}
    </div>
  );
}

/**
 * The corner card. Something to play with, in the space beside the conversation.
 *
 * Labelled and bordered, always, including for a custom scene — a sandboxed
 * page that could not be told apart from the app's own furniture would be the
 * one hole containment does not close. It has its own dismiss, because a toy
 * you cannot put down is not a toy.
 */
export function SceneCorner({ sessionId }: { sessionId: string | null }) {
  const { scene, clear } = useScene(sessionId);
  if (!scene || scene.layer !== 'corner') return null;

  /*
    Resolved to a title and a body together, in one narrowing.

    Computing the title first and returning on null looks tidier and does not
    narrow the union, so the render below would have to assert its way back to
    the kind it had already checked. A single switch keeps the compiler's answer
    and this file's answer the same one.
  */
  const shown = ((): { title: string; view: ReactNode } | null => {
    switch (scene.scene.kind) {
      case 'snake': return { title: 'Snake', view: <Snake /> };
      case 'pong': return { title: 'Pong', view: <Pong /> };
      case 'custom': return {
        title: scene.scene.title,
        view: <CustomScene title={scene.scene.title} html={scene.scene.html} interactive />,
      };
      // Scenery in the corner is refused server-side, so this is unreachable
      // rather than unhandled — and drawing nothing is the right answer if the
      // two ever disagree.
      default: return null;
    }
  })();
  if (!shown) return null;

  return (
    <Reveal
      variant="rise"
      as="section"
      label={`In the corner: ${shown.title}`}
      className="pointer-events-auto fixed bottom-4 right-4 z-20 flex h-56 w-64 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-2 py-1">
        <span className="truncate text-[11px] font-medium text-muted-foreground">{shown.title}</span>
        <button
          type="button"
          onClick={clear}
          aria-label="Put it away"
          className="rounded p-0.5 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1">{shown.view}</div>
    </Reveal>
  );
}
