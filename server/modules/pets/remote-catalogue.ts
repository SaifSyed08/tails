import { z } from 'zod';

/**
 * The codex-pets.net library.
 *
 * ## What the API actually is
 *
 * Probed against the live host rather than assumed, and every parameter below
 * was confirmed by response, because the two obvious guesses are both wrong:
 *
 * | request | behaviour |
 * | --- | --- |
 * | `GET /api/pets` | `{ pets, page, pageSize, total, totalPages }`; 3,040 pets |
 * | `?sort=views` | descending by view count. **`sortBy` and `order` are silently ignored** — they return the unsorted list, which looks like it worked |
 * | `?q=` | full-text search. **`search` and `query` are silently ignored** the same way |
 * | `?page=` / `?pageSize=` | both honoured |
 * | `GET /api/pets/:id` | `{ pet }` — one entry, same shape |
 * | `GET /api/pets/:id/download` | `application/zip`, ~1.7MB, holding `pet.json` and the spritesheet. The `?v=` in the listing's `downloadUrl` is optional |
 *
 * ## Why nothing is bulk-imported
 *
 * 3,040 pets at roughly 1.7MB each is about 5GB. The library is browsed live
 * and a pet is downloaded when someone asks for that pet.
 *
 * ## Why the renderer never talks to this host
 *
 * Everything goes through our own server: one place for the timeout, one place
 * for the failure text, one place a future offline cache would live, and — the
 * load-bearing one — the client never gets to name a URL. It names an id; the
 * URL is whatever this module learned from the catalogue itself, and it must be
 * on the catalogue's own origin or it is refused.
 */

/**
 * The real host.
 *
 * `TAILS_PET_CATALOGUE_URL` overrides it, and setting that variable to an
 * **empty string** switches the remote shelf off entirely — no requests leave
 * the machine and the UI says the catalogue is turned off. Unset means "use the
 * default", which is not the same thing, so an air-gapped install has a way to
 * say so that does not look like a misconfiguration.
 */
export const DEFAULT_CATALOGUE_URL = 'https://codex-pets.net';

/** What the publisher's own validator measured. `cellSize` is the frame grid, stated rather than inferred. */
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
  /** The uploader's handle. Shown as-is; the site's display name is not verified by us. */
  ownerHandle: string | null;
  uploadedAt: string | null;
  views: number | null;
  downloads: number | null;
  likes: number | null;
  tags: string[];
  /**
   * A single 192x208 cell — the pet standing still.
   *
   * The one to show in a card. The catalogue's `previewUrl` is **not** this: it
   * is a 5472x104 filmstrip of every frame in a row, and painting that into an
   * image element is what made pets render as a line of sprites.
   */
  posterUrl: string | null;
  /**
   * The filmstrip, for surfaces that want to animate it.
   *
   * One row, frame count implied by the cell aspect rather than stated, and
   * about a tenth the size of the full spritesheet — which is what makes an
   * animated preview affordable for fifty pets at once.
   */
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
  /** Set when the catalogue could not be read. Never thrown — a dead remote must not break the local gallery. */
  error: string | null;
};

/** What a download produced, before anything is written to disk. */
export type CatalogueDownload = {
  bytes: Buffer;
  contentType: string;
  validation: CatalogueValidation | null;
  /** The catalogue's own manifest fields, used only to cross-check the archive. */
  entry: CatalogueEntry;
};

export interface PetCatalogue {
  listPets(options: { page?: number; pageSize?: number; query?: string }): Promise<CataloguePage>;
  /** Fetches one pet's archive. The id is ours to validate; the URL is never the caller's to choose. */
  downloadPet(id: string): Promise<CatalogueDownload>;
  /** Streams one of the preview images the catalogue advertised for this pet. */
  fetchImage(id: string, kind: CatalogueImageKind): Promise<{ bytes: Buffer; contentType: string }>;
}

/** `poster` is one cell; `strip` is the filmstrip of every frame. */
export type CatalogueImageKind = 'poster' | 'strip';

/** "Top 50 by views" is the landing shelf, and the API's own page size is 30. */
export const DEFAULT_PAGE_SIZE = 50;

