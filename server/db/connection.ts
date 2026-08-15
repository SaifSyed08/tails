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
 * for the shapes that only ever gain tables. Column changes will need real
 * migrations later; there are none yet.
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
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider_session_id);

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

CREATE TABLE IF NOT EXISTS theme_bindings (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'session')),
  scope_key TEXT NOT NULL DEFAULT '',
  theme_id TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope, scope_key)
);
`;

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
  return connection;
}

export function closeConnection(): void {
  connection?.close();
  connection = null;
}
