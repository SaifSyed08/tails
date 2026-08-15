import { getConnection } from '@/db/connection.js';
import type { ChatSession } from '@/shared/types.js';

type SessionRow = {
  id: string;
  provider_session_id: string | null;
  title: string;
  cwd: string;
  created_at: string;
  updated_at: string;
  pinned_at: string | null;
  archived_at: string | null;
  pet_id: string | null;
};

/**
 * SQLite's `CURRENT_TIMESTAMP` writes `YYYY-MM-DD HH:MM:SS`, which is UTC but
 * says so nowhere. Two things went wrong with that. Sorting compared it as a
 * string against the ISO-8601 timestamps adopted sessions and Claude Code's own
 * history carry, and `' '` sorts before `'T'`, so every app-created chat sank
 * below every imported one regardless of date. And `new Date(...)` in the
 * renderer reads the space form as *local* time, so "3h ago" was wrong by the
 * timezone offset. Writing ISO-8601 UTC fixes both; `toIsoTimestamp` upgrades
 * rows written before this change on the way out.
 */
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function toIsoTimestamp(raw: string): string {
  if (!raw) return raw;
  if (raw.includes('T')) return raw;
  return `${raw.replace(' ', 'T')}Z`;
}

const toChatSession = (row: SessionRow): ChatSession => ({
  id: row.id,
  providerSessionId: row.provider_session_id,
  title: row.title,
  cwd: row.cwd,
  createdAt: toIsoTimestamp(row.created_at),
  updatedAt: toIsoTimestamp(row.updated_at),
  pinnedAt: row.pinned_at ? toIsoTimestamp(row.pinned_at) : null,
  archivedAt: row.archived_at ? toIsoTimestamp(row.archived_at) : null,
  petId: row.pet_id,
});

const COLUMNS = [
  'id', 'provider_session_id', 'title', 'cwd',
  'created_at', 'updated_at', 'pinned_at', 'archived_at', 'pet_id',
].join(', ');

/**
 * Persistence for app-owned conversations.
 *
 * This table is *not* the source of truth for transcripts — Claude Code owns
 * those, and the SDK reads them. What lives here is only what the SDK cannot
 * know: our stable app id, its mapping to the provider's session id, and the
 * per-conversation state the sidebar owns (pin, archive).
 */
export const sessionsRepository = {
  /**
   * Rows for the sidebar.
   *
   * `provider_session_id IS NOT NULL` is the "this conversation has messages"
   * test. The id is assigned from the first event of the first run, so a row
   * without one has never produced a transcript and is a blank chat the user
   * never sent anything in — it must not appear in the list.
   */
  listSessions(options: { limit?: number; archived?: boolean } = {}): ChatSession[] {
    const { limit = 50, archived = false } = options;
    const rows = getConnection()
      .prepare(`
        SELECT ${COLUMNS} FROM sessions
        WHERE provider_session_id IS NOT NULL
          AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(limit) as SessionRow[];
    return rows.map(toChatSession);
  },

  /**
   * Every provider id this app has a row for, archived and blank ones included.
   *
   * Used to suppress the Claude Code twin of a conversation we already know
   * about. It deliberately ignores the filters `listSessions` applies:
   * archiving a chat must not resurrect it through the external merge.
   */
  listOwnedProviderSessionIds(): string[] {
    const rows = getConnection()
      .prepare('SELECT provider_session_id FROM sessions WHERE provider_session_id IS NOT NULL')
      .all() as { provider_session_id: string }[];
    return rows.map((row) => row.provider_session_id);
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
        VALUES (?, ?, ?, ?, COALESCE(?, ${NOW_SQL}), COALESCE(?, ${NOW_SQL}))
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
   * re-pointing it would orphan the history. `updated_at` is left alone: the
   * run that triggers this already stamps it, and this is bookkeeping rather
   * than a message.
   */
  assignProviderSessionId(id: string, providerSessionId: string): void {
    getConnection()
      .prepare(`
        UPDATE sessions
        SET provider_session_id = ?
        WHERE id = ? AND provider_session_id IS NULL
      `)
      .run(providerSessionId, id);
  },

  /**
   * Repoints a conversation at a different folder.
   *
   * Deliberately does not touch `updated_at`: changing where a chat runs is not
   * a new message, and bumping it would reorder the sidebar for a non-event.
   */
  setCwd(id: string, cwd: string): void {
    getConnection().prepare('UPDATE sessions SET cwd = ? WHERE id = ?').run(cwd, id);
  },

  /**
   * Assigns the companion that belongs to this conversation, or clears it.
   *
   * Stored as a bare id with no foreign key: pets live on disk under
   * `~/.tails/pets`, not in this database, and a conversation must survive its
   * pet being uninstalled. A dangling id reads as "no pet", which is the right
   * outcome rather than a load failure. Leaves `updated_at` alone for the same
   * reason as `setCwd` — this is not a message.
   */
  setPetId(id: string, petId: string | null): void {
    getConnection().prepare('UPDATE sessions SET pet_id = ? WHERE id = ?').run(petId, id);
  },

  /**
   * Renames a conversation.
   *
   * Like `setCwd`, and for the same reason, this leaves `updated_at` alone. A
   * rename used to bump it, which meant retitling a month-old chat teleported
   * it to the top of "Most recent" — the column means "last message", and only
   * a message may move it.
   */
  renameSession(id: string, title: string): void {
    getConnection()
      .prepare('UPDATE sessions SET title = ? WHERE id = ?')
      .run(title, id);
  },

  setPinned(id: string, pinned: boolean): void {
    getConnection()
      .prepare(`UPDATE sessions SET pinned_at = ${pinned ? NOW_SQL : 'NULL'} WHERE id = ?`)
      .run(id);
  },

  setArchived(id: string, archived: boolean): void {
    getConnection()
      .prepare(`UPDATE sessions SET archived_at = ${archived ? NOW_SQL : 'NULL'} WHERE id = ?`)
      .run(id);
  },

  touchSession(id: string): void {
    getConnection()
      .prepare(`UPDATE sessions SET updated_at = ${NOW_SQL} WHERE id = ?`)
      .run(id);
  },

  deleteSession(id: string): boolean {
    return getConnection().prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
  },

  /**
   * Drops every conversation that never produced a transcript.
   *
   * Run once at boot rather than continuously: a row can legitimately exist
   * without a provider id for the few hundred milliseconds between the send
   * and the first streamed event, and a background sweep would race that
   * window.
   */
  deleteEmptySessions(): number {
    return getConnection()
      .prepare('DELETE FROM sessions WHERE provider_session_id IS NULL')
      .run().changes;
  },

  hideProviderSession(providerSessionId: string): void {
    getConnection()
      .prepare(`
        INSERT INTO hidden_provider_sessions (provider_session_id, hidden_at)
        VALUES (?, ${NOW_SQL})
        ON CONFLICT(provider_session_id) DO NOTHING
      `)
      .run(providerSessionId);
  },

  listHiddenProviderSessionIds(): string[] {
    const rows = getConnection()
      .prepare('SELECT provider_session_id FROM hidden_provider_sessions')
      .all() as { provider_session_id: string }[];
    return rows.map((row) => row.provider_session_id);
  },
};
