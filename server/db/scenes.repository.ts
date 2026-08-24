import { getConnection } from '@/db/connection.js';
import type { Scene, SceneLayer } from '@/modules/scene/scene-spec.js';

export type StoredScene = Scene & { revision: number };

type SceneRow = {
  session_id: string;
  layer: SceneLayer;
  spec_json: string;
  revision: number;
};

/**
 * Reads a row back, or null if it no longer parses.
 *
 * A stored scene outlives the code that wrote it, and the union it was written
 * against will change. Losing the scenery is the right failure — it is one
 * sentence to ask for it again — and half-drawing an older app's idea of a
 * meadow is not.
 */
function toScene(row: SceneRow): StoredScene | null {
  try {
    const scene = JSON.parse(row.spec_json) as Scene['scene'];
    if (!scene || typeof scene !== 'object' || typeof scene.kind !== 'string') return null;
    return { layer: row.layer, scene, revision: row.revision };
  } catch {
    return null;
  }
}

export const scenesRepository = {
  read(sessionId: string): StoredScene | null {
    const row = getConnection()
      .prepare('SELECT * FROM scenes WHERE session_id = ?')
      .get(sessionId) as SceneRow | undefined;

    return row ? toScene(row) : null;
  },

  write(sessionId: string, scene: Scene, revision: number): void {
    getConnection().prepare(`
      INSERT INTO scenes (session_id, layer, spec_json, revision, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO UPDATE SET
        layer = excluded.layer,
        spec_json = excluded.spec_json,
        revision = excluded.revision,
        updated_at = CURRENT_TIMESTAMP
    `).run(sessionId, scene.layer, JSON.stringify(scene.scene), revision);
  },

  remove(sessionId: string): void {
    getConnection().prepare('DELETE FROM scenes WHERE session_id = ?').run(sessionId);
  },

  /** Scenery for conversations this app no longer has a row for. */
  prune(): number {
    return getConnection().prepare(`
      DELETE FROM scenes WHERE session_id NOT IN (SELECT id FROM sessions)
    `).run().changes;
  },
};
