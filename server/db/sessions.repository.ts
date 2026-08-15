import { getConnection } from '@/db/connection.js';
import type { ChatSession } from '@/shared/types.js';

type SessionRow = {
  id: string;
  provider_session_id: string | null;
  title: string;
  cwd: string;
  created_at: string;
  updated_at: string;
};

const toChatSession = (row: SessionRow): ChatSession => ({
  id: row.id,
  providerSessionId: row.provider_session_id,
  title: row.title,
  cwd: row.cwd,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const COLUMNS = 'id, provider_session_id, title, cwd, created_at, updated_at';

/**
 * Persistence for app-owned conversations.
 *
 * This table is *not* the source of truth for transcripts — Claude Code owns
 * those, and the SDK reads them. What lives here is only what the SDK cannot
 * know: our stable app id, and its mapping to the provider's session id.
 */
export const sessionsRepository = {
  listSessions(limit = 50): ChatSession[] {
    const rows = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM sessions ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as SessionRow[];
    return rows.map(toChatSession);
  },

  getSession(id: string): ChatSession | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined;
    return row ? toChatSession(row) : null;
  },

  /** Looks a session up by Claude Code's id, used when adopting an external transcript. */
  findByProviderSessionId(providerSessionId: string): ChatSession | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM sessions WHERE provider_session_id = ?`)
      .get(providerSessionId) as SessionRow | undefined;
    return row ? toChatSession(row) : null;
  },

  /**
   * Inserts a conversation row.
   *
   * `lastActivityAt` exists for adoption: a conversation Claude Code created
   * last week must keep last week's timestamp, or opening it would sort it to
   * the top of the sidebar as though it were new. Ordering is by last message,
   * not last viewed.
   */
  createSession(session: {
    id: string;
    title: string;
    cwd: string;
    providerSessionId?: string | null;
    lastActivityAt?: string | null;
  }): ChatSession {
    getConnection()
      .prepare(`
        INSERT INTO sessions (id, provider_session_id, title, cwd, created_at, updated_at)
        VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
      `)
      .run(
        session.id,
        session.providerSessionId ?? null,
        session.title,
        session.cwd,
        session.lastActivityAt ?? null,
        session.lastActivityAt ?? null,
      );
    return this.getSession(session.id) as ChatSession;
  },

  /**
   * Records the provider's session id the first time we learn it.
   *
   * Guarded with `IS NULL` so a later run cannot overwrite the mapping — the
   * first id a session announces is the one its transcript lives under, and
   * re-pointing it would orphan the history.
   */
  assignProviderSessionId(id: string, providerSessionId: string): void {
    getConnection()
      .prepare(`
        UPDATE sessions
        SET provider_session_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND provider_session_id IS NULL
      `)
      .run(providerSessionId, id);
  },

  renameSession(id: string, title: string): void {
    getConnection()
      .prepare('UPDATE sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(title, id);
  },

  touchSession(id: string): void {
    getConnection()
      .prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(id);
  },

  deleteSession(id: string): boolean {
    return getConnection().prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
  },
};
