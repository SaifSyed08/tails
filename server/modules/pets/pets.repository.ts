import type Database from 'better-sqlite3';

import { getConnection } from '@/db/connection.js';
import type { FrameGrid, PetStates } from '@/modules/pets/pet-spec.js';

/**
 * Persistence for pet state that cannot live next to the sprite.
 *
 * The pets themselves are files on disk — that is what makes them shareable —
 * so the database holds only what a folder cannot: which pet is active, and the
 * corrections a user made to a pet they do not own.
 *
 * That second one is the reason this table exists at all. Codex pets live in
 * `~/.codex/pets`, which belongs to another tool and is strictly read-only to
 * us. When the user fixes a mis-inferred frame grid on a Codex pet, the fix has
 * to go somewhere; writing it back into the manifest would mean editing another
 * program's files. So overrides are stored here and layered over the on-disk
 * definition at read time.
 */

/**
 * The pets schema.
 *
 * Exported so `db/connection.ts` can own the DDL if that is ever preferred:
 * adding `import { PETS_SCHEMA_SQL } ...` and appending it to `SCHEMA_SQL`
 * there is a one-line change. Until then `ensurePetsSchema` applies it on
 * first use, which keeps the module self-contained and keeps connection.ts
 * unaware of a feature it does not need to know about.
 *
 * Every statement is `IF NOT EXISTS`, matching the convention in connection.ts,
 * so applying it twice is free.
 */
