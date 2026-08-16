import assert from 'node:assert/strict';
import test from 'node:test';

// The ordering rule is client-side — it decides what a strip of icons looks
// like — but it is pure and this repository has one test runner, which globs
// `server/**`. Same arrangement as the sprite geometry, and for the same
// reason: the rule is worth covering and the module has no imports to drag in.
import {
  isUntried,
  orderForCarousel,
} from '../../../../src/components/marketplace/pet-filters.js';
import type { InstalledPet } from '../../../../src/components/marketplace/marketplace-api.js';

/** Only the fields the ordering reads; the rest of a pet is irrelevant here. */
const pet = (
  id: string,
  options: { starred?: boolean; lastUsedAt?: string | null; displayName?: string } = {},
): InstalledPet => ({
  definition: { displayName: options.displayName ?? id, id },
  starred: options.starred ?? false,
  lastUsedAt: options.lastUsedAt ?? null,
} as InstalledPet);

/**
 * What the strip is ordered by.
 *
 * The question it answers is "what am I likely to reach for", and the three
 * tiers are the three honest answers: the ones the user pinned, the ones they
 * have been using, and everything else in an order that at least holds still.
 */
test('the carousel puts starred pets first, then the most recently used', () => {
  const ordered = orderForCarousel([
    pet('never-used'),
    pet('yesterday', { lastUsedAt: '2026-08-14T10:00:00.000Z' }),
    pet('starred-old', { starred: true, lastUsedAt: '2026-01-01T10:00:00.000Z' }),
    pet('today', { lastUsedAt: '2026-08-15T10:00:00.000Z' }),
    pet('starred-new', { starred: true, lastUsedAt: '2026-08-15T11:00:00.000Z' }),
  ]);

  assert.deepEqual(ordered.map((entry) => entry.definition.id), [
    'starred-new',
    'starred-old',
    'today',
    'yesterday',
    'never-used',
  ]);
});

test('a pet nobody has tried sorts last, not first', () => {
  // It gets a dot instead. Putting an untried pet where the muscle memory for
  // "my usual pet" lives would move the one the user actually wants.
  const ordered = orderForCarousel([
    pet('fresh'),
    pet('used', { lastUsedAt: '2026-08-01T10:00:00.000Z' }),
  ]);

  assert.deepEqual(ordered.map((entry) => entry.definition.id), ['used', 'fresh']);
  assert.equal(isUntried(ordered[1]), true);
  assert.equal(isUntried(ordered[0]), false);
});

test('pets that tie fall back to their name, so the strip never reshuffles', () => {
  const ordered = orderForCarousel([pet('c'), pet('a'), pet('b')]);
  assert.deepEqual(ordered.map((entry) => entry.definition.id), ['a', 'b', 'c']);

  // Ordering is a pure function of the input, not of the array it was given.
  const again = orderForCarousel([pet('b'), pet('c'), pet('a')]);
  assert.deepEqual(again.map((entry) => entry.definition.id), ['a', 'b', 'c']);
});
