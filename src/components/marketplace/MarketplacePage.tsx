import { AlertTriangle, PawPrint, Plus, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import { Reveal } from '@/shared/ui/Motion';
import { readStaggerDelay } from '@/theme/motion';

import { CatalogueShelf } from './CatalogueShelf';
import { ImportPetDialog } from './ImportPetDialog';
import { LibraryEmpty, LibrarySkeleton, NoMatches } from './LibraryStates';
import {
  petsApi,
  type CatalogueResult,
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
 * Two rules constrain what it is allowed to show. Nothing here is invented:
 * there are no ratings, no download counts and no placeholder pets, because
 * nothing supplies them and a storefront that lies about its stock is worse
 * than a small one. And every pet's frame layout is labelled with where it came
 * from, because Codex spritesheets do not describe their own layout, so most of
 * these animations are the app's best guess and the user is the one who can
 * correct it.
 */

export type MarketplacePageProps = {
  /** Renders a close control when provided — omit it when the page owns the viewport. */
  onClose?: () => void;
  className?: string;
};

export function MarketplacePage({ onClose, className }: MarketplacePageProps) {
  const [library, setLibrary] = useState<PetLibrary | null>(null);
  const [catalogue, setCatalogue] = useState<CatalogueResult | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [kind, setKind] = useState<string | null>(null);
  const [order, setOrder] = useState<SortOrder>('name');

  // Reloads are requested by bumping a token rather than by calling a fetcher
  // directly, which keeps every state write inside a promise callback instead
  // of running synchronously as the effect body.
  const [reloadToken, setReloadToken] = useState(0);
  const [catalogueToken, setCatalogueToken] = useState(0);
  const refresh = useCallback(() => setReloadToken((current) => current + 1), []);

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

  // Separate from the pet list: a slow or dead remote must not hold up the
  // gallery, and its failure is reported on its own shelf.
  useEffect(() => {
    let cancelled = false;

    petsApi.listCatalogue()
      .then((next) => {
        if (!cancelled) setCatalogue(next);
      })
      .catch(() => {
        if (cancelled) return;
        setCatalogue({ configured: false, baseUrl: null, entries: [], error: null });
      });

    return () => {
      cancelled = true;
    };
  }, [catalogueToken]);

  const runAction = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'That did not work.');
    } finally {
      setBusyId(null);
    }
  };

  const handleSetActive = (pet: InstalledPet) => {
    void runAction(pet.definition.id, () => petsApi.setActive(pet.definition.id, !pet.active));
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
  const kinds = useMemo(() => collectKinds(pets), [pets]);
  const visible = useMemo(
    () => sortPets(filterPets(pets, { query, source, kind }), order),
    [pets, query, source, kind, order],
  );

  const sourceCounts: Record<SourceFilter, number> = {
    all: countBySource(pets, 'all'),
    tails: countBySource(pets, 'tails'),
    codex: countBySource(pets, 'codex'),
  };

  // The window display ignores the filters: it shows whoever is on screen, or
  // the first pet as the obvious way to put someone there. Searching should not
  // empty the shop window.
  const spotlight = pets.find((pet) => pet.active) ?? pets[0] ?? null;
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
                      onOpen={(target) => setDetailId(target.definition.id)}
                      onSetActive={handleSetActive}
                      onAddCopy={handleAddCopy}
                      onRemove={handleRemove}
                    />
                  </Reveal>
                ))}
              </div>
            )}
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
            result={catalogue}
            onRetry={() => {
              setCatalogue(null);
              setCatalogueToken((current) => current + 1);
            }}
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
