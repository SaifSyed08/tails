import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Monitor,
  PawPrint,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import { Reveal } from '@/shared/ui/Motion';
import { readStaggerDelay } from '@/theme/motion';

import { CatalogueShelf } from './CatalogueShelf';
import { claimDesktop, releaseDesktopClaim } from './desktop-claim';
import {
  hasDesktopPet,
  hideDesktopPet,
  readDesktopPetState,
  refreshDesktopPet,
  resetDesktopPetPosition,
} from './desktop-pet';
import { ImportPetDialog } from './ImportPetDialog';
import { LibraryEmpty, LibrarySkeleton, NoMatches } from './LibraryStates';
import {
  petsApi,
  type CatalogueEntry,
  type CataloguePage,
  type FrameGrid,
  type InstalledPet,
  type PetLibrary,
  type PetStates,
} from './marketplace-api';
import {
  collectKinds,
  countBySource,
  filterPets,
  sortPets,
  type SortOrder,
  type SourceFilter,
} from './pet-filters';
import { PetCard } from './PetCard';
import { PetDetailDialog } from './PetDetailDialog';
import { PetSpotlight } from './PetSpotlight';
import { PetThumbnail } from './PetThumbnail';
import { SPRITE_KEYFRAMES } from './SpritePreview';
import { StorefrontToolbar } from './StorefrontToolbar';

/**
 * The pets marketplace.
 *
 * Self-contained: it owns its data fetching, its dialogs and its styles, and
 * takes no required props, so mounting it anywhere in the app is a one-liner.
 *
 * It is laid out as a shop rather than as a list of settings — a window
 * display, a filter bar, a grid of animated cards, and a shelf for the remote
 * library — because choosing a companion is browsing, not configuration. The
 * page itself only owns data and actions; each of those four parts is its own
 * component.
 *
 * There are two shelves and they work differently on purpose. The library is
 * what is on this machine, animated live from the real spritesheets. The
 * codex-pets.net shelf is 3,040 pets browsed a page at a time through our own
 * server, with the top 50 by views as the landing page; nothing is downloaded
 * until someone installs a specific pet, because bulk-importing that library
 * would be about five gigabytes.
 *
 * Every number shown comes from somewhere real — the catalogue's own view,
 * like and download counts, or a count of the files on disk. Nothing is
 * invented to make a shelf look busier, and every pet's frame layout says where
 * it came from, because Codex spritesheets do not describe their own layout and
 * the user is the one who can correct a bad guess.
 */

export type MarketplacePageProps = {
  /** Renders a close control when provided — omit it when the page owns the viewport. */
  onClose?: () => void;
  className?: string;
};

