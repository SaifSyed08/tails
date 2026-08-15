import { AlertTriangle, Check, Globe, PawPrint, Plus, RefreshCw, Sliders, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { Reveal } from '@/shared/ui/Motion';

import { FrameGridEditor } from './FrameGridEditor';
import { ImportPetDialog } from './ImportPetDialog';
import {
  petsApi,
  type CatalogueResult,
  type FrameGrid,
  type InstalledPet,
  type PetGridBasis,
  type PetLibrary,
  type PetStates,
} from './marketplace-api';
import { SPRITE_KEYFRAMES, SpritePreview } from './SpritePreview';

/**
 * The pets marketplace.
 *
 * Self-contained: it owns its data fetching, its dialogs and its styles, and
 * takes no required props, so mounting it anywhere in the app is a one-liner.
 *
 * The design problem it solves is honesty about an undocumented format. Codex
 * spritesheets carry no description of their own frame layout, so every pet in
 * this gallery is animated according to a guess. Each card therefore says where
 * its layout came from and offers to have it corrected, rather than presenting
 * an inference as a fact and leaving a mis-cut pet looking like a broken app.
 */

export type MarketplacePageProps = {
  /** Renders a close control when provided — omit it when the page owns the viewport. */
  onClose?: () => void;
  className?: string;
};

/** What each inference tier means, in words a user can act on. */
const GRID_BASIS_NOTE: Record<PetGridBasis, string> = {
  authored: 'Layout set by you or declared by the pet file.',
  'codex-cell-pitch': 'Layout inferred from the 192x208 cell pitch used by Codex pets.',
  'square-cells': 'Layout guessed as square cells — worth checking.',
  'single-frame': 'Layout could not be worked out, so the whole sheet is one frame.',
};

const GRID_BASIS_TONE: Record<PetGridBasis, string> = {
  authored: 'text-muted-foreground',
  'codex-cell-pitch': 'text-muted-foreground',
  'square-cells': 'text-warning',
  'single-frame': 'text-warning',
};

type PetCardProps = {
  pet: InstalledPet;
  editing: boolean;
  confirmingRemove: boolean;
  busy: boolean;
  onEdit: (id: string | null) => void;
  onSave: (id: string, patch: { frame: FrameGrid; states: PetStates }) => Promise<void>;
  onSetActive: (pet: InstalledPet) => void;
  onRemove: (pet: InstalledPet) => void;
};

function PetCard({
  pet,
  editing,
  confirmingRemove,
  busy,
  onEdit,
  onSave,
  onSetActive,
  onRemove,
}: PetCardProps) {
  const { definition } = pet;

  return (
    <div
      data-tails-part="card"
      className={cn(
        'flex flex-col gap-3 p-4 transition-colors duration-quick',
        pet.active && 'ring-2 ring-primary',
        busy && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-4">
        <div className="flex size-28 items-end justify-center overflow-hidden rounded-lg bg-muted/40">
          <SpritePreview
            spriteUrl={pet.spriteUrl}
            grid={definition.frame}
            range={definition.states.idle}
            height={104}
          />
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
            {definition.displayName}
            <span
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
              title={pet.directory}
            >
              {pet.source === 'codex' ? 'from codex' : 'yours'}
            </span>
            {definition.kind ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {definition.kind}
              </span>
            ) : null}
            {pet.active ? (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                active
              </span>
            ) : null}
          </p>

          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{definition.description}</p>

          <p className={cn('mt-1.5 text-[11px]', GRID_BASIS_TONE[pet.gridBasis])}>
            {definition.frame.columns}x{definition.frame.rows} grid of{' '}
            {definition.frame.width}x{definition.frame.height} cells
            {pet.spriteSize ? ` · sheet ${pet.spriteSize.width}x${pet.spriteSize.height}` : ''}
            {' · '}
            {GRID_BASIS_NOTE[pet.gridBasis]}
          </p>

          {pet.warnings.map((warning) => (
            <p key={warning} className="mt-1 flex items-start gap-1 text-[11px] text-warning">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              {warning}
            </p>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onSetActive(pet)}
          disabled={busy}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-50',
            pet.active
              ? 'border border-border hover:bg-accent'
              : 'bg-primary text-primary-foreground',
          )}
        >
          {pet.active ? 'Stand down' : 'Set active'}
        </button>

        <button
          type="button"
          onClick={() => onEdit(editing ? null : definition.id)}
          className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs transition-colors duration-quick hover:bg-accent"
        >
          <Sliders className="size-3" />
          {editing ? 'Done' : 'Adjust frames'}
        </button>

        {pet.removable ? (
          <button
            type="button"
            onClick={() => onRemove(pet)}
            disabled={busy}
            className={cn(
              'ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors duration-quick disabled:opacity-50',
              confirmingRemove
                ? 'bg-destructive text-destructive-foreground'
                : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
            )}
          >
            <Trash2 className="size-3" />
            {confirmingRemove ? 'Really remove?' : 'Remove'}
          </button>
        ) : (
          <span
            className="ml-auto text-[11px] text-muted-foreground"
            title={`Installed by Codex at ${pet.directory}`}
          >
            read-only
          </span>
        )}
      </div>

      {editing ? (
        <FrameGridEditor
          pet={pet}
          onSave={(patch) => onSave(definition.id, patch)}
          onCancel={() => onEdit(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The remote library.
 *
 * Deliberately empty until someone confirms the real API. The goal is
 * codex-pet.net's top pets by view count, but no public endpoint for that has
 * been established, so this reads `TAILS_PET_CATALOGUE_URL` and says plainly
 * that nothing is configured. An invented list of fake pets would be worse than
 * no list: it would look like a working feature.
 */
function RemoteCatalogue({ result }: { result: CatalogueResult | null }) {
  if (!result) {
    return <p className="text-xs text-muted-foreground">Checking for a remote catalogue…</p>;
  }

  if (!result.configured) {
    return (
      <div className="rounded-xl border border-dashed border-border p-4">
        <p className="text-sm font-medium">No remote catalogue configured</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Browsing a shared pet library needs a catalogue URL in{' '}
          <code className="rounded bg-muted px-1 py-0.5">TAILS_PET_CATALOGUE_URL</code>. The
          codex-pet.net API has not been confirmed yet, so nothing is assumed here — set the
          variable once a real endpoint is known and this section fills itself in.
        </p>
      </div>
    );
  }

  if (result.error) {
    return (
      <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {result.error}
      </p>
    );
  }

  if (result.entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        The catalogue at {result.baseUrl} returned no pets.
      </p>
    );
  }

  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {result.entries.map((entry) => (
        <li key={entry.id} data-tails-part="card" className="p-3">
          <p className="text-sm font-medium">{entry.displayName}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
          {entry.views === null ? null : (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {entry.views.toLocaleString()} views
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function MarketplacePage({ onClose, className }: MarketplacePageProps) {
  const [library, setLibrary] = useState<PetLibrary | null>(null);
  const [catalogue, setCatalogue] = useState<CatalogueResult | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reloads are requested by bumping a token rather than by calling a fetcher
  // directly, which keeps every state write inside a promise callback instead
  // of running synchronously as the effect body.
  const [reloadToken, setReloadToken] = useState(0);
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
  // gallery, and its failure is reported in its own section.
  useEffect(() => {
    let cancelled = false;

    petsApi.listCatalogue()
      .then((next) => {
        if (!cancelled) setCatalogue(next);
      })
      .catch(() => {
        if (cancelled) return;
        setCatalogue({
          configured: false,
          baseUrl: null,
          entries: [],
          error: null,
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

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

  /** Two-step, because removing a pet deletes its folder and there is no undo. */
  const handleRemove = (pet: InstalledPet) => {
    if (confirmingRemoveId !== pet.definition.id) {
      setConfirmingRemoveId(pet.definition.id);
      return;
    }
    setConfirmingRemoveId(null);
    void runAction(pet.definition.id, () => petsApi.removePet(pet.definition.id));
  };

  const handleSaveLayout = async (id: string, patch: { frame: FrameGrid; states: PetStates }) => {
    await petsApi.updatePet(id, patch);
    setEditingId(null);
    refresh();
  };

  const pets = library?.pets ?? [];

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
            Pets
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Pets installed by Codex and by you. Everything here is a spritesheet plus a small
            manifest, so importing one is copying a folder.
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
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {library && pets.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center">
            <p className="text-sm font-medium">No pets yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              T.A.I.L.S. looks in <code className="rounded bg-muted px-1 py-0.5">{library.sources.codex}</code>{' '}
              and <code className="rounded bg-muted px-1 py-0.5">{library.sources.tails}</code>. Import
              a folder or a spritesheet to get started.
            </p>
          </div>
        ) : null}

        <div className="grid gap-3 xl:grid-cols-2">
          {pets.map((pet) => (
            <Reveal key={pet.definition.id} variant="fade">
              <PetCard
                pet={pet}
                editing={editingId === pet.definition.id}
                confirmingRemove={confirmingRemoveId === pet.definition.id}
                busy={busyId === pet.definition.id}
                onEdit={setEditingId}
                onSave={handleSaveLayout}
                onSetActive={handleSetActive}
                onRemove={handleRemove}
              />
            </Reveal>
          ))}
        </div>

        {library && library.problems.length > 0 ? (
          <section className="space-y-1.5">
            <h2 className="text-sm font-semibold">Folders that could not be read</h2>
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

        <section className="space-y-2 border-t border-border pt-5">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Globe className="size-3.5" aria-hidden="true" /> Browse more pets
          </h2>
          <RemoteCatalogue result={catalogue} />
        </section>

        <p className="flex items-start gap-1.5 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <Check className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          Pets in <code className="rounded bg-muted px-1 py-0.5">.codex</code> belong to Codex and are
          never modified or deleted. Import one to get a copy you can edit and remove.
        </p>
      </div>

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