/** The API tops out well below this; it exists so a bad `pageSize` cannot ask for everything. */
export const MAX_PAGE_SIZE = 100;

const LIST_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const PREVIEW_TIMEOUT_MS = 15_000;

/**
 * Hard ceiling on a download.
 *
 * The largest pet observed is about 1.8MB; 12MB leaves room for a legitimately
 * big sheet while making an endless response impossible. Enforced while
 * streaming, not from `Content-Length`, because a header is a claim.
 */
export const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;

const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;

/**
 * Lenient about optional fields, strict about the two that matter.
 *
 * `id` becomes a directory name downstream and `displayName` is rendered, so
 * those are required and bounded. Everything else is decoration: an entry with
 * no like count is still browsable, and rejecting a page because one item is
 * missing a thumbnail would be the wrong trade for a read-only listing.
 */
const remoteEntrySchema = z.object({
  id: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional().nullable(),
  kind: z.string().max(40).optional().nullable(),
  ownerHandle: z.string().max(80).optional().nullable(),
  ownerName: z.string().max(80).optional().nullable(),
  ownerShadowbanned: z.boolean().optional(),
  uploadedAt: z.string().max(64).optional().nullable(),
  viewCount: z.number().optional().nullable(),
  downloadCount: z.number().optional().nullable(),
  likeCount: z.number().optional().nullable(),
  tags: z.array(z.string().max(40)).max(20).optional().nullable(),
  previewUrl: z.string().max(2048).optional().nullable(),
  posterUrl: z.string().max(2048).optional().nullable(),
  downloadUrl: z.string().max(2048).optional().nullable(),
  validationReport: z.object({
    cellSize: z.string().max(32).optional().nullable(),
    atlasSize: z.string().max(32).optional().nullable(),
    statesDetected: z.number().optional().nullable(),
  }).partial().optional().nullable(),
}).loose();

const listResponseSchema = z.object({
  pets: z.array(remoteEntrySchema),
  page: z.number().optional(),
  pageSize: z.number().optional(),
  total: z.number().optional(),
  totalPages: z.number().optional(),
}).loose();

const singleResponseSchema = z.object({ pet: remoteEntrySchema }).loose();

type RemoteEntry = z.infer<typeof remoteEntrySchema>;

/**
 * What the catalogue told us about a pet, kept so the *client* never has to.
 *
 * An install request carries an id and nothing else. Turning that id into a URL
 * happens here, from URLs this module received from the catalogue — which is
 * what stops "install this pet" from becoming "make the server fetch this
 * arbitrary address". Bounded because it is a cache, not a database.
 */
const MAX_REMEMBERED = 600;

type RememberedUrls = { download: string | null; poster: string | null; strip: string | null };

