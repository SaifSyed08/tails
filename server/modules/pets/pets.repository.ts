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

/** Applies the pets schema to a connection. Idempotent. */
export function ensurePetsSchema(database: Database.Database): void {
  database.exec(PETS_SCHEMA_SQL);
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
};

type InstalledPetRow = {
  id: string;
  source: PetSource;
  directory: string;
  frame_json: string | null;
  states_json: string | null;
  installed_at: string;
  updated_at: string;
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
});

const COLUMNS = 'id, source, directory, frame_json, states_json, installed_at, updated_at';

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
