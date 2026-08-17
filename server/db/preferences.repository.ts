import { getConnection } from '@/db/connection.js';

/**
 * The app's own preferences, as opaque strings keyed by name.
 *
 * Deliberately untyped at this layer. Every preference has a module that owns
 * its shape, its defaults and its clamps, and that module is the only place
 * that should know them — a repository that also validated would be a second
 * opinion about what a valid voice or a valid instruction is, and the two would
 * eventually disagree. So this stores what it is handed and hands it back.
 *
 * The JSON encoding is likewise the caller's business: conversation
 * instructions are stored as the raw text they already are, and the default
 * voice is stored as JSON, because wrapping a string in quotes to satisfy a
 * uniform codec buys nothing and makes the table unreadable by eye.
 */
export const preferencesRepository = {
  read(key: string): string | null {
    const row = getConnection()
      .prepare('SELECT value FROM app_preferences WHERE key = ?')
      .get(key) as { value: string } | undefined;

    return row?.value ?? null;
  },

  write(key: string, value: string): void {
    getConnection().prepare(`
      INSERT INTO app_preferences (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, value);
  },
};
