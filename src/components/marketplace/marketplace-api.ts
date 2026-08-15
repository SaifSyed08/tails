/**
 * The pets HTTP surface, as the marketplace sees it.
 *
 * Kept inside the marketplace folder rather than folded into `lib/api.ts` so
 * the feature is self-contained: another worker mounts `<MarketplacePage>` and
 * gets the whole thing, with nothing to wire up elsewhere.
 *
 * The types here mirror `server/modules/pets` by hand. They cannot be imported
 * — client and server compile under different tsconfigs — so treat this file as
 * the contract and change both sides together.
 */

/** How a spritesheet is cut into frames. Frames are numbered row-major from 0. */
export type FrameGrid = {
  width: number;
  height: number;
  columns: number;
  rows: number;
  fps: number;
};

/** An inclusive run of frames. */
export type FrameRange = {
  start: number;
  end: number;
  fps?: number;
};

export type PetStates = {
  idle: FrameRange;
  walk?: FrameRange;
  talk?: FrameRange;
  sleep?: FrameRange;
};

export const PET_STATE_NAMES = ['idle', 'walk', 'talk', 'sleep'] as const;

export type PetStateName = (typeof PET_STATE_NAMES)[number];

export type PetDefinition = {
  id: string;
  displayName: string;
  description: string;
  kind?: string;
  spriteVersionNumber?: number;
  spritesheetPath: string;
  frame: FrameGrid;
  states: PetStates;
  personality?: string;
  voice?: { engine: 'none' | 'system'; name?: string; pitch: number; rate: number };
};

/**
 * Where a frame grid came from.
 *
 * Surfaced in the UI verbatim: `codex-cell-pitch` and `square-cells` are
 * guesses the server made from the image dimensions, and the user needs to know
 * that before they conclude a pet is broken.
 */
export type PetGridBasis = 'authored' | 'codex-cell-pitch' | 'square-cells' | 'single-frame';

export type InstalledPet = {
  definition: PetDefinition;
  source: 'codex' | 'tails';
  directory: string;
  spriteUrl: string;
  spriteSize: { width: number; height: number } | null;
  gridBasis: PetGridBasis;
  removable: boolean;
  active: boolean;
  warnings: string[];
};

export type PetProblem = { directory: string; message: string };

export type PetLibrary = {
  pets: InstalledPet[];
  problems: PetProblem[];
  activePetId: string | null;
  sources: { codex: string; tails: string };
};

export type CatalogueEntry = {
  id: string;
  displayName: string;
  description: string;
  previewUrl: string | null;
  downloadUrl: string | null;
  views: number | null;
};

export type CatalogueResult = {
  configured: boolean;
  baseUrl: string | null;
  entries: CatalogueEntry[];
  error: string | null;
};

/** What a `pet.json` may contain when the user picks one from disk. */
export type PetFileDraft = {
  id: string;
  displayName: string;
  description?: string;
  kind?: string;
  spriteVersionNumber?: number;
  spritesheetPath?: string;
  frame?: FrameGrid;
  states?: PetStates;
  personality?: string;
};

/**
 * Throws on a non-2xx, preferring the server's message and its dotted-path
 * validation details.
 *
 * Import failures are the common case here and they are almost always a
 * specific field, so flattening `details` into the message is the difference
 * between "that did not work" and "states.walk.end is past frame 87".
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/pets${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const details: { path: string; message: string }[] = Array.isArray(body?.error?.details)
      ? body.error.details
      : [];
    const suffix = details.length > 0
      ? ` (${details.map((issue) => `${issue.path}: ${issue.message}`).join('; ')})`
      : '';
    throw new Error(`${body?.error?.message ?? `Request failed with ${response.status}`}${suffix}`);
  }

  return response.json() as Promise<T>;
}

export const petsApi = {
  listPets: () => request<PetLibrary>(''),

  /** Copies a pet folder from anywhere on disk into `~/.tails/pets`. */
  importFromPath: (folderPath: string) =>
    request<InstalledPet>('/import', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  /** Uploads a `pet.json` plus its spritesheet, the image as a base64 data URL. */
  importUpload: (definition: PetFileDraft, image: { fileName: string; data: string }) =>
    request<InstalledPet>('/import', {
      method: 'POST',
      body: JSON.stringify({ definition, image }),
    }),

  /** Saves a corrected frame grid or state ranges. Stored per pet, even for read-only Codex pets. */
  updatePet: (id: string, patch: { frame?: FrameGrid; states?: PetStates }) =>
    request<InstalledPet>(`/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  setActive: (id: string, active: boolean) =>
    request<{ activePetId: string | null }>(`/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
      body: JSON.stringify({ active }),
    }),

  removePet: (id: string) =>
    request<{ id: string }>(`/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listCatalogue: () => request<CatalogueResult>('/catalogue'),
};
