import { getConnection } from '@/db/connection.js';
import type { IdentifiedWidget, Surface } from '@/modules/surface/widget-spec.js';

export type StoredSurface = Surface & {
  sessionId: string;
  /** Set when the user asked this panel to follow them out of its conversation. */
  pinned: boolean;
  updatedAt: string;
};

type SurfaceRow = {
  session_id: string;
  title: string;
  widgets_json: string;
  revision: number;
  pinned_at: string | null;
  updated_at: string;
};

/**
 * Reads a row back into a surface, or null if the JSON no longer parses.
 *
 * A stored panel outlives the code that wrote it, so a widget shape that has
 * since changed is a real possibility. Refusing the row is the right failure:
 * the panel is gone and the agent can build a new one, which is better than a
 * half-drawn dashboard from an older version of the app.
 */
function toSurface(row: SurfaceRow): StoredSurface | null {
  try {
    const widgets = JSON.parse(row.widgets_json) as IdentifiedWidget[];
    if (!Array.isArray(widgets) || widgets.length === 0) return null;

    return {
      sessionId: row.session_id,
      title: row.title,
      widgets,
      revision: row.revision,
      pinned: row.pinned_at !== null,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

export const surfacesRepository = {
  read(sessionId: string): StoredSurface | null {
    const row = getConnection()
      .prepare('SELECT * FROM surfaces WHERE session_id = ?')
      .get(sessionId) as SurfaceRow | undefined;

    return row ? toSurface(row) : null;
  },

  /** The one panel following the user around, if any. */
  readPinned(): StoredSurface | null {
    const row = getConnection()
      .prepare('SELECT * FROM surfaces WHERE pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 1')
      .get() as SurfaceRow | undefined;

    return row ? toSurface(row) : null;
  },

  /** Most recently written first, which is the order worth resuming in. */
  list(): StoredSurface[] {
    const rows = getConnection()
      .prepare('SELECT * FROM surfaces ORDER BY updated_at DESC')
      .all() as SurfaceRow[];

    return rows.map(toSurface).filter((surface): surface is StoredSurface => surface !== null);
  },

  /** Writing a panel never changes whether it is pinned; that is the user's. */
  write(sessionId: string, surface: Surface): void {
    getConnection().prepare(`
      INSERT INTO surfaces (session_id, title, widgets_json, revision, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO UPDATE SET
        title = excluded.title,
        widgets_json = excluded.widgets_json,
        revision = excluded.revision,
        updated_at = CURRENT_TIMESTAMP
    `).run(sessionId, surface.title, JSON.stringify(surface.widgets), surface.revision);
  },

  /**
   * Pins one panel, and only one.
   *
   * Unpinning everything else first, in a transaction, because "the panel that
   * follows me" is singular by construction: two of them would be two claims on
   * the same strip of screen beside every conversation.
   */
  pin(sessionId: string): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare('UPDATE surfaces SET pinned_at = NULL WHERE pinned_at IS NOT NULL').run();
      db.prepare('UPDATE surfaces SET pinned_at = CURRENT_TIMESTAMP WHERE session_id = ?')
        .run(sessionId);
    })();
  },

  unpin(sessionId: string): void {
    getConnection()
      .prepare('UPDATE surfaces SET pinned_at = NULL WHERE session_id = ?')
      .run(sessionId);
  },

  remove(sessionId: string): void {
    getConnection().prepare('DELETE FROM surfaces WHERE session_id = ?').run(sessionId);
  },

  /**
   * Drops panels whose conversation this app no longer has a row for.
   *
   * Run at startup rather than on delete, because a conversation can also
   * disappear by being removed from `~/.claude` outside this app entirely.
   * Returns how many went, so the caller can say so.
   */
  prune(): number {
    return getConnection().prepare(`
      DELETE FROM surfaces
      WHERE session_id NOT IN (SELECT id FROM sessions)
    `).run().changes;
  },
};
