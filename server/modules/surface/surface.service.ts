import { randomUUID } from 'node:crypto';

import { surfacesRepository, type StoredSurface } from '@/db/surfaces.repository.js';
import { startWatchers, stopWatchers, type MonitorPatch } from '@/modules/surface/bindings.js';
import {
  LIMITS,
  readSurfaceSpec,
  type IdentifiedWidget,
  type Surface,
} from '@/modules/surface/widget-spec.js';
import { appBroadcast } from '@/shared/broadcast.js';
import { createMessage } from '@/shared/utils.js';

/**
 * What each conversation currently has on its surface.
 *
 * Keyed by conversation for the same reason the preview pane is, and it was a
 * bug there before it was a rule here: a panel built by one chat appearing
 * beside every other one is not a dashboard, it is a leak. A surface is the
 * output of *this* work.
 *
 * The map is the live copy and the table is the durable one. Both, rather than
 * only the table, because a watcher ticks against an object it already holds
 * and reading a row back on every tick to compare two strings would be a query
 * every few seconds for the normal case of nothing having happened.
 *
 * ## Except when the user pins one
 *
 * A panel can be asked to follow the user out of its own conversation, which is
 * the case the keying gets wrong: you set something watching, go and work
 * somewhere else, and that is precisely when you want to keep seeing it. Exactly
 * one panel can be pinned — two would be two claims on the same strip of screen.
 */
const surfaces = new Map<string, Surface>();

function publish(sessionId: string, surface: Surface | null): void {
  appBroadcast.publish(createMessage('surface_changed', 'app', {
    // JSON in `content`, like `preview_changed`: the wire protocol is small on
    // purpose, and a closed surface has to be expressible.
    content: JSON.stringify({ sessionId, surface }),
  }));
}

/**
 * Folds a watcher's result into the monitor it belongs to.
 *
 * Returns whether anything actually moved. A watcher that reports the same
 * thing every five seconds is the normal case — nothing has happened yet — and
 * republishing it would re-render every open window on a timer, replay the
 * entrance animation, and re-announce a match that is simply still true.
 */
function applyPatch(surface: Surface, widgetId: string, patch: MonitorPatch): boolean {
  const widget = surface.widgets.find((entry) => entry.id === widgetId);
  if (!widget || widget.kind !== 'monitor') return false;

  const matches = widget.matches ?? [];
  // Only a genuinely new finding is kept. A file that keeps changing appends;
  // one reported twice with the same stamp does not.
  const isNew = patch.match !== undefined && patch.match !== matches[0];
  const nextMatches = isNew ? [patch.match as string, ...matches].slice(0, LIMITS.items) : matches;

  if (widget.status === patch.status && widget.detail === patch.detail && !isNew) return false;

  widget.status = patch.status;
  widget.detail = patch.detail;
  if (nextMatches.length > 0) widget.matches = nextMatches;
  surface.revision += 1;
  return true;
}

/**
 * Starts a panel's watchers and keeps the panel in step with what they find.
 *
 * Shared by a fresh `show` and by the restore at startup, because those two
 * cases differ only in where the widgets came from. Anything else would mean a
 * restored monitor behaving subtly unlike a new one.
 */
function watch(sessionId: string, surface: Surface): void {
  startWatchers(sessionId, surface.widgets, (widgetId, patch) => {
    // Only if this is still the panel that started the watcher. A tick that
    // lands after a redraw belongs to a widget that no longer exists.
    if (surfaces.get(sessionId) !== surface) return;
    if (!applyPatch(surface, widgetId, patch)) return;

    surfacesRepository.write(sessionId, surface);
    publish(sessionId, surface);
  });
}

/**
 * Panels whose watchers are restarted when the app does.
 *
 * A cap rather than all of them. Restoring the panels themselves is free, and
 * restarting a timer for every conversation that ever had one is how an app
 * acquires background work nobody remembers asking for. The most recently
 * written are the ones still being used.
 */
const RESTORE_WATCHER_BUDGET = 6;

export const surfaceService = {
  /**
   * What this conversation should be showing, and what is following the user.
   *
   * Both, in one read, because the pane has to decide between them and asking
   * twice would let it briefly show neither.
   */
  read(sessionId: string): { surface: Surface | null; pinned: StoredSurface | null } {
    const live = surfaces.get(sessionId) ?? null;

    return {
      surface: live ?? surfacesRepository.read(sessionId),
      /*
        The pinned panel, whichever conversation it belongs to — including this
        one. Filtering it out here would leave the caller unable to tell "no
        panel is pinned" from "the pinned panel is the one you are looking at",
        and those want different controls: one offers to pin, the other to stop.
      */
      pinned: surfacesRepository.readPinned(),
    };
  },

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
    const previous = surfaces.get(sessionId) ?? surfacesRepository.read(sessionId);

    const surface: Surface = {
      title: spec.title,
      widgets: spec.widgets.map((widget): IdentifiedWidget => ({
        ...widget,
        id: `w_${randomUUID()}`,
      })),
      revision: (previous?.revision ?? 0) + 1,
    };

    surfaces.set(sessionId, surface);
    surfacesRepository.write(sessionId, surface);

    /*
      A rebuilt panel is a fresh statement of what to watch, so the previous
      watchers stop — `startWatchers` does that first. Leaving them would mean a
      monitor nobody can see still polling, and two generations of the same
      watcher writing into one widget.
    */
    watch(sessionId, surface);
    publish(sessionId, surface);
    return surface;
  },

  /** Takes the surface down. Idempotent: closing a closed surface is fine. */
  close(sessionId: string): void {
    stopWatchers(sessionId);
    surfaces.delete(sessionId);
    surfacesRepository.remove(sessionId);
    publish(sessionId, null);
  },

  /** Asks a panel to follow the user out of its own conversation. */
  pin(sessionId: string): void {
    surfacesRepository.pin(sessionId);
    // Republished so every open window re-reads: pinning changes what a
    // conversation that has no panel of its own should be showing.
    publish(sessionId, surfaces.get(sessionId) ?? surfacesRepository.read(sessionId));
  },

  unpin(sessionId: string): void {
    surfacesRepository.unpin(sessionId);
    publish(sessionId, surfaces.get(sessionId) ?? surfacesRepository.read(sessionId));
  },

  /**
   * Brings panels back after a restart, and starts watching again.
   *
   * The watchers are the reason this is not merely a cache warm. A restored
   * monitor that said "watching" while nothing watched would be the panel
   * lying about the one thing it is for, so either the timers come back with it
   * or the status would have to be rewritten to admit they had not.
   */
  restore(): { panels: number; pruned: number } {
    const pruned = surfacesRepository.prune();
    const stored = surfacesRepository.list();

    let budget = RESTORE_WATCHER_BUDGET;
    for (const entry of stored) {
      const surface: Surface = {
        title: entry.title,
        widgets: entry.widgets,
        revision: entry.revision,
      };
      surfaces.set(entry.sessionId, surface);

      const watches = surface.widgets.some(
        (widget) => widget.kind === 'monitor' && widget.watch,
      );
      if (watches && budget > 0) {
        budget -= 1;
        watch(entry.sessionId, surface);
      }
    }

    return { panels: stored.length, pruned };
  },

  /** Everything about a conversation goes when the conversation does. */
  forget(sessionId: string): void {
    stopWatchers(sessionId);
    surfaces.delete(sessionId);
    surfacesRepository.remove(sessionId);
  },
};

/** What this conversation should be showing, for a client that connects late. */
export const readSurface = (sessionId: string) => surfaceService.read(sessionId);
