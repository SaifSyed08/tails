import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TAILS_HOME } from '@/db/connection.js';
import {
  buildDefaultStates,
  DEFAULT_SPRITESHEET_NAME,
  findOutOfRangeStates,
  frameGridSchema,
  MAX_SPRITE_BYTES,
  PET_MANIFEST_NAME,
  petDefinitionSchema,
  petFileSchema,
  petIdSchema,
  petStatesSchema,
  spritePathSchema,
  type FrameGrid,
  type PetDefinition,
  type PetFile,
  type PetStates,
} from '@/modules/pets/pet-spec.js';
import { petsRepository, type PetSource } from '@/modules/pets/pets.repository.js';
import {
  createRemoteCatalogue,
  MAX_CATALOGUE_ENTRIES,
  type CatalogueResult,
} from '@/modules/pets/remote-catalogue.js';
import {
  inferFrameGrid,
  readImageSize,
  spriteContentType,
  type GridBasis,
} from '@/modules/pets/sprite-metrics.js';
import { AppError, readRecord, readString } from '@/shared/utils.js';

/**
 * Pet discovery, import and serving.
 *
 * Two sources, with very different rules:
 *
 * - `~/.codex/pets` belongs to Codex. We read it and never write to it, not
 *   even to save a corrected frame grid — those go to the database instead.
 * - `~/.tails/pets` is ours. Imports land here, and only pets here can be
 *   deleted, because deleting something another tool installed is not our call.
 */

/** Overridable so tests and sandboxes do not need a real home directory. */
const CODEX_PETS_DIR = process.env.TAILS_CODEX_PETS_DIR
  || path.join(os.homedir(), '.codex', 'pets');

/** Where imported pets are written. Under TAILS_HOME so it moves with the rest of our state. */
export const TAILS_PETS_DIR = path.join(TAILS_HOME, 'pets');

/**
 * How many pets may be installed.
 *
 * Rejecting at the cap rather than evicting, for the same reason the theme
 * service does: a loop that imports pets must not be able to fill the disk, and
 * a pet the user installed must not vanish to make room.
 */
const MAX_INSTALLED_PETS = 200;

/** Enough bytes for any image header we parse, without reading megabytes per pet. */
const HEADER_BYTES = 4096;

const catalogue = createRemoteCatalogue();

/** Where a pet's frame grid came from, so the UI never presents a guess as a fact. */
export type PetGridBasis = GridBasis;

export type InstalledPet = {
  definition: PetDefinition;
  source: PetSource;
  /** Absolute path on disk. Shown in the UI so "which pet is this?" is answerable. */
  directory: string;
  /** Same-origin URL the gallery animates. Never a `file://` path. */
  spriteUrl: string;
  /** Pixel size of the sheet, or null when the header could not be read. */
  spriteSize: { width: number; height: number } | null;
  gridBasis: PetGridBasis;
  /** True only for pets under `~/.tails/pets`. */
  removable: boolean;
  active: boolean;
  /** Non-fatal complaints — a mis-sized state range, a sheet we could not measure. */
  warnings: string[];
};

/** A pet folder that could not be loaded, reported instead of silently skipped. */
export type PetProblem = { directory: string; message: string };

export type PetLibrary = {
  pets: InstalledPet[];
  problems: PetProblem[];
  activePetId: string | null;
  sources: { codex: string; tails: string };
};

/** Formats validation failures the way the theme service does: dotted paths. */
const toValidationError = (
  message: string,
  issues: { path: PropertyKey[] | string; message: string }[],
): AppError => new AppError(message, {
  code: 'PET_INVALID',
  statusCode: 422,
  details: issues.map((issue) => ({
    path: Array.isArray(issue.path) ? issue.path.map(String).join('.') || 'root' : issue.path,
    message: issue.message,
  })),
});

/**
 * Resolves a path and proves it stayed inside its base directory.
 *
 * The load-bearing check for sprite serving. `spritesheetPath` comes out of a
 * JSON file that may have been downloaded from anywhere, so
 * `"../../../.ssh/id_rsa"` — or a symlink pointing there — must not become a
 * readable URL. Both the lexical path and, where the file exists, its realpath
 * are checked, because only the second catches symlinks.
 */
function resolveInside(baseDir: string, relativePath: string): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relativePath);
  const relative = path.relative(base, target);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('That sprite path points outside the pet folder.', {
      code: 'PET_PATH_ESCAPE',
      statusCode: 400,
      details: { requested: relativePath },
    });
  }

  return target;
}