export const PETS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS installed_pets (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('codex', 'tails')),
  directory TEXT NOT NULL,
  frame_json TEXT,
  states_json TEXT,
  installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS active_pet (
  scope TEXT PRIMARY KEY CHECK (scope IN ('global')),
  pet_id TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * Columns added after the table shipped.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op once the table exists, so a column
 * added to the DDL above never reaches a database created before it. Applied
 * here rather than in `db/connection.ts` so the pets module keeps owning its
 * own schema.
 */
const ADDED_COLUMNS: { name: string; definition: string }[] = [
  { name: 'hidden_at', definition: 'DATETIME' },
  { name: 'assigned_theme', definition: 'TEXT' },
  { name: 'thinking_phrases_json', definition: 'TEXT' },
  { name: 'starred_at', definition: 'DATETIME' },
  { name: 'last_used_at', definition: 'DATETIME' },
];

/** Applies the pets schema to a connection. Idempotent. */
export function ensurePetsSchema(database: Database.Database): void {
  database.exec(PETS_SCHEMA_SQL);

  const existing = new Set(
    (database.prepare('PRAGMA table_info(installed_pets)').all() as { name: string }[])
      .map((column) => column.name),
  );

  for (const column of ADDED_COLUMNS) {
    if (existing.has(column.name)) continue;
    database.exec(`ALTER TABLE installed_pets ADD COLUMN ${column.name} ${column.definition}`);
  }
}

/**
 * The one scope pets currently support.
 *
 * A column rather than a bare single-row table because per-session pets are the
 * obvious next request, and widening a CHECK constraint is cheaper than
 * inventing a key column after the fact.
 */
const GLOBAL_SCOPE = 'global';

/**
 * Tracked per connection, not per process, so a test that closes and reopens
 * the database still gets its tables.
 */
let schemaAppliedTo: Database.Database | null = null;

function db(): Database.Database {
  const connection = getConnection();
  if (schemaAppliedTo !== connection) {
    ensurePetsSchema(connection);
    schemaAppliedTo = connection;
  }
  return connection;
}

export type PetSource = 'codex' | 'tails';

/**
 * A row of remembered state for one pet.
 *
 * `frame` and `states` are null when the user has never corrected anything, in
 * which case the on-disk manifest and the inferred grid are used as-is.
 */
export type InstalledPetRecord = {
  id: string;
  source: PetSource;
  directory: string;
  frame: FrameGrid | null;
  states: PetStates | null;
  installedAt: string;
  updatedAt: string;
  /**
   * When the user hid this pet from their library, if they did.
   *
   * Hiding exists because `~/.codex/pets` is another tool's directory: a pet
   * installed there cannot be deleted, and "I do not want this one in my
   * library" still has to mean something. It is our listing, so it is ours to
   * leave a pet out of.
   */
  hiddenAt: string | null;
  /**
   * A theme id the pet brings with it, or null.
   *
   * Stored here rather than in `pet.json` for the same reason the frame
   * overrides are: most pets live in `~/.codex/pets`, which belongs to another
   * tool. Held as an opaque string — the appearance module owns what theme ids
   * mean, and one that no longer exists resolves to "no theme" rather than to
   * an error.
   */
  assignedTheme: string | null;
  /** Things the pet says while it is thinking. Plain text, always. */
  thinkingPhrases: string[] | null;
  /** When the user starred it, if they did. Starred pets lead the carousel. */
  starredAt: string | null;
  /**
   * When this pet was last put on screen.
   *
   * Null means never — which is what the carousel's "new" dot marks. It is a
   * separate fact from `installedAt`: a pet can sit in the library for weeks
   * before anyone tries it.
   */
  lastUsedAt: string | null;
};

type InstalledPetRow = {
  id: string;
  source: PetSource;
  directory: string;
  frame_json: string | null;
  states_json: string | null;
  installed_at: string;
  updated_at: string;
  hidden_at: string | null;
  assigned_theme: string | null;
  thinking_phrases_json: string | null;
  starred_at: string | null;
  last_used_at: string | null;
};

/**
 * Tolerates a corrupt JSON blob by falling back to "no override".
 *
 * A hand-edited or half-written row must not make the whole gallery fail to
 * load; losing one correction is recoverable, losing the pet list is not.
 */
function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const toRecord = (row: InstalledPetRow): InstalledPetRecord => ({
  id: row.id,
  source: row.source,
  directory: row.directory,
  frame: parseJson<FrameGrid>(row.frame_json),
  states: parseJson<PetStates>(row.states_json),
  installedAt: row.installed_at,
  updatedAt: row.updated_at,
  hiddenAt: row.hidden_at,
  assignedTheme: row.assigned_theme,
  thinkingPhrases: parseJson<string[]>(row.thinking_phrases_json),
  starredAt: row.starred_at,
  lastUsedAt: row.last_used_at,
});

const COLUMNS = 'id, source, directory, frame_json, states_json, installed_at, updated_at, '
  + 'hidden_at, assigned_theme, thinking_phrases_json, starred_at, last_used_at';

export const petsRepository = {
  listRecords(): InstalledPetRecord[] {
    const rows = db()
      .prepare(`SELECT ${COLUMNS} FROM installed_pets`)
      .all() as InstalledPetRow[];
    return rows.map(toRecord);
  },

  getRecord(id: string): InstalledPetRecord | null {
    const row = db()
      .prepare(`SELECT ${COLUMNS} FROM installed_pets WHERE id = ?`)
      .get(id) as InstalledPetRow | undefined;
    return row ? toRecord(row) : null;
  },

  countRecords(): number {
    const row = db().prepare('SELECT COUNT(*) AS total FROM installed_pets').get() as { total: number };
    return row.total;
  },

  /**
   * Records that a pet exists at a location, without touching its overrides.
   *
   * Called during discovery for pets found on disk, which is why the update
   * branch deliberately leaves `frame_json` and `states_json` alone: a rescan
   * must never wipe a correction the user made.
   */
  rememberPet(input: { id: string; source: PetSource; directory: string }): void {
    db().prepare(`
      INSERT INTO installed_pets (id, source, directory)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        directory = excluded.directory,
        updated_at = CURRENT_TIMESTAMP
    `).run(input.id, input.source, input.directory);
  },

  /** Stores a user's frame-grid / state corrections for a pet. */
  saveCustomisation(id: string, input: { frame?: FrameGrid; states?: PetStates }): void {
    db().prepare(`
      UPDATE installed_pets
      SET frame_json = COALESCE(?, frame_json),
          states_json = COALESCE(?, states_json),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      input.frame ? JSON.stringify(input.frame) : null,
      input.states ? JSON.stringify(input.states) : null,
      id,
    );
  },

  /**
   * Stores the pet's own preferences: the look it brings, and what it says.
   *
   * `undefined` leaves a field alone; `null` clears it. Without that
   * distinction "save the phrases" would have to also re-send the theme, and a
   * form that forgets one field would silently wipe the other.
   */
  savePreferences(
    id: string,
    input: { assignedTheme?: string | null; thinkingPhrases?: string[] | null },
  ): void {
    db().prepare(`
      UPDATE installed_pets
      SET assigned_theme = CASE WHEN ? THEN ? ELSE assigned_theme END,
          thinking_phrases_json = CASE WHEN ? THEN ? ELSE thinking_phrases_json END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      input.assignedTheme === undefined ? 0 : 1,
      input.assignedTheme ?? null,
      input.thinkingPhrases === undefined ? 0 : 1,
      input.thinkingPhrases ? JSON.stringify(input.thinkingPhrases) : null,
      id,
    );
  },

  /** Stars a pet, or unstars it. Starred pets come first in the carousel. */
  setStarred(id: string, starred: boolean): void {
    db().prepare(`
      UPDATE installed_pets
      SET starred_at = ${starred ? 'CURRENT_TIMESTAMP' : 'NULL'},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  },

  /**
   * Records that a pet has been put on screen.
   *
   * Drives both the carousel's ordering and its "not tried yet" dot, so it is
   * written whenever a pet is actually chosen — activated globally, or given to
   * a conversation — and never on mere discovery.
   */
  markUsed(id: string): void {
    db().prepare(`
      UPDATE installed_pets
      SET last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  },

  /**
   * Hides a pet from the library, or brings it back.
   *
   * Deliberately separate from `forgetPet`: forgetting is for a pet whose files
   * are gone, hiding is for one that is still on disk and must stay there.
   * Inserts nothing — a pet is always remembered before it can be hidden.
   */
  setHidden(id: string, hidden: boolean): void {
    db().prepare(`
      UPDATE installed_pets
      SET hidden_at = ${hidden ? 'CURRENT_TIMESTAMP' : 'NULL'},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  },

  forgetPet(id: string): void {
    db().prepare('DELETE FROM installed_pets WHERE id = ?').run(id);
  },

  getActivePetId(): string | null {
    const row = db()
      .prepare('SELECT pet_id FROM active_pet WHERE scope = ?')
      .get(GLOBAL_SCOPE) as { pet_id: string | null } | undefined;
    return row?.pet_id ?? null;
  },

  setActivePetId(petId: string | null): void {
    db().prepare(`
      INSERT INTO active_pet (scope, pet_id, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(scope) DO UPDATE SET
        pet_id = excluded.pet_id,
        updated_at = CURRENT_TIMESTAMP
    `).run(GLOBAL_SCOPE, petId);
  },
};