export function MarketplacePage({ onClose, className }: MarketplacePageProps) {
  const [library, setLibrary] = useState<PetLibrary | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [kind, setKind] = useState<string | null>(null);
  const [order, setOrder] = useState<SortOrder>('name');
  const [showHidden, setShowHidden] = useState(false);

  // The fetched page is stored with the request that produced it, so "still
  // loading" is derived by comparing keys rather than tracked as its own flag —
  // a late response for page 2 can then never clear the spinner for page 3.
  const [catalogueState, setCatalogueState] = useState<{ key: string; page: CataloguePage } | null>(null);
  const [cataloguePage, setCataloguePage] = useState(1);
  const [catalogueQuery, setCatalogueQuery] = useState('');
  const [catalogueSearch, setCatalogueSearch] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [desktopHidden, setDesktopHidden] = useState<boolean | null>(null);

  /*
    Only meaningful in the desktop build; in a browser there is no window to
    float and the control is not rendered at all.

    Re-read on focus, not only at mount. The pet's own pill can hide him while
    this page is sitting open behind it, and a toggle showing the opposite of
    the truth does the opposite of what it says when pressed — press "hide" on
    an already-hidden pet and nothing happens, which is precisely how "he is
    permanently hidden" felt.
  */
  useEffect(() => {
    let cancelled = false;

    const sync = () => {
      void readDesktopPetState().then((state) => {
        if (!cancelled) setDesktopHidden(state?.hidden ?? null);
      });
    };

    sync();
    window.addEventListener('focus', sync);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', sync);
    };
  }, []);

  // Reloads are requested by bumping a token rather than by calling a fetcher
  // directly, which keeps every state write inside a promise callback instead
  // of running synchronously as the effect body.
  const [reloadToken, setReloadToken] = useState(0);
  const [catalogueToken, setCatalogueToken] = useState(0);
  const refresh = useCallback(() => setReloadToken((current) => current + 1), []);

  const catalogueKey = `${cataloguePage}|${catalogueSearch}|${catalogueToken}`;
  // The last page fetched stays on screen, dimmed, while the next one loads:
  // paging that empties the shelf on every click reads as breakage.
  const catalogue = catalogueState?.page ?? null;
  const catalogueLoading = catalogueState?.key !== catalogueKey;

  useEffect(() => {
    let cancelled = false;

    petsApi.listPets()
      .then((next) => {
        if (cancelled) return;
        setLibrary(next);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : 'Could not load your pets.');
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // Typing in the remote search must not fire a request per keystroke at a
  // 3,040-pet API. A short pause, and the page resets to 1 because results for
  // a new search have no page 4.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCatalogueSearch(catalogueQuery.trim());
      setCataloguePage(1);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [catalogueQuery]);

  // Separate from the pet list: a slow or dead remote must not hold up the
  // gallery, and its failure is reported on its own shelf.
  useEffect(() => {
    let cancelled = false;

    petsApi.listCatalogue({ page: cataloguePage, query: catalogueSearch })
      .then((next) => {
        if (!cancelled) setCatalogueState({ key: catalogueKey, page: next });
      })
      .catch((catalogueError: unknown) => {
        if (cancelled) return;
        // The shelf's own offline state, not the page's error banner: the
        // local library is fine and must not look broken because a website is.
        setCatalogueState({
          key: catalogueKey,
          page: {
            configured: true,
            baseUrl: null,
            entries: [],
            page: cataloguePage,
            pageSize: 0,
            total: 0,
            totalPages: 0,
            sort: 'views',
            query: catalogueSearch,
            error: catalogueError instanceof Error
              ? catalogueError.message
              : 'The catalogue could not be reached.',
          },
        });
      });

    return () => {
      cancelled = true;
    };
  }, [cataloguePage, catalogueSearch, catalogueKey]);

  const runAction = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      refresh();
      // The desktop window polls on its own, but the two seconds after someone
      // clicks "Set active" are exactly when a companion arriving late reads as
      // nothing having happened.
      refreshDesktopPet();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'That did not work.');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Puts a pet on screen, or takes him off it.
   *
   * Activating also clears the desktop window's hide, and that is the fix for a
   * pet nobody could get back: closing him with the pill's X sets a flag that
   * survives restarts, and "put this pet on screen" was leaving it set — so the
   * pet became active, the card said so, and nothing appeared. Asking for a pet
   * on screen is unambiguous enough to override a hide, and it is the only
   * reading of the button that matches its own label.
   */
  const handleSetActive = (pet: InstalledPet) => {
    const activating = !pet.active;
    if (activating) {
      hideDesktopPet(false);
      setDesktopHidden(false);
      /*
        And it is recorded as a decision, not only applied.

        A pet who is also assigned to a conversation is kept off the desktop
        after that conversation is left, so that opening a chat cannot put a pet
        on the desktop as a side effect. That rule cannot be allowed to outrank
        this button: pressing "on desktop" for a pet who happens to live in a
        chat used to work until the moment that chat was opened, after which he
        was suppressed everywhere -- including here -- with no way back short of
        activating somebody else. See `desktop-claim.ts`.
      */
      claimDesktop(pet.definition.id);
    } else {
      releaseDesktopClaim(pet.definition.id);
    }
    void runAction(pet.definition.id, () => petsApi.setActive(pet.definition.id, activating));
  };

  /**
   * Takes a copy of a Codex pet.
   *
   * The copy lands in `~/.tails/pets` under the same id and shadows the
   * original in the listing, which is what turns a read-only pet into one the
   * user can retime and delete.
   */
  const handleAddCopy = (pet: InstalledPet) => {
    void runAction(pet.definition.id, () => petsApi.importFromPath(pet.directory));
  };

  /**
   * Takes a pet out of the library without touching its files.
   *
   * What "remove" means for a pet in `~/.codex/pets`: Codex owns that folder,
   * so the listing is the only thing we may change. Two Sonics on disk, one in
   * the library.
   */
  const handleHide = (pet: InstalledPet, hidden: boolean) => {
    setConfirmingRemoveId(null);
    setDetailId((current) => (hidden && current === pet.definition.id ? null : current));
    void runAction(pet.definition.id, () => petsApi.setHidden(pet.definition.id, hidden));
  };

  /** Downloads one catalogue pet. Never a bulk import — see remote-catalogue.ts. */
  const handleInstallFromCatalogue = (entry: CatalogueEntry) => {
    setInstallingId(entry.id);
    setError(null);
    petsApi.installFromCatalogue(entry.id)
      .then(() => refresh())
      .catch((installError: unknown) => {
        setError(installError instanceof Error
          ? installError.message
          : `${entry.displayName} could not be installed.`);
      })
      .finally(() => setInstallingId(null));
  };

  /** Two-step, because removing a pet deletes its folder and there is no undo. */
  const handleRemove = (pet: InstalledPet) => {
    if (confirmingRemoveId !== pet.definition.id) {
      setConfirmingRemoveId(pet.definition.id);
      return;
    }
    setConfirmingRemoveId(null);
    setDetailId((current) => (current === pet.definition.id ? null : current));
    void runAction(pet.definition.id, () => petsApi.removePet(pet.definition.id));
  };

  const handleSaveLayout = async (id: string, patch: { frame: FrameGrid; states: PetStates }) => {
    await petsApi.updatePet(id, patch);
    refresh();
  };

  const pets = useMemo(() => library?.pets ?? [], [library]);
  const hiddenPets = useMemo(() => library?.hidden ?? [], [library]);
  const kinds = useMemo(() => collectKinds(pets), [pets]);
  const visible = useMemo(
    () => sortPets(filterPets(pets, { query, source, kind }), order),
    [pets, query, source, kind, order],
  );

  // Both lists count as installed: a hidden pet is still on disk, and offering
  // to install it again from the catalogue would fail with "already installed".
  const installedIds = useMemo(
    () => new Set([...pets, ...hiddenPets].map((pet) => pet.definition.id)),
    [pets, hiddenPets],
  );

  // Display names are not unique — Codex generated two pets both called
  // "Sonic" — so cards for a shared name also show their id.
  const duplicateNames = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const pet of pets) {
      const name = pet.definition.displayName;
      if (seen.has(name)) duplicates.add(name);
      seen.add(name);
    }
    return duplicates;
  }, [pets]);

  const sourceCounts: Record<SourceFilter, number> = {
    all: countBySource(pets, 'all'),
    tails: countBySource(pets, 'tails'),
    codex: countBySource(pets, 'codex'),
  };

  /**
   * The window display: the pet most recently *activated*.
   *
   * History, not liveness. Taking Sonic off screen must leave Sonic in the
   * card — promoting some other pet the moment you deactivate one makes the
   * card jump to a stranger for no reason the user can see. `lastUsedAt` is
   * written on activation, so the most recent one is simply the largest, and it
   * keeps its place afterwards.
   *
   * The filters do not reach here either: searching should not empty the shop
   * window.
   */
  const spotlight = useMemo(() => {
    const everUsed = pets.filter((pet) => pet.lastUsedAt !== null);
    if (everUsed.length > 0) {
      return everUsed.reduce((newest, pet) => (
        (pet.lastUsedAt ?? '') > (newest.lastUsedAt ?? '') ? pet : newest
      ));
    }
    return pets.find((pet) => pet.active) ?? pets[0] ?? null;
  }, [pets]);
  const detailPet = detailId ? pets.find((pet) => pet.definition.id === detailId) ?? null : null;

  const filtersActive = query !== '' || source !== 'all' || kind !== null;
  const clearFilters = () => {
    setQuery('');
    setSource('all');
    setKind(null);
  };

  return (
    <div
      data-tails-part="card"
      className={cn('flex h-full min-h-0 flex-col text-foreground', className)}
    >
      {/* The two keyframes every sprite preview animates against. */}
      <style>{SPRITE_KEYFRAMES}</style>

      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h1 className="flex items-center gap-2 font-display text-base font-semibold">
            <PawPrint className="size-4" aria-hidden="true" />
            Pet marketplace
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Browse the pets on this machine, put one on screen, and bring in more.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {hasDesktopPet() && desktopHidden !== null ? (
            <button
              type="button"
              onClick={() => {
                const next = !desktopHidden;
                setDesktopHidden(next);
                hideDesktopPet(next);
              }}
              aria-pressed={!desktopHidden}
              title={desktopHidden
                ? 'The active pet is not shown on your desktop.'
                : 'The active pet floats above your other apps. Right-click it to hide it.'}
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors duration-quick',
                desktopHidden
                  ? 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                  : 'border-primary bg-primary/15 text-primary',
              )}
            >
              <Monitor className="size-3.5" aria-hidden="true" />
              {desktopHidden ? 'Off desktop' : 'On desktop'}
            </button>
          ) : null}
          {hasDesktopPet() ? (
            <button
              type="button"
              onClick={resetDesktopPetPosition}
              title="Brings the desktop pet back to the corner of the screen and shows it."
              className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
            >
              Recall pet
            </button>
          ) : null}
          <button
            type="button"
            onClick={refresh}
            aria-label="Rescan for pets"
            className="rounded-md p-2 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => setImporting(true)}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95"
          >
            <Plus className="size-3.5" /> Import pet
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close pets"
              className="rounded-md p-2 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
        {error ? (
          <p
            data-tails-critical
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        {!library ? <LibrarySkeleton /> : null}

        {library && pets.length === 0 ? (
          <LibraryEmpty sources={library.sources} onImport={() => setImporting(true)} />
        ) : null}

        {spotlight ? (
          <Reveal variant="fade">
            <PetSpotlight
              pet={spotlight}
              counts={{
                total: sourceCounts.all,
                yours: sourceCounts.tails,
                codex: sourceCounts.codex,
              }}
              busy={busyId === spotlight.definition.id}
              onSetActive={handleSetActive}
              onOpen={(pet) => setDetailId(pet.definition.id)}
            />
          </Reveal>
        ) : null}

        {pets.length > 0 ? (
          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-display text-sm font-semibold">On the shelf</h2>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {visible.length} of {pets.length} shown · pets from Codex are read-only until you
                  add a copy
                </span>
                {filtersActive ? (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="shrink-0 rounded-md border border-border px-2 py-0.5 transition-colors duration-quick hover:bg-accent hover:text-foreground"
                  >
                    Clear filters
                  </button>
                ) : null}
              </p>
            </div>

            <StorefrontToolbar
              query={query}
              onQueryChange={setQuery}
              source={source}
              onSourceChange={setSource}
              kinds={kinds}
              kind={kind}
              onKindChange={setKind}
              order={order}
              onOrderChange={setOrder}
              sourceCounts={sourceCounts}
            />

            {visible.length === 0 ? (
              <NoMatches onClear={clearFilters} />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {visible.map((pet, index) => (
                  <Reveal
                    key={pet.definition.id}
                    variant="rise"
                    delayMs={readStaggerDelay(index)}
                    className="h-full"
                  >
                    <PetCard
                      pet={pet}
                      busy={busyId === pet.definition.id}
                      confirmingRemove={confirmingRemoveId === pet.definition.id}
                      ambiguousName={duplicateNames.has(pet.definition.displayName)}
                      onOpen={(target) => setDetailId(target.definition.id)}
                      onSetActive={handleSetActive}
                      onAddCopy={handleAddCopy}
                      onRemove={handleRemove}
                      onHide={(target) => handleHide(target, true)}
                    />
                  </Reveal>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {hiddenPets.length > 0 ? (
          <section className="space-y-2">
            <button
              type="button"
              onClick={() => setShowHidden((current) => !current)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors duration-quick hover:text-foreground"
            >
              {showHidden ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {hiddenPets.length} hidden {hiddenPets.length === 1 ? 'pet' : 'pets'} — still on disk,
              just not in your library
            </button>

            {showHidden ? (
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {hiddenPets.map((pet) => (
                  <li
                    key={pet.definition.id}
                    data-tails-part="card"
                    className="flex items-center gap-3 p-2.5"
                  >
                    <PetThumbnail pet={pet} size={36} className="opacity-60" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{pet.definition.displayName}</p>
                      <p className="truncate text-[11px] text-muted-foreground" title={pet.directory}>
                        {pet.definition.id}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleHide(pet, false)}
                      disabled={busyId === pet.definition.id}
                      className="shrink-0 rounded-md border border-border px-2 py-1 text-xs transition-colors duration-quick hover:bg-accent disabled:opacity-50"
                    >
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {library && library.problems.length > 0 ? (
          <section className="space-y-1.5">
            <h2 className="font-display text-sm font-semibold">Folders that could not be read</h2>
            {library.problems.map((problem) => (
              <p
                key={problem.directory}
                className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning"
              >
                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                <span>
                  <span className="font-medium">{problem.directory}</span> — {problem.message}
                </span>
              </p>
            ))}
          </section>
        ) : null}

        <div className="border-t border-border pt-5">
          <CatalogueShelf
            page={catalogue}
            loading={catalogueLoading}
            query={catalogueQuery}
            onQueryChange={setCatalogueQuery}
            onPageChange={setCataloguePage}
            onRetry={() => setCatalogueToken((current) => current + 1)}
            installedIds={installedIds}
            installingId={installingId}
            onInstall={handleInstallFromCatalogue}
          />
        </div>

        <p className="text-[11px] text-muted-foreground">
          Pets in <code className="rounded bg-muted px-1 py-0.5">.codex</code> belong to Codex and
          are never modified or deleted. Adding a copy is how you get one you can retime and remove.
        </p>
      </div>

      {detailPet ? (
        <PetDetailDialog
          pet={detailPet}
          busy={busyId === detailPet.definition.id}
          confirmingRemove={confirmingRemoveId === detailPet.definition.id}
          onClose={() => {
            setDetailId(null);
            setConfirmingRemoveId(null);
          }}
          onSetActive={handleSetActive}
          onAddCopy={handleAddCopy}
          onRemove={handleRemove}
          onHide={(target) => handleHide(target, true)}
          onRefresh={refresh}
          onSaveLayout={handleSaveLayout}
        />
      ) : null}

      {importing ? (
        <ImportPetDialog
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}
