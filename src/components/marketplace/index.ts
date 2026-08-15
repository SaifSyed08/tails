/**
 * What the rest of the app may use from the marketplace.
 *
 * A barrel so other surfaces import one path and, more importantly, so there is
 * exactly one implementation of "draw a pet". Anything cropping a frame out of
 * a spritesheet by hand is a copy of a bug waiting to diverge — the one-frame
 * flicker was fixed once, in `SpritePreview`, and everything below inherits it.
 *
 * - `PetThumbnail` — a still frame. Pickers, rows, headers.
 * - `PetStage` — the animated pet in its lit box. Cards, spotlights, anywhere
 *   the pet should be alive.
 * - `SpritePreview` + `SPRITE_KEYFRAMES` — the animation itself, for a surface
 *   that needs its own framing. The keyframes must be rendered once, anywhere
 *   in the tree, or nothing animates.
 * - `petsApi.resolveDisplayPet` — which pet belongs on screen for a
 *   conversation, `session.petId ?? activePetId`, dangling references included.
 */

export { MarketplacePage } from './MarketplacePage';
export type { MarketplacePageProps } from './MarketplacePage';

export { PetThumbnail } from './PetThumbnail';
export { PetStage } from './PetStage';
export { SpritePreview, SPRITE_KEYFRAMES } from './SpritePreview';

export { petsApi } from './marketplace-api';
export type {
  CatalogueEntry,
  CataloguePage,
  DisplayPet,
  FrameGrid,
  FrameRange,
  InstalledPet,
  PetDefinition,
  PetLibrary,
  PetStateName,
  PetStates,
} from './marketplace-api';
