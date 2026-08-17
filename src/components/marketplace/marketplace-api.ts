import { useSyncExternalStore } from 'react';

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

export type PetStates = { idle: FrameRange } & Partial<Record<PetStateName, FrameRange>>;

/**
 * The animations a Codex sheet actually has.
 *
 * The first eleven are the published convention (see the server's
 * `codex-layout.ts`); `walk`, `talk` and `sleep` are legacy aliases that
 * `resolveStateName` maps onto real states rather than anything stored.
 */
export const PET_STATE_NAMES = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review',
  'look-right-side',
  'look-left-side',
  'walk',
  'talk',
  'sleep',
] as const;

export type PetStateName = (typeof PET_STATE_NAMES)[number];

export type PetDefinition = {
  id: string;
  displayName: string;
  description: string;
  kind?: string;
  /** Only ever present when the pet's own manifest declares one; never inferred. */
  author?: string;
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
  /**
   * The frame that represents this pet, decided by the server.
   *
   * Use it — via `<PetThumbnail>` — instead of working a frame out from the
   * grid and the idle range. It is always inside the sheet, so a consumer needs
   * no fallback for a range that points past the end.
   */
  preview: { frame: number; column: number; row: number };
  /**
   * A theme this pet brings to a conversation it is assigned to, or null.
   *
   * An opaque id. Themes come and go, so one that no longer exists means "no
   * theme" — never an error, and never a reason to refuse to render the pet.
   */
  assignedTheme: string | null;
  /**
   * What the pet says while the agent is thinking.
   *
   * Plain text, always rendered as text. Capped server-side at twelve phrases
   * of eighty characters.
   */
  thinkingPhrases: string[];
  /** ISO timestamp of when this pet entered the library, not when it was made. */
  installedAt: string | null;
  removable: boolean;
  /** Hidden pets stay on disk and out of the library until the user brings them back. */
  hidden: boolean;
  /**
   * How the user has set this pet up on a stage: his size, and whether he
   * wanders. Always present — the server fills in the defaults, so no surface
   * has to know them.
   */
  stage: { scale: number; walks: boolean };
  /** Starred pets lead the carousel. */
  starred: boolean;
  /** When the pet was last put on screen; null means nobody has tried it yet. */
  lastUsedAt: string | null;
  active: boolean;
  warnings: string[];
};

export type PetProblem = { directory: string; message: string };

export type PetLibrary = {
  pets: InstalledPet[];
  /** On disk but kept out of the library by the user; returned so hiding is reversible. */
  hidden: InstalledPet[];
  problems: PetProblem[];
  activePetId: string | null;
  sources: { codex: string; tails: string };
};

/** What the publisher's validator measured about a sheet. */
export type CatalogueValidation = {
  cellSize: string | null;
  atlasSize: string | null;
  statesDetected: number | null;
};

export type CatalogueEntry = {
  id: string;
  displayName: string;
  description: string;
  kind: string | null;
  ownerHandle: string | null;
  uploadedAt: string | null;
  /** 1 or 2. Decides the row count and the filmstrip's frame layout. */
  spriteVersionNumber: number | null;
  views: number | null;
  downloads: number | null;
  likes: number | null;
  tags: string[];
  /**
   * A single cell of the pet, proxied by our server.
   *
   * The catalogue's own "preview" is a filmstrip of every frame in one row, so
   * these are two separate fields: showing the strip where a portrait belongs
   * renders the pet as a line of sprites.
   */
  posterUrl: string | null;
  /** The filmstrip, one row, for surfaces that animate it. Also proxied. */
  stripUrl: string | null;
  validation: CatalogueValidation | null;
};

export type CataloguePage = {
  configured: boolean;
  baseUrl: string | null;
  entries: CatalogueEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  sort: string;
  query: string;
  error: string | null;
};

