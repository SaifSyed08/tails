import type { InstalledPet, PetGridBasis } from './marketplace-api';

/**
 * Browsing rules for the storefront.
 *
 * Pure functions in their own file because searching, filtering and sorting are
 * the parts of a shop that are easy to get subtly wrong — a sort that is not
 * stable, a filter that hides the active pet — and none of that is worth
 * re-reading a component tree to check.
 *
 * Every field these read is one the pet actually has. There is no rating, no
 * download count and no popularity order here, because nothing on disk or in
 * the (still unconfirmed) remote catalogue supplies them.
 */

/** Cells in the sheet. The honest answer to "how much animation is in here". */
export const frameCount = (pet: InstalledPet): number =>
  pet.definition.frame.columns * pet.definition.frame.rows;

export type SourceFilter = 'all' | 'tails' | 'codex';

export type SortOrder = 'name' | 'recent' | 'frames';

/**
 * The shelves.
 *
 * "Yours" and "From Codex" is the installed-vs-available line that matters
 * here: both are usable, but only the ones under `~/.tails/pets` can be edited
 * or deleted, so which shelf a pet is on decides what the user can do with it.
 */
export const SOURCE_FILTERS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'tails', label: 'Yours' },
  { value: 'codex', label: 'From Codex' },
];

export const SORT_ORDERS: { value: SortOrder; label: string }[] = [
  { value: 'name', label: 'Name A–Z' },
  { value: 'recent', label: 'Recently added' },
  { value: 'frames', label: 'Most frames' },
];

export const SOURCE_LABEL: Record<InstalledPet['source'], string> = {
  codex: 'from codex',
  tails: 'yours',
};

/** What each inference tier means, in words a user can act on. */
export const GRID_BASIS_NOTE: Record<PetGridBasis, string> = {
  authored: 'Layout set by you or declared by the pet file.',
  'codex-cell-pitch': 'Layout inferred from the 192x208 cell pitch used by Codex pets.',
  'square-cells': 'Layout guessed as square cells — worth checking.',
  'single-frame': 'Layout could not be worked out, so the whole sheet is one frame.',
};

/** True for the two tiers that are guesses rather than statements of fact. */
export const isGridUncertain = (basis: PetGridBasis): boolean =>
  basis === 'square-cells' || basis === 'single-frame';

export function collectKinds(pets: InstalledPet[]): string[] {
  const kinds = new Set<string>();
  for (const pet of pets) {
    if (pet.definition.kind) kinds.add(pet.definition.kind);
  }
  return [...kinds].sort((left, right) => left.localeCompare(right));
}

export function countBySource(pets: InstalledPet[], source: SourceFilter): number {
  return source === 'all' ? pets.length : pets.filter((pet) => pet.source === source).length;
}

export type PetQuery = {
  query: string;
  source: SourceFilter;
  kind: string | null;
};

/**
 * Matches a pet against typed text.
 *
 * Substring rather than fuzzy: a library this size is browsed, not searched
 * blind, and fuzzy matching in a small set mostly produces surprising hits.
 */
function matchesQuery(pet: InstalledPet, needle: string): boolean {
  const { definition } = pet;
  return [definition.displayName, definition.id, definition.description, definition.kind, definition.author]
    .some((field) => field?.toLowerCase().includes(needle));
}

export function filterPets(pets: InstalledPet[], { query, source, kind }: PetQuery): InstalledPet[] {
  const needle = query.trim().toLowerCase();

  return pets.filter((pet) => {
    if (source !== 'all' && pet.source !== source) return false;
    if (kind && pet.definition.kind !== kind) return false;
    return needle === '' || matchesQuery(pet, needle);
  });
}

/**
 * Orders a shelf.
 *
 * Every comparator falls back to the name so the grid never reshuffles between
 * renders: pets with no recorded install date, or with the same frame count,
 * are common enough that an unstable tail would be visible.
 */
export function sortPets(pets: InstalledPet[], order: SortOrder): InstalledPet[] {
  const byName = (left: InstalledPet, right: InstalledPet) =>
    left.definition.displayName.localeCompare(right.definition.displayName);

  return [...pets].sort((left, right) => {
    if (order === 'frames') return frameCount(right) - frameCount(left) || byName(left, right);
    if (order === 'recent') {
      // Nulls last: an unrecorded date is unknown, not old.
      if (left.installedAt === right.installedAt) return byName(left, right);
      if (!left.installedAt) return 1;
      if (!right.installedAt) return -1;
      return right.installedAt.localeCompare(left.installedAt);
    }
    return byName(left, right);
  });
}

/** "8x11 grid of 192x208 px cells" — the sentence the frame editor edits. */
export function describeGrid(pet: InstalledPet): string {
  const { frame } = pet.definition;
  return `${frame.columns}x${frame.rows} grid of ${frame.width}x${frame.height} px cells`;
}

export function formatAdded(installedAt: string | null): string | null {
  if (!installedAt) return null;
  const date = new Date(installedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The order pets appear in the carousel.
 *
 * Starred first, then whatever was used most recently, then everything else by
 * name. The rule is "what am I likely to reach for", and the three tiers are
 * the three answers: the ones I chose to keep, the ones I have been using, and
 * the rest in an order that at least does not move about.
 *
 * Never-used pets sort after used ones rather than first: a pet nobody has
 * tried is marked with a dot, which is a better way to say "new" than putting
 * it where the muscle memory for "my usual pet" lives.
 */
export function orderForCarousel(pets: InstalledPet[]): InstalledPet[] {
  return [...pets].sort((left, right) => {
    if (left.starred !== right.starred) return left.starred ? -1 : 1;

    if (left.lastUsedAt !== right.lastUsedAt) {
      if (!left.lastUsedAt) return 1;
      if (!right.lastUsedAt) return -1;
      return right.lastUsedAt.localeCompare(left.lastUsedAt);
    }

    return left.definition.displayName.localeCompare(right.definition.displayName);
  });
}

/** A pet nobody has put on screen yet. The carousel marks these with a dot. */
export const isUntried = (pet: InstalledPet): boolean => pet.lastUsedAt === null;
