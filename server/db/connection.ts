import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the app keeps its own state.
 *
 * Deliberately not `~/.claude` — that directory belongs to Claude Code, and
 * writing into it risks colliding with the CLI's own files. TAILS owns
 * `~/.tails` and treats `~/.claude` as read-only.
 */
export const TAILS_HOME = process.env.TAILS_HOME || path.join(os.homedir(), '.tails');

let connection: Database.Database | null = null;

/**
 * The schema, applied on every boot.
 *
 * Every statement is `IF NOT EXISTS`, so this doubles as the migration path
 * for the shapes that only ever gain tables. Columns added after a release
 * cannot go here — SQLite has no `ADD COLUMN IF NOT EXISTS` — so they are
 * listed here for fresh databases and re-applied by `ensureColumn` below for
 * existing ones.
 */
const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  provider_session_id TEXT,
  title TEXT NOT NULL DEFAULT 'New chat',
  cwd TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  pinned_at DATETIME,
  archived_at DATETIME,
  -- The companion assigned to this conversation. No foreign key: pets live on
  -- disk, not in this database, and uninstalling one must not break a chat.
  pet_id TEXT,
  -- Set when the user names a chat themselves. Claude Code writes its own
  -- title into the transcript and we adopt it, but never over a chosen name.
  title_pinned INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider_session_id);

-- Conversations Claude Code owns that the user deleted from our sidebar.
-- Their transcripts live under ~/.claude, which this app treats as read-only,
-- so "delete" cannot mean "unlink the file". A tombstone is the honest
-- alternative: it keeps the chat out of the merged list without touching
-- someone else's data.
CREATE TABLE IF NOT EXISTS hidden_provider_sessions (
  provider_session_id TEXT PRIMARY KEY,
  hidden_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS generated_themes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT,
  spec_version INTEGER NOT NULL DEFAULT 1,
  spec_json TEXT NOT NULL,
  tokens_json TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('generated', 'saved')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- App-wide preferences that belong to the user rather than to a conversation.
-- Key/value rather than a column per setting: these are read one at a time by
-- the module that owns them, and a table that grows a column per preference
-- makes every one of them a schema migration in a file nobody else should have
-- to touch.
CREATE TABLE IF NOT EXISTS app_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS theme_bindings (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'session')),
  scope_key TEXT NOT NULL DEFAULT '',
  theme_id TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope, scope_key)
);
`;

/**
 * Adds a column to an existing table, if it is not already there.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op once the table exists, so a column
 * added to `SCHEMA_SQL` only reaches databases created after the change. This
 * closes that gap for the ones created before it.
 */
function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (existing.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Opens the database, creating the directory and schema on first use.
 *
 * Lazily initialised so importing a repository module in a test does not touch
 * the filesystem until something actually queries.
 */
export function getConnection(): Database.Database {
  if (connection) return connection;

  fs.mkdirSync(TAILS_HOME, { recursive: true });
  connection = new Database(path.join(TAILS_HOME, 'tails.db'));
  connection.exec(SCHEMA_SQL);
  ensureColumn(connection, 'sessions', 'pinned_at', 'DATETIME');
  ensureColumn(connection, 'sessions', 'archived_at', 'DATETIME');
  ensureColumn(connection, 'sessions', 'pet_id', 'TEXT');
  ensureColumn(connection, 'sessions', 'title_pinned', 'INTEGER NOT NULL DEFAULT 0');
  return connection;
}

export function closeConnection(): void {
  connection?.close();
  connection = null;
}
