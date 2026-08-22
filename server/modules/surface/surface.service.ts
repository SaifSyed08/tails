import { randomUUID } from 'node:crypto';

import { appBroadcast } from '@/shared/broadcast.js';
import { createMessage } from '@/shared/utils.js';
import {
  readSurfaceSpec,
  type IdentifiedWidget,
  type Surface,
} from '@/modules/surface/widget-spec.js';

/**
 * What each conversation currently has on its surface.
 *
 * Keyed by conversation for the same reason the preview pane is, and it was a
 * bug there before it was a rule here: a panel built by one chat appearing
 * beside every other one is not a dashboard, it is a leak. A surface is the
 * output of *this* work.
 *
 * In memory for now. Persisting a surface so it survives a restart is the next
 * step and is deliberately not this one — a panel that comes back wrong is
 * harder to reason about than one that does not come back, and the shape of
 * what is worth keeping is clearer once the thing has been used.
 */
const surfaces = new Map<string, Surface>();

/** What this conversation should be showing, for a client that connects late. */
export const readSurface = (sessionId: string): Surface | null =>
  surfaces.get(sessionId) ?? null;

function publish(sessionId: string, surface: Surface | null): void {
  appBroadcast.publish(createMessage('surface_changed', 'app', {
    // JSON in `content`, like `preview_changed`: the wire protocol is small on
    // purpose, and a closed surface has to be expressible.
    content: JSON.stringify({ sessionId, surface }),
  }));
}

export const surfaceService = {
  /**
   * Replaces a conversation's surface, whole.
   *
   * Wholesale rather than a per-widget patch, and that is the point rather than
   * a simplification: a failed generation cannot leave half a rewritten panel on
   * screen, and there is no state the agent has to remember to keep in step.
   * Redrawing costs one message; a half-written dashboard costs trust in all of
   * them.
   *
   * Ids are minted here. A generated widget therefore cannot collide with, or
   * pose as, one already on the surface.
   */
  show(sessionId: string, input: unknown): Surface {
    const spec = readSurfaceSpec(input);
    const previous = surfaces.get(sessionId);

    const surface: Surface = {
      title: spec.title,
      widgets: spec.widgets.map((widget): IdentifiedWidget => ({
        ...widget,
        id: `w_${randomUUID()}`,
      })),
      revision: (previous?.revision ?? 0) + 1,
    };

    surfaces.set(sessionId, surface);
    publish(sessionId, surface);
    return surface;
  },

  /** Takes the surface down. Idempotent: closing a closed surface is fine. */
  close(sessionId: string): void {
    if (!surfaces.delete(sessionId)) return;
    publish(sessionId, null);
  },

  /** Everything about a conversation goes when the conversation does. */
  forget(sessionId: string): void {
    surfaces.delete(sessionId);
  },
};
