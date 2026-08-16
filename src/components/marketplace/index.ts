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

/**
 * Drawing a pet. Three sizes of the same idea:
 *
 * - `PetSprite` — a pet at a size, playing a state, facing a direction. Start here.
 * - `PetThumbnail` — one still frame, for rows and pickers.
 * - `PetStage` — an animated pet in its lit box, with an optional glow.
 *
 * `SpritePreview` is the layer underneath, for a surface that needs its own
 * framing. Whatever you use, `SPRITE_KEYFRAMES` must be rendered once somewhere
 * in the tree or nothing animates.
 */
/** The pet strip for the sidebar: a row of faces, ordered starred-then-recent. */
export { PetCarousel } from './PetCarousel';
export type { PetCarouselProps } from './PetCarousel';

export { PetSprite } from './PetSprite';
export type { PetFacing } from './PetSprite';
export { PetThumbnail } from './PetThumbnail';
export { PetStage } from './PetStage';
export { SpritePreview, SPRITE_KEYFRAMES } from './SpritePreview';
export { frameOffset, resolveCellBox } from './sprite-geometry';
export type { CellBox, SpriteGrid } from './sprite-geometry';

/** Dragging a pet onto something. The drop target reads these; see `pet-drag.ts`. */
export { endPetDrag, isPetDrag, readPetDrag, startPetDrag, usePetDrag, PET_DRAG_MIME } from './pet-drag';
export type { PetDragPayload } from './pet-drag';

/** The always-on-top desktop pet, for the in-window handoff. */
export {
  hasDesktopPet,
  hideDesktopPet,
  refreshDesktopPet,
  suppressDesktopPet,
} from './desktop-pet';

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
