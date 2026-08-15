import { getConnection } from '@/db/connection.js';
import type { DerivedTheme } from '@/modules/appearance/derive.js';
import type { ThemeSpec } from '@/modules/appearance/theme-spec.js';

export type StoredTheme = {
  id: string;
  name: string;
  summary: string | null;
  specVersion: number;
  spec: ThemeSpec;
  tokens: DerivedTheme;
  origin: 'generated' | 'saved';
  revision: number;
  updatedAt: string;
};

export type ThemeScope = 'global' | 'project' | 'session';

type ThemeRow = {
  id: string;
  name: string;
  summary: string | null;
  spec_version: number;
  spec_json: string;
  tokens_json: string;
  origin: 'generated' | 'saved';
  revision: number;
  updated_at: string;
};

const toStoredTheme = (row: ThemeRow): StoredTheme => ({
  id: row.id,
  name: row.name,
  summary: row.summary,
  specVersion: row.spec_version,
  spec: JSON.parse(row.spec_json) as ThemeSpec,
  tokens: JSON.parse(row.tokens_json) as DerivedTheme,
  origin: row.origin,
  revision: row.revision,
  updatedAt: row.updated_at,
});

const COLUMNS = 'id, name, summary, spec_version, spec_json, tokens_json, origin, revision, updated_at';

/**
 * Theme persistence.
 *
 * Both the authored spec and the derived tokens are stored. That redundancy is
 * the cheapest forward-compatibility available: when the spec schema gains a
 * field, every saved theme still renders pixel-identically from its cached
 * tokens, and specs migrate lazily on next edit. Without the cache, a schema
 * change silently restyles everything the user saved.
 */
export const themesRepository = {
  listThemes(): StoredTheme[] {
    const rows = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM generated_themes ORDER BY updated_at DESC`)
      .all() as ThemeRow[];
    return rows.map(toStoredTheme);
  },

  countThemes(): number {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS total FROM generated_themes')
      .get() as { total: number };
    return row.total;
  },

  getTheme(id: string): StoredTheme | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM generated_themes WHERE id = ?`)
      .get(id) as ThemeRow | undefined;
    return row ? toStoredTheme(row) : null;
  },

  saveTheme(theme: {
    id: string;
    spec: ThemeSpec;
    tokens: DerivedTheme;
    origin: 'generated' | 'saved';
  }): StoredTheme {
    getConnection().prepare(`
      INSERT INTO generated_themes (id, name, summary, spec_version, spec_json, tokens_json, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        summary = excluded.summary,
        spec_version = excluded.spec_version,
        spec_json = excluded.spec_json,
        tokens_json = excluded.tokens_json,
        origin = excluded.origin,
        revision = revision + 1,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      theme.id,
      theme.spec.name,
      theme.spec.summary,
      theme.spec.specVersion,
      JSON.stringify(theme.spec),
      JSON.stringify(theme.tokens),
      theme.origin,
    );

    return this.getTheme(theme.id) as StoredTheme;
  },

  deleteTheme(id: string): boolean {
    return getConnection().prepare('DELETE FROM generated_themes WHERE id = ?').run(id).changes > 0;
  },

  /**
   * Reads the theme bound to a scope.
   *
   * Bindings live in their own table rather than as a column on sessions
   * because they must be able to reference built-in presets, which have no
   * `generated_themes` row — a foreign key here would be wrong.
   */
  getBinding(scope: ThemeScope, scopeKey = ''): string | null {
    const row = getConnection()
      .prepare('SELECT theme_id FROM theme_bindings WHERE scope = ? AND scope_key = ?')
      .get(scope, scopeKey) as { theme_id: string } | undefined;
    return row?.theme_id ?? null;
  },

  setBinding(scope: ThemeScope, scopeKey: string, themeId: string): void {
    getConnection().prepare(`
      INSERT INTO theme_bindings (scope, scope_key, theme_id, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(scope, scope_key) DO UPDATE SET
        theme_id = excluded.theme_id,
        updated_at = CURRENT_TIMESTAMP
    `).run(scope, scopeKey, themeId);
  },

  clearBinding(scope: ThemeScope, scopeKey = ''): void {
    getConnection()
      .prepare('DELETE FROM theme_bindings WHERE scope = ? AND scope_key = ?')
      .run(scope, scopeKey);
  },
};
