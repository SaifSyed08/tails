import { z } from 'zod';

/**
 * The remote pet library.
 *
 * ## Status: the real endpoint is unknown
 *
 * The eventual goal is to browse codex-pet.net's library — or at least its top
 * 100 pets by view count — and install from it. **No public API for that site
 * has been confirmed**, so nothing here is written against a real contract.
 *
 * Rather than hardcode a plausible-looking URL and ship a feature that fails in
 * a way nobody can debug, this module:
 *
 * - takes its base URL from `TAILS_PET_CATALOGUE_URL` and does nothing at all
 *   when that is unset, reporting `configured: false` so the UI can say so;
 * - keeps the entire remote surface behind `PetCatalogue`, so pointing it at
 *   the real API later means editing this one file;
 * - validates every response, because a catalogue is untrusted input and its
 *   `id` values end up as directory names.
 *
 * The request shape below (`GET {base}/pets?sort=views&limit=N`) is a
 * placeholder chosen to be readable, **not** a documented endpoint. Confirm it
 * before relying on it.
 */

/** One installable pet as advertised by a remote catalogue. */
export type CatalogueEntry = {
  id: string;
  displayName: string;
  description: string;
  /** Absolute URL of a preview image, if the catalogue offers one. */
  previewUrl: string | null;
  /** Absolute URL the importer would fetch. */
  downloadUrl: string | null;
  /** View count, when the catalogue reports it — this is what "top 100" sorts by. */
  views: number | null;
};

/**
 * What the UI receives.
 *
 * `configured` is separate from `entries.length` on purpose: "no catalogue is
 * set up" and "the catalogue returned nothing" are different situations and
 * deserve different words on screen.
 */
export type CatalogueResult = {
  configured: boolean;
  baseUrl: string | null;
  entries: CatalogueEntry[];
  /** Set when a configured catalogue could not be read. Never thrown — a dead remote must not break the local gallery. */
  error: string | null;
};

/**
 * The seam a real implementation plugs into.
 *
 * Deliberately one method: everything else the marketplace does — importing,
 * validating, storing — already exists locally and must not be duplicated per
 * catalogue provider.
 */
export interface PetCatalogue {
  listTopPets(limit: number): Promise<CatalogueResult>;
}

/** How many entries a caller may ask for. "Top 100 by views" is the stated goal. */
export const MAX_CATALOGUE_ENTRIES = 100;

/** Guards against a hostile or broken catalogue returning a huge body. */
const CATALOGUE_TIMEOUT_MS = 8000;

/**
 * Lenient about field names because the real ones are unknown.
 *
 * Anything unrecognised is dropped rather than rejected — an entry missing a
 * view count is still browsable, and refusing the whole page because one item
 * lacks a thumbnail would be the wrong trade for a read-only listing.
 */
const remoteEntrySchema = z.object({
  id: z.string().min(1).max(64),
  displayName: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  previewUrl: z.string().url().max(2048).optional(),
  downloadUrl: z.string().url().max(2048).optional(),
  views: z.number().int().min(0).optional(),
});

const remoteResponseSchema = z.union([
  z.array(remoteEntrySchema),
  z.object({ pets: z.array(remoteEntrySchema) }),
  z.object({ items: z.array(remoteEntrySchema) }),
]);

const toEntry = (raw: z.infer<typeof remoteEntrySchema>): CatalogueEntry => ({
  id: raw.id,
  displayName: raw.displayName ?? raw.name ?? raw.id,
  description: raw.description ?? '',
  previewUrl: raw.previewUrl ?? null,
  downloadUrl: raw.downloadUrl ?? null,
  views: raw.views ?? null,
});

/**
 * An HTTP catalogue reader, or an inert one when no URL is configured.
 *
 * The unconfigured case is a first-class result rather than an error because it
 * is the normal state today: nobody has a catalogue URL to give it yet.
 */
export function createRemoteCatalogue(
  baseUrl: string | undefined = process.env.TAILS_PET_CATALOGUE_URL,
): PetCatalogue {
  const trimmed = baseUrl?.trim().replace(/\/+$/, '') || null;

  return {
    async listTopPets(limit: number): Promise<CatalogueResult> {
      if (!trimmed) {
        return { configured: false, baseUrl: null, entries: [], error: null };
      }

      const capped = Math.max(1, Math.min(MAX_CATALOGUE_ENTRIES, Math.trunc(limit) || MAX_CATALOGUE_ENTRIES));
      const url = `${trimmed}/pets?sort=views&limit=${capped}`;

      try {
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
        });

        if (!response.ok) {
          return {
            configured: true,
            baseUrl: trimmed,
            entries: [],
            error: `The catalogue at ${trimmed} answered ${response.status}.`,
          };
        }

        const parsed = remoteResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          return {
            configured: true,
            baseUrl: trimmed,
            entries: [],
            error: 'The catalogue responded with a shape this build does not understand. '
              + 'The real codex-pet.net API has not been confirmed yet.',
          };
        }

        const raw = Array.isArray(parsed.data)
          ? parsed.data
          : 'pets' in parsed.data ? parsed.data.pets : parsed.data.items;

        return {
          configured: true,
          baseUrl: trimmed,
          entries: raw.slice(0, capped).map(toEntry),
          error: null,
        };
      } catch (error) {
        return {
          configured: true,
          baseUrl: trimmed,
          entries: [],
          error: error instanceof Error ? error.message : 'The catalogue could not be reached.',
        };
      }
    },
  };
}