/** What a `pet.json` may contain when the user picks one from disk. */
export type PetFileDraft = {
  id: string;
  displayName: string;
  description?: string;
  kind?: string;
  author?: string;
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

/**
 * "The library changed", announced to the rest of the window.
 *
 * The shelves that install a pet are in the main pane and the carousel that has
 * to show it is in the sidebar, with the app shell between them. Handing a
 * refresh callback down both branches means every surface that ever installs
 * anything has to remember to call it, and the first one that forgets is a pet
 * the user has to reload the app to see — which is exactly what happened.
 *
 * So the write announces itself instead. Every mutation below goes through
 * `writing`, nothing polls, and a new surface that installs a pet gets the
 * behaviour for free because it cannot install one without going through here.
 *
 * Deliberately in-document. The app has an `appBroadcast` for facts every open
 * window needs — an appearance change, the conversation list moving — but the
 * pets module publishes nothing on it yet, so a pet installed in one window
 * does not reach another. When `pets_changed` exists, subscribing to it here is
 * the entire change and every consumer of `usePetLibraryVersion` inherits it.
 */
let libraryVersion = 0;
const libraryListeners = new Set<() => void>();

function subscribeToLibrary(listener: () => void): () => void {
  libraryListeners.add(listener);
  return () => {
    libraryListeners.delete(listener);
  };
}

/**
 * Announces a write once it has actually landed.
 *
 * A failed install has changed nothing, and re-reading the library to be told
 * so is a request nobody asked for.
 */
async function writing<T>(pending: Promise<T>): Promise<T> {
  const result = await pending;
  libraryVersion += 1;
  for (const listener of libraryListeners) listener();
  return result;
}

/**
 * Bumped whenever the pet library changes anywhere in this window.
 *
 * Use it as an effect dependency next to whatever loads pets; the number itself
 * means nothing beyond "not what you last saw".
 */
export function usePetLibraryVersion(): number {
  return useSyncExternalStore(subscribeToLibrary, () => libraryVersion, () => libraryVersion);
}

/**
 * Which pet a surface should put on screen.
 *
 * `source` says why: a pet assigned to the conversation, the global active pet,
 * or nothing. A dangling or hidden assignment resolves to the next option down
 * rather than to an error.
 */
export type DisplayPet = {
  pet: InstalledPet | null;
  source: 'session' | 'global' | 'none';
};

export const petsApi = {
  listPets: () => request<PetLibrary>(''),

  /** Resolves `session.petId ?? activePetId` server-side, tolerating both being stale. */
  resolveDisplayPet: (sessionPetId?: string | null) =>
    request<DisplayPet>(`/display${sessionPetId ? `?sessionPetId=${encodeURIComponent(sessionPetId)}` : ''}`),

  /**
   * Every conversation's pet, as `{ [sessionId]: petId }`.
   *
   * One request for a whole sidebar. Ids that no longer resolve to an installed
   * pet are included as stored — the caller shows nothing for them rather than
   * treating a deleted pet as an error.
   */
  listAssignments: () => request<Record<string, string>>('/assignments'),

  /** Copies a pet folder from anywhere on disk into `~/.tails/pets`. */
  importFromPath: (folderPath: string) =>
    writing(request<InstalledPet>('/import', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    })),

  /** Uploads a `pet.json` plus its spritesheet, the image as a base64 data URL. */
  importUpload: (definition: PetFileDraft, image: { fileName: string; data: string }) =>
    writing(request<InstalledPet>('/import', {
      method: 'POST',
      body: JSON.stringify({ definition, image }),
    })),

  /**
   * Saves anything the user can change about a pet.
   *
   * All of it is stored in our own database, never written back to the pet's
   * folder — most pets live in `~/.codex/pets`, which belongs to another tool.
   * For the two preference fields `null` clears and omitting leaves alone, so a
   * form that edits one cannot wipe the other.
   */
  updatePet: (id: string, patch: {
    frame?: FrameGrid;
    states?: PetStates;
    assignedTheme?: string | null;
    thinkingPhrases?: string[] | null;
  }) =>
    writing(request<InstalledPet>(`/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })),

  setActive: (id: string, active: boolean) =>
    writing(request<{ activePetId: string | null }>(`/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
      body: JSON.stringify({ active }),
    })),

  removePet: (id: string) =>
    writing(request<{ id: string }>(`/${encodeURIComponent(id)}`, { method: 'DELETE' })),

  /**
   * Hides a pet from the library, or brings it back.
   *
   * The only "remove" available for a pet in `~/.codex/pets`: those files
   * belong to Codex, so the listing is the only thing we may change.
   */
  setHidden: (id: string, hidden: boolean) =>
    writing(request<InstalledPet>(`/${encodeURIComponent(id)}/hidden`, {
      method: 'POST',
      body: JSON.stringify({ hidden }),
    })),

  /** Stars a pet, or unstars it. Starred pets lead the carousel. */
  setStarred: (id: string, starred: boolean) =>
    writing(request<InstalledPet>(`/${encodeURIComponent(id)}/starred`, {
      method: 'POST',
      body: JSON.stringify({ starred }),
    })),

  /**
   * Records that a pet was chosen for a conversation.
   *
   * Activation records itself server-side; this is for assignment, whose write
   * belongs to the sessions module while the tally belongs to pets.
   */
  markUsed: (id: string) =>
    writing(request<InstalledPet>(`/${encodeURIComponent(id)}/used`, { method: 'POST' })),

  /** One page of codex-pets.net, sorted by views, proxied through our server. */
  listCatalogue: (options: { page?: number; pageSize?: number; query?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.page) params.set('page', String(options.page));
    if (options.pageSize) params.set('pageSize', String(options.pageSize));
    if (options.query?.trim()) params.set('q', options.query.trim());
    const suffix = params.toString();
    return request<CataloguePage>(`/catalogue${suffix ? `?${suffix}` : ''}`);
  },

  /** Downloads and installs one catalogue pet. The id is all the server accepts. */
  installFromCatalogue: (id: string) =>
    writing(request<InstalledPet>(`/catalogue/${encodeURIComponent(id)}/install`, { method: 'POST' })),
};