/** Re-checks containment after symlinks are followed. Only meaningful once the file exists. */
function assertRealpathInside(baseDir: string, target: string): void {
  let realBase: string;
  let realTarget: string;

  try {
    realBase = fs.realpathSync(baseDir);
    realTarget = fs.realpathSync(target);
  } catch {
    // Nothing to follow: the lexical check already passed and a missing file is
    // reported by the caller as a missing sprite, not as an escape.
    return;
  }

  const relative = path.relative(realBase, realTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('That sprite path resolves outside the pet folder.', {
      code: 'PET_PATH_ESCAPE',
      statusCode: 400,
    });
  }
}

function readHeader(filePath: string): Buffer | null {
  let handle: number | null = null;
  try {
    handle = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(HEADER_BYTES);
    const read = fs.readSync(handle, buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

function listPetDirectories(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    // A missing source directory is the normal case for a fresh install.
    return [];
  }
}

/**
 * Reads one pet folder into a fully-resolved pet, or explains why it could not.
 *
 * Returns rather than throws, because one broken folder must not empty the
 * gallery — the caller collects these into `problems` and shows the rest.
 */
function loadPet(directory: string, source: PetSource): InstalledPet | PetProblem {
  const manifestPath = path.join(directory, PET_MANIFEST_NAME);

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return {
      directory,
      message: error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? `No ${PET_MANIFEST_NAME} in this folder.`
        : `Could not read ${PET_MANIFEST_NAME}: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }

  const file = petFileSchema.safeParse(raw);
  if (!file.success) {
    const first = file.error.issues[0];
    return {
      directory,
      message: `${PET_MANIFEST_NAME} is not a valid pet: ${first.path.map(String).join('.') || 'root'} — ${first.message}`,
    };
  }

  const warnings: string[] = [];
  const spritesheetPath = file.data.spritesheetPath ?? DEFAULT_SPRITESHEET_NAME;

  let spriteFile: string;
  try {
    spriteFile = resolveInside(directory, spritesheetPath);
    assertRealpathInside(directory, spriteFile);
  } catch (error) {
    return { directory, message: error instanceof AppError ? error.message : 'Bad sprite path.' };
  }

  if (!fs.existsSync(spriteFile)) {
    return { directory, message: `The spritesheet "${spritesheetPath}" is missing.` };
  }

  const header = readHeader(spriteFile);
  const size = header ? readImageSize(header) : null;
  if (!size) warnings.push('The spritesheet header could not be read, so the frame grid is a placeholder.');

  const inferred = size
    ? inferFrameGrid(size)
    : { basis: 'single-frame' as const, grid: { width: 64, height: 64, columns: 1, rows: 1, fps: 8 } };

  const override = petsRepository.getRecord(file.data.id);
  const grid: FrameGrid = override?.frame ?? file.data.frame ?? inferred.grid;
  const gridBasis: PetGridBasis = override?.frame || file.data.frame ? 'authored' : inferred.basis;

  let states: PetStates = override?.states ?? file.data.states ?? buildDefaultStates(grid);
  const outOfRange = findOutOfRangeStates(grid, states);
  if (outOfRange.length > 0) {
    warnings.push(`${outOfRange[0].message} Falling back to the default idle range.`);
    states = buildDefaultStates(grid);
  }

  const definition = petDefinitionSchema.safeParse({
    id: file.data.id,
    displayName: file.data.displayName,
    description: file.data.description ?? '',
    kind: file.data.kind,
    spriteVersionNumber: file.data.spriteVersionNumber,
    spritesheetPath,
    frame: grid,
    states,
    personality: file.data.personality,
    voice: file.data.voice,
  });

  if (!definition.success) {
    const first = definition.error.issues[0];
    return {
      directory,
      message: `This pet does not fit the schema: ${first.path.map(String).join('.') || 'root'} — ${first.message}`,
    };
  }

  return {
    definition: definition.data,
    source,
    directory,
    spriteUrl: `/api/pets/${encodeURIComponent(definition.data.id)}/sprite`,
    spriteSize: size ? { width: size.width, height: size.height } : null,
    gridBasis,
    removable: source === 'tails',
    active: false,
    warnings,
  };
}

const isProblem = (value: InstalledPet | PetProblem): value is PetProblem => 'message' in value;

/** Finds a pet folder by id, preferring our own copy over the Codex original. */
function locatePet(id: string): { directory: string; source: PetSource } | null {
  const parsed = petIdSchema.safeParse(id);
  if (!parsed.success) return null;

  const candidates: { directory: string; source: PetSource }[] = [
    { directory: resolveInside(TAILS_PETS_DIR, parsed.data), source: 'tails' },
    { directory: resolveInside(CODEX_PETS_DIR, parsed.data), source: 'codex' },
  ];

  return candidates.find((candidate) => fs.existsSync(path.join(candidate.directory, PET_MANIFEST_NAME)))
    ?? null;
}

function requirePet(id: string): InstalledPet {
  const located = locatePet(id);
  if (!located) {
    throw new AppError('That pet is not installed.', { code: 'PET_NOT_FOUND', statusCode: 404 });
  }

  const loaded = loadPet(located.directory, located.source);
  if (isProblem(loaded)) {
    throw new AppError(loaded.message, { code: 'PET_UNREADABLE', statusCode: 422 });
  }

  return { ...loaded, active: petsRepository.getActivePetId() === id };
}

/**
 * Writes a validated pet into `~/.tails/pets`.
 *
 * The single funnel for every import route, so a pet that arrived as an upload
 * and one that arrived as a folder path are byte-identical afterwards and have
 * both passed the same checks.
 */
function installPet(file: PetFile, spriteBytes: Buffer, spriteFileName: string): InstalledPet {
  if (petsRepository.countRecords() >= MAX_INSTALLED_PETS) {
    throw new AppError(
      `You already have ${MAX_INSTALLED_PETS} pets. Remove one before importing another.`,
      { code: 'PET_LIMIT_REACHED', statusCode: 409 },
    );
  }

  if (spriteBytes.byteLength > MAX_SPRITE_BYTES) {
    throw new AppError(
      `That spritesheet is ${(spriteBytes.byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_SPRITE_BYTES / 1024 / 1024} MB.`,
      { code: 'PET_SPRITE_TOO_LARGE', statusCode: 413 },
    );
  }

  const size = readImageSize(spriteBytes);
  if (!size) {
    throw new AppError('That file is not a WebP, PNG or GIF spritesheet.', {
      code: 'PET_SPRITE_UNREADABLE',
      statusCode: 422,
    });
  }

  const spriteName = spritePathSchema.safeParse(path.basename(spriteFileName));
  if (!spriteName.success) {
    throw toValidationError('The spritesheet filename is not usable.', spriteName.error.issues);
  }

  const grid = file.frame ?? inferFrameGrid(size).grid;
  const definition = petDefinitionSchema.safeParse({
    id: file.id,
    displayName: file.displayName,
    description: file.description ?? '',
    kind: file.kind,
    spriteVersionNumber: file.spriteVersionNumber,
    spritesheetPath: spriteName.data,
    frame: grid,
    states: file.states ?? buildDefaultStates(grid),
    personality: file.personality,
    voice: file.voice,
  });

  if (!definition.success) {
    throw toValidationError('That pet did not match the schema.', definition.error.issues);
  }

  const targetDir = resolveInside(TAILS_PETS_DIR, definition.data.id);
  if (fs.existsSync(targetDir)) {
    throw new AppError(`A pet called "${definition.data.id}" is already installed.`, {
      code: 'PET_ALREADY_INSTALLED',
      statusCode: 409,
    });
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, spriteName.data), spriteBytes);
  fs.writeFileSync(
    path.join(targetDir, PET_MANIFEST_NAME),
    `${JSON.stringify(definition.data, null, 2)}\n`,
    'utf8',
  );

  petsRepository.rememberPet({ id: definition.data.id, source: 'tails', directory: targetDir });
  return requirePet(definition.data.id);
}

/** Accepts raw base64 or a `data:` URL, because a browser file read produces the latter. */
function decodeImagePayload(value: string): Buffer {
  const base64 = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;

  // Checked before decoding so an oversized payload is rejected without
  // allocating it a second time.
  if (base64.length > (MAX_SPRITE_BYTES / 3) * 4 + 4) {
    throw new AppError(`That spritesheet is larger than ${MAX_SPRITE_BYTES / 1024 / 1024} MB.`, {
      code: 'PET_SPRITE_TOO_LARGE',
      statusCode: 413,
    });
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.byteLength === 0) {
    throw new AppError('The spritesheet upload was empty.', {
      code: 'PET_SPRITE_EMPTY',
      statusCode: 400,
    });
  }
  return bytes;
}

export const petsService = {
  /**
   * Everything installed, from both sources.
   *
   * Our own copy of an id shadows the Codex one: importing a Codex pet is how
   * a user gets a version they can edit and delete, and after doing so they
   * should see one pet, not two.
   */
  listPets(): PetLibrary {
    const found = [
      ...listPetDirectories(CODEX_PETS_DIR).map((dir) => loadPet(dir, 'codex')),
      ...listPetDirectories(TAILS_PETS_DIR).map((dir) => loadPet(dir, 'tails')),
    ];

    const problems = found.filter(isProblem);
    const byId = new Map<string, InstalledPet>();

    for (const pet of found) {
      if (isProblem(pet)) continue;
      const existing = byId.get(pet.definition.id);
      if (existing && existing.source === 'tails') continue;
      byId.set(pet.definition.id, pet);
    }

    for (const pet of byId.values()) {
      petsRepository.rememberPet({
        id: pet.definition.id,
        source: pet.source,
        directory: pet.directory,
      });
    }

    // A pet can be deleted from disk by hand; a dangling activation would then
    // report an active pet that cannot render.
    const storedActive = petsRepository.getActivePetId();
    const activePetId = storedActive && byId.has(storedActive) ? storedActive : null;
    if (storedActive && !activePetId) petsRepository.setActivePetId(null);

    const pets = [...byId.values()]
      .map((pet) => ({ ...pet, active: pet.definition.id === activePetId }))
      .sort((left, right) => left.definition.displayName.localeCompare(right.definition.displayName));

    return {
      pets,
      problems,
      activePetId,
      sources: { codex: CODEX_PETS_DIR, tails: TAILS_PETS_DIR },
    };
  },

  getPet(id: string): InstalledPet {
    return requirePet(id);
  },

  /**
   * Imports from a folder on disk or from an uploaded manifest plus image.
   *
   * One entry point rather than two routes because both end in the same
   * validation and the same directory; splitting them would mean two places to
   * forget a check.
   */
  importPet(body: unknown): InstalledPet {
    const input = readRecord(body);
    if (!input) {
      throw new AppError('Send either a folder path or a pet definition and image.', {
        code: 'PET_IMPORT_EMPTY',
        statusCode: 400,
      });
    }

    const sourcePath = readString(input.path);
    if (sourcePath) return this.importFromPath(sourcePath);

    const image = readRecord(input.image);
    const payload = image && readString(image.data);
    if (!image || !payload) {
      throw new AppError('Send either a folder path or a pet definition and image.', {
        code: 'PET_IMPORT_EMPTY',
        statusCode: 400,
      });
    }

    const file = petFileSchema.safeParse(input.definition);
    if (!file.success) {
      throw toValidationError('That pet.json did not match the schema.', file.error.issues);
    }

    const fileName = readString(image.fileName)
      ?? file.data.spritesheetPath
      ?? DEFAULT_SPRITESHEET_NAME;

    return installPet(file.data, decodeImagePayload(payload), fileName);
  },

  /**
   * Copies a pet folder from anywhere on disk into `~/.tails/pets`.
   *
   * A copy rather than a reference: a pet that lives outside our directory
   * would break the moment the user moved it, and importing a Codex pet is
   * specifically how they get one they are allowed to modify.
   */
  importFromPath(inputPath: string): InstalledPet {
    const resolved = path.resolve(inputPath.replace(/^["']|["']$/g, ''));
    const directory = path.basename(resolved) === PET_MANIFEST_NAME ? path.dirname(resolved) : resolved;

    if (!fs.existsSync(path.join(directory, PET_MANIFEST_NAME))) {
      throw new AppError(`No ${PET_MANIFEST_NAME} found in "${directory}".`, {
        code: 'PET_MANIFEST_NOT_FOUND',
        statusCode: 404,
      });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(directory, PET_MANIFEST_NAME), 'utf8'));
    } catch (error) {
      throw new AppError(
        `That ${PET_MANIFEST_NAME} is not valid JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
        { code: 'PET_MANIFEST_INVALID', statusCode: 422 },
      );
    }

    const file = petFileSchema.safeParse(raw);
    if (!file.success) {
      throw toValidationError(`That ${PET_MANIFEST_NAME} did not match the schema.`, file.error.issues);
    }

    const spritesheetPath = file.data.spritesheetPath ?? DEFAULT_SPRITESHEET_NAME;
    const spriteFile = resolveInside(directory, spritesheetPath);
    assertRealpathInside(directory, spriteFile);

    if (!fs.existsSync(spriteFile)) {
      throw new AppError(`The spritesheet "${spritesheetPath}" is missing from that folder.`, {
        code: 'PET_SPRITE_NOT_FOUND',
        statusCode: 404,
      });
    }

    const stats = fs.statSync(spriteFile);
    if (stats.size > MAX_SPRITE_BYTES) {
      throw new AppError(
        `That spritesheet is ${(stats.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_SPRITE_BYTES / 1024 / 1024} MB.`,
        { code: 'PET_SPRITE_TOO_LARGE', statusCode: 413 },
      );
    }

    return installPet(file.data, fs.readFileSync(spriteFile), path.basename(spriteFile));
  },

  /**
   * Saves a corrected frame grid or state ranges.
   *
   * Always to the database, never to the manifest — the pet may be a Codex one,
   * and having one code path means the read side only has to know about one
   * override mechanism.
   */
  updatePet(id: string, body: unknown): InstalledPet {
    const pet = requirePet(id);
    const input = readRecord(body);
    if (!input) {
      throw new AppError('Send a frame grid or state ranges to change.', {
        code: 'PET_UPDATE_EMPTY',
        statusCode: 400,
      });
    }

    const frame = input.frame === undefined ? undefined : frameGridSchema.safeParse(input.frame);
    if (frame && !frame.success) {
      throw toValidationError('That frame grid is not valid.', frame.error.issues);
    }

    const states = input.states === undefined ? undefined : petStatesSchema.safeParse(input.states);
    if (states && !states.success) {
      throw toValidationError('Those animation states are not valid.', states.error.issues);
    }

    const nextGrid = frame?.data ?? pet.definition.frame;
    const nextStates = states?.data ?? pet.definition.states;
    const outOfRange = findOutOfRangeStates(nextGrid, nextStates);
    if (outOfRange.length > 0) {
      throw toValidationError('Those frame ranges do not fit the grid.', outOfRange);
    }

    petsRepository.rememberPet({ id: pet.definition.id, source: pet.source, directory: pet.directory });
    petsRepository.saveCustomisation(pet.definition.id, { frame: frame?.data, states: states?.data });
    return requirePet(id);
  },

  /** Sets — or with a null id, clears — the pet the app shows. */
  setActivePet(id: string | null): { activePetId: string | null } {
    if (id === null) {
      petsRepository.setActivePetId(null);
      return { activePetId: null };
    }

    const pet = requirePet(id);
    petsRepository.setActivePetId(pet.definition.id);
    return { activePetId: pet.definition.id };
  },

  /**
   * Deletes a pet we installed.
   *
   * Refuses for Codex pets by design: `~/.codex/pets` is another tool's data,
   * and "remove from my gallery" is not a good enough reason to delete files we
   * did not create.
   */
  removePet(id: string): { id: string } {
    const pet = requirePet(id);

    if (pet.source !== 'tails') {
      throw new AppError(
        `"${pet.definition.displayName}" was installed by Codex, so T.A.I.L.S. will not delete it. Remove it from ${pet.directory} yourself if you want it gone.`,
        { code: 'PET_NOT_REMOVABLE', statusCode: 403 },
      );
    }

    // Belt and braces before an rm -rf: prove the directory is ours.
    const target = resolveInside(TAILS_PETS_DIR, pet.definition.id);
    assertRealpathInside(TAILS_PETS_DIR, target);
    fs.rmSync(target, { recursive: true, force: true });

    petsRepository.forgetPet(pet.definition.id);
    if (petsRepository.getActivePetId() === pet.definition.id) petsRepository.setActivePetId(null);

    return { id: pet.definition.id };
  },

  /**
   * Locates a pet's sprite file for streaming.
   *
   * Returns a path rather than bytes so the route can stream it; the safety
   * checks happen here so no caller can reach a file by skipping them.
   */
  resolveSprite(id: string): { filePath: string; contentType: string; byteLength: number } {
    const pet = requirePet(id);
    const filePath = resolveInside(pet.directory, pet.definition.spritesheetPath);
    assertRealpathInside(pet.directory, filePath);

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      throw new AppError('That sprite is not a file.', { code: 'PET_SPRITE_INVALID', statusCode: 422 });
    }

    return {
      filePath,
      contentType: spriteContentType(pet.definition.spritesheetPath),
      byteLength: stats.size,
    };
  },

  /** The remote library, or an honest "not configured". See remote-catalogue.ts. */
  listRemoteCatalogue(limit = MAX_CATALOGUE_ENTRIES): Promise<CatalogueResult> {
    return catalogue.listTopPets(limit);
  },
};
