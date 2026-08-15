/**
 * The pets marketplace module.
 *
 * A barrel so the rest of the server mounts one thing and imports one path.
 * `PETS_SCHEMA_SQL` and `ensurePetsSchema` are re-exported here specifically so
 * that moving the DDL into `db/connection.ts` later is an import plus a
 * template-literal interpolation, with nothing else to find.
 */

export { createPetsRouter } from '@/modules/pets/pets.routes.js';
export { petsService, TAILS_PETS_DIR } from '@/modules/pets/pets.service.js';
export type { InstalledPet, PetLibrary, PetProblem, PetGridBasis } from '@/modules/pets/pets.service.js';
export { ensurePetsSchema, PETS_SCHEMA_SQL, petsRepository } from '@/modules/pets/pets.repository.js';
export type { PetSource } from '@/modules/pets/pets.repository.js';
export {
  buildDefaultStates,
  frameGridSchema,
  petDefinitionSchema,
  petStatesSchema,
  PET_STATE_NAMES,
} from '@/modules/pets/pet-spec.js';
export type {
  FrameGrid,
  FrameRange,
  PetDefinition,
  PetStateName,
  PetStates,
} from '@/modules/pets/pet-spec.js';
export { createRemoteCatalogue } from '@/modules/pets/remote-catalogue.js';
export type { CatalogueEntry, CatalogueResult, PetCatalogue } from '@/modules/pets/remote-catalogue.js';
export { CODEX_SPRITE_CELL, inferFrameGrid, readImageSize } from '@/modules/pets/sprite-metrics.js';
export type { GridBasis, GridInference, ImageSize } from '@/modules/pets/sprite-metrics.js';