export function createRemoteCatalogue(
  baseUrl: string | undefined = process.env.TAILS_PET_CATALOGUE_URL,
): PetCatalogue {
  // Unset falls back to the real host; set-but-empty is a deliberate "off".
  const trimmed = (baseUrl === undefined ? DEFAULT_CATALOGUE_URL : baseUrl.trim())
    .replace(/\/+$/, '');
  const configured = trimmed !== '';
  const base = configured ? new URL(trimmed) : null;

  const remembered = new Map<string, RememberedUrls>();
  const entries = new Map<string, CatalogueEntry>();

  const remember = (id: string, urls: RememberedUrls, entry: CatalogueEntry) => {
    if (remembered.size >= MAX_REMEMBERED) {
      // Oldest first: Map preserves insertion order, and the entry a user is
      // about to install is the one they just looked at.
      const oldest = remembered.keys().next().value;
      if (oldest !== undefined) {
        remembered.delete(oldest);
        entries.delete(oldest);
      }
    }
    remembered.set(id, urls);
    entries.set(id, entry);
  };

  /**
   * Resolves a URL the catalogue gave us and proves it stayed on the
   * catalogue's origin.
   *
   * Relative paths are normal here (`downloadUrl` is `/api/pets/x/download`).
   * Absolute ones are accepted only when they point at the same host, so a
   * compromised or hostile catalogue cannot use its own response to aim this
   * server at a cloud metadata endpoint or an internal service.
   */
  const resolveOnCatalogue = (value: string | null | undefined): string | null => {
    if (!value || !base) return null;
    let resolved: URL;
    try {
      resolved = new URL(value, base);
    } catch {
      return null;
    }
    if (resolved.origin !== base.origin) return null;
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.toString();
  };

  const toEntry = (raw: RemoteEntry): CatalogueEntry => ({
    id: raw.id,
    displayName: raw.displayName ?? raw.name ?? raw.id,
    description: raw.description ?? '',
    kind: raw.kind ?? null,
    ownerHandle: raw.ownerHandle ?? raw.ownerName ?? null,
    uploadedAt: raw.uploadedAt ?? null,
    views: typeof raw.viewCount === 'number' ? raw.viewCount : null,
    downloads: typeof raw.downloadCount === 'number' ? raw.downloadCount : null,
    likes: typeof raw.likeCount === 'number' ? raw.likeCount : null,
    tags: raw.tags ?? [],
    // Pointed at our own proxy rather than at the host, so the renderer makes
    // no request to codex-pets.net at all.
    posterUrl: raw.posterUrl
      ? `/api/pets/catalogue/${encodeURIComponent(raw.id)}/poster`
      : null,
    stripUrl: raw.previewUrl
      ? `/api/pets/catalogue/${encodeURIComponent(raw.id)}/strip`
      : null,
    validation: raw.validationReport
      ? {
        cellSize: raw.validationReport.cellSize ?? null,
        atlasSize: raw.validationReport.atlasSize ?? null,
        statesDetected: typeof raw.validationReport.statesDetected === 'number'
          ? raw.validationReport.statesDetected
          : null,
      }
      : null,
  });

  /** Records an entry and returns it, dropping anything the site has shadowbanned. */
  const accept = (raw: RemoteEntry): CatalogueEntry | null => {
    if (raw.ownerShadowbanned) return null;
    const entry = toEntry(raw);
    remember(
      raw.id,
      {
        // A download URL is always constructible from the id, and the listing's
        // `?v=` is optional, so a missing field is not a reason to refuse.
        download: resolveOnCatalogue(raw.downloadUrl ?? `/api/pets/${encodeURIComponent(raw.id)}/download`),
        poster: resolveOnCatalogue(raw.posterUrl),
        strip: resolveOnCatalogue(raw.previewUrl),
      },
      entry,
    );
    return entry;
  };

  const emptyPage = (error: string | null, page: number, pageSize: number, query: string): CataloguePage => ({
    configured,
    baseUrl: configured ? trimmed : null,
    entries: [],
    page,
    pageSize,
    total: 0,
    totalPages: 0,
    sort: 'views',
    query,
    error,
  });

  /** Fetches one pet's record straight from the catalogue, for ids we have not listed. */
  const fetchEntry = async (id: string): Promise<CatalogueEntry> => {
    const response = await fetch(`${trimmed}/api/pets/${encodeURIComponent(id)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`The catalogue answered ${response.status} for "${id}".`);
    }

    const parsed = singleResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error(`The catalogue's record for "${id}" was not readable.`);

    const entry = accept(parsed.data.pet);
    if (!entry) throw new Error(`"${id}" is not available from the catalogue.`);
    return entry;
  };

  /**
   * Reads a response body with a hard ceiling.
   *
   * Streamed and counted rather than `arrayBuffer()` on trust: `Content-Length`
   * is a claim by the sender, and the point of the cap is the case where the
   * sender is lying or the connection never ends.
   */
  const readCapped = async (response: Response, limit: number, what: string): Promise<Buffer> => {
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > limit) {
      throw new Error(`That ${what} is ${(declared / 1024 / 1024).toFixed(1)}MB; the limit is ${limit / 1024 / 1024}MB.`);
    }

    const chunks: Buffer[] = [];
    let total = 0;

    const body = response.body;
    if (!body) throw new Error(`That ${what} came back empty.`);

    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > limit) {
        throw new Error(`That ${what} is larger than the ${limit / 1024 / 1024}MB limit.`);
      }
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks, total);
  };

  return {
    async listPets({ page = 1, pageSize = DEFAULT_PAGE_SIZE, query = '' }): Promise<CataloguePage> {
      const safePage = Math.max(1, Math.trunc(page) || 1);
      const safeSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(pageSize) || DEFAULT_PAGE_SIZE));
      const search = query.trim().slice(0, 80);

      if (!configured) return emptyPage(null, safePage, safeSize, search);

      // `sort=views` is the only spelling the API honours; the others return
      // the unsorted list without saying so.
      const url = new URL('/api/pets', trimmed);
      url.searchParams.set('sort', 'views');
      url.searchParams.set('page', String(safePage));
      url.searchParams.set('pageSize', String(safeSize));
      if (search) url.searchParams.set('q', search);

      try {
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
        });

        if (!response.ok) {
          return emptyPage(`The catalogue answered ${response.status}.`, safePage, safeSize, search);
        }

        const parsed = listResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          return emptyPage(
            'The catalogue responded in a shape this build does not understand.',
            safePage,
            safeSize,
            search,
          );
        }

        const accepted = parsed.data.pets
          .map(accept)
          .filter((entry): entry is CatalogueEntry => entry !== null);

        return {
          configured: true,
          baseUrl: trimmed,
          entries: accepted,
          page: parsed.data.page ?? safePage,
          pageSize: parsed.data.pageSize ?? safeSize,
          total: parsed.data.total ?? accepted.length,
          totalPages: parsed.data.totalPages ?? 1,
          sort: 'views',
          query: search,
          error: null,
        };
      } catch (error) {
        return emptyPage(describeNetworkError(error, trimmed), safePage, safeSize, search);
      }
    },

    async downloadPet(id: string): Promise<CatalogueDownload> {
      if (!configured || !base) throw new Error('No catalogue is configured.');

      const entry = entries.get(id) ?? await fetchEntry(id);
      const downloadUrl = remembered.get(id)?.download;
      if (!downloadUrl) {
        throw new Error(`The catalogue did not offer a download for "${id}".`);
      }

      const response = await fetch(downloadUrl, {
        headers: { accept: 'application/zip' },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        redirect: 'error',
      });

      if (!response.ok) {
        throw new Error(`The catalogue answered ${response.status} when asked for "${id}".`);
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!contentType.includes('zip')) {
        throw new Error(`The catalogue sent "${contentType || 'nothing'}" instead of a ZIP archive.`);
      }

      return {
        bytes: await readCapped(response, MAX_ARCHIVE_BYTES, 'download'),
        contentType,
        validation: entry.validation,
        entry,
      };
    },

    async fetchImage(id: string, kind: CatalogueImageKind): Promise<{ bytes: Buffer; contentType: string }> {
      if (!configured) throw new Error('No catalogue is configured.');

      if (!remembered.has(id)) await fetchEntry(id);
      const imageUrl = remembered.get(id)?.[kind];
      if (!imageUrl) throw new Error(`No ${kind} image for "${id}".`);

      const response = await fetch(imageUrl, {
        signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
        redirect: 'error',
      });

      if (!response.ok) throw new Error(`The ${kind} for "${id}" answered ${response.status}.`);

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!contentType.startsWith('image/')) {
        throw new Error(`The ${kind} for "${id}" is not an image.`);
      }

      return {
        bytes: await readCapped(response, MAX_PREVIEW_BYTES, kind),
        contentType,
      };
    },
  };
}

/**
 * Turns a fetch failure into something a person can act on.
 *
 * `fetch` reports "fetch failed" for a missing network, a dead host and a
 * refused TLS handshake alike, and "the shop is offline" is the answer the user
 * needs — not a stack of causes.
 */
function describeNetworkError(error: unknown, baseUrl: string): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `${baseUrl} did not answer in time.`;
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `${baseUrl} did not answer in time.`;
  }
  return `${baseUrl} could not be reached. Check the connection and try again.`;
}
