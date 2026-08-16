import {
  ChevronLeft,
  ChevronRight,
  Check,
  Download,
  Eye,
  Globe,
  Heart,
  Loader2,
  PawPrint,
  RefreshCw,
  Search,
  WifiOff,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Reveal, useReducedMotion } from '@/shared/ui/Motion';
import { readStaggerDelay } from '@/theme/motion';

import { CataloguePreview } from './CataloguePreview';
import { PetGlow } from './PetGlow';
import type { CatalogueEntry, CataloguePage } from './marketplace-api';
import { endPetDrag, startPetDrag } from './pet-drag';
import { Pill } from './Pill';
import { parallaxStyle, usePointerLocal } from './use-pointer-local';

/**
 * The codex-pets.net shelf.
 *
 * A real storefront over a real API: 3,040 pets, sorted by view count, browsed
 * a page at a time with the top 50 as the landing shelf. Nothing is bulk
 * imported — at roughly 1.7MB per pet that would be about five gigabytes — so
 * a pet is downloaded when someone asks for that pet.
 *
 * Every request goes through our own server, including the thumbnails, so the
 * renderer never talks to the remote host and a dead network produces one
 * designed state here rather than a grid of broken images.
 */

type CatalogueShelfProps = {
  page: CataloguePage | null;
  /** True while a page request is in flight; the shelf dims rather than emptying. */
  loading: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onPageChange: (page: number) => void;
  onRetry: () => void;
  /** Ids already on disk, so an installed pet is never offered for install again. */
  installedIds: Set<string>;
  installingId: string | null;
  onInstall: (entry: CatalogueEntry) => void;
};

const SHIMMER = 'animate-shimmer bg-gradient-to-r from-muted via-accent to-muted bg-[length:200%_100%]';

const compact = (value: number): string => value.toLocaleString(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function ShelfHeader({
  status,
  tone,
  children,
}: {
  status: string;
  tone: 'neutral' | 'warning' | 'positive';
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="flex items-center gap-1.5 font-display text-sm font-semibold">
        <Globe className="size-3.5" aria-hidden="true" /> codex-pets.net
      </h2>
      <Pill tone={tone}>{status}</Pill>
      {children}
    </div>
  );
}

function SkeletonRow() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((slot) => (
        <li key={slot} data-tails-part="card" className="overflow-hidden">
          <div className={`h-28 ${SHIMMER}`} />
          <div className="space-y-2 p-3">
            <div className={`h-3.5 w-2/3 rounded ${SHIMMER}`} />
            <div className={`h-3 w-full rounded ${SHIMMER}`} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * One remote pet.
 *
 * Shows the poster — one cell — and plays the catalogue's filmstrip while the
 * pointer is over the card. The full spritesheet is 1.7MB and is not fetched
 * until the pet is installed; fifty of those to render a page would be 85MB.
 */
function CatalogueCard({
  entry,
  installed,
  installing,
  onInstall,
}: {
  entry: CatalogueEntry;
  installed: boolean;
  installing: boolean;
  onInstall: (entry: CatalogueEntry) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const reduced = useReducedMotion();
  const stageRef = usePointerLocal<HTMLDivElement>(hovered && !reduced);

  return (
    <div
      data-tails-part="card"
      draggable
      onDragStart={(event) => startPetDrag(event, {
        kind: installed ? 'installed' : 'catalogue',
        id: entry.id,
        displayName: entry.displayName,
      })}
      onDragEnd={endPetDrag}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`Drag ${entry.displayName} onto a chat to install and assign it`}
      className={cn(
        // The grab cursor belongs on the sprite, not the whole card — see the
        // same change in PetCard.
        'flex h-full flex-col overflow-hidden',
        'transition-transform duration-quick ease-standard',
        'hover:-translate-y-1 hover:outline hover:outline-2 hover:-outline-offset-2 hover:outline-primary/40',
      )}
    >
      <div
        ref={stageRef}
        className="relative flex h-28 cursor-grab items-center justify-center bg-gradient-to-b from-muted/70 to-transparent active:cursor-grabbing"
      >
        {/* The same component the installed cards use — the two shelves light
            up identically, and there is one place to change it. */}
        <PetGlow active={hovered} />

        {/* `z-10` is load-bearing: the poster is a statically positioned image,
            and an absolutely positioned sibling paints above one of those. That
            is why the glow was in front of these pets and behind the others. */}
        <div
          className={cn(
            'relative z-10',
            !reduced && 'transition-transform duration-quick ease-standard',
          )}
          style={hovered && !reduced ? parallaxStyle(6) : undefined}
        >
          {entry.posterUrl || entry.stripUrl ? (
            <CataloguePreview entry={entry} size={96} hovered={hovered} />
          ) : (
            <PawPrint className="size-6 text-muted-foreground/40" aria-hidden="true" />
          )}
        </div>
        {installed ? (
          <Pill tone="positive" className="absolute left-2 top-2 z-10">
            <Check className="size-2.5" aria-hidden="true" /> Installed
          </Pill>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h3 className="truncate text-sm font-medium">{entry.displayName}</h3>
          {entry.kind ? <Pill>{entry.kind}</Pill> : null}
        </div>

        {entry.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
        ) : null}

        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
          {entry.views === null ? null : (
            <span className="inline-flex items-center gap-1">
              <Eye className="size-3" aria-hidden="true" /> {compact(entry.views)}
            </span>
          )}
          {entry.likes === null ? null : (
            <span className="inline-flex items-center gap-1">
              <Heart className="size-3" aria-hidden="true" /> {compact(entry.likes)}
            </span>
          )}
          {entry.downloads ? (
            <span className="inline-flex items-center gap-1">
              <Download className="size-3" aria-hidden="true" /> {compact(entry.downloads)}
            </span>
          ) : null}
          {entry.ownerHandle ? <span className="truncate">by {entry.ownerHandle}</span> : null}
        </p>

        {entry.tags.length > 0 ? (
          <p className="flex flex-wrap gap-1">
            {entry.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {tag}
              </span>
            ))}
          </p>
        ) : null}

        <div className="mt-auto pt-1.5">
          {installed ? (
            <p className="text-[11px] text-muted-foreground">Already in your library.</p>
          ) : (
            <button
              type="button"
              onClick={() => onInstall(entry)}
              disabled={installing}
              className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-60"
            >
              {installing
                ? <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                : <Download className="size-3" aria-hidden="true" />}
              {installing ? 'Installing…' : 'Install'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function CatalogueShelf({
  page,
  loading,
  query,
  onQueryChange,
  onPageChange,
  onRetry,
  installedIds,
  installingId,
  onInstall,
}: CatalogueShelfProps) {
  if (!page && loading) {
    return (
      <section className="space-y-3">
        <ShelfHeader status="loading" tone="neutral" />
        <SkeletonRow />
      </section>
    );
  }

  if (!page) return null;

  if (!page.configured) {
    return (
      <section className="space-y-3">
        <ShelfHeader status="turned off" tone="neutral" />
        <p className="max-w-prose text-xs text-muted-foreground">
          Browsing the shared library is switched off:{' '}
          <code className="rounded bg-muted px-1 py-0.5">TAILS_PET_CATALOGUE_URL</code> is set to
          nothing, so this machine makes no requests to a catalogue. Clear the variable to get the
          default library back, or point it at a mirror.
        </p>
      </section>
    );
  }

  const search = (
    <div className="relative min-w-[12rem] flex-1">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={`Search ${page.total ? page.total.toLocaleString() : 'the'} pets`}
        aria-label="Search the catalogue"
        data-tails-part="input"
        className="w-full py-1.5 pl-8 pr-8 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      {query ? (
        <button
          type="button"
          onClick={() => onQueryChange('')}
          aria-label="Clear catalogue search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors duration-quick hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );

  if (page.error) {
    return (
      <section className="space-y-3">
        <ShelfHeader status="offline" tone="warning" />
        <div
          data-tails-critical
          className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-8 text-center"
        >
          <WifiOff className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">The catalogue is out of reach</p>
          <p className="max-w-md text-xs text-muted-foreground">{page.error}</p>
          <p className="max-w-md text-xs text-muted-foreground">
            Your installed pets are unaffected — they live on this machine.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs transition-colors duration-quick hover:bg-accent"
          >
            <RefreshCw className="size-3" aria-hidden="true" /> Try again
          </button>
        </div>
      </section>
    );
  }

  const first = (page.page - 1) * page.pageSize + 1;
  const last = Math.min(page.total, first + page.entries.length - 1);

  return (
    <section className={cn('space-y-3', loading && 'opacity-60')}>
      <ShelfHeader status={`${page.total.toLocaleString()} pets`} tone="positive">
        <span className="text-xs text-muted-foreground">
          {page.query
            ? `Matching “${page.query}”`
            : page.page === 1 ? 'Top 50 by views' : 'Most viewed'}
        </span>
      </ShelfHeader>

      <div className="flex flex-wrap items-center gap-2">
        {search}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => onPageChange(page.page - 1)}
            disabled={page.page <= 1 || loading}
            aria-label="Previous page"
            className="rounded-md border border-border p-1.5 transition-colors duration-quick hover:bg-accent disabled:opacity-40"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="tabular-nums">
            {page.entries.length > 0 ? `${first.toLocaleString()}–${last.toLocaleString()}` : '0'}
            {' of '}
            {page.total.toLocaleString()}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(page.page + 1)}
            disabled={page.page >= page.totalPages || loading}
            aria-label="Next page"
            className="rounded-md border border-border p-1.5 transition-colors duration-quick hover:bg-accent disabled:opacity-40"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>

      {page.entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-8 text-center">
          <Search className="size-5 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">
            {page.query ? `Nothing there matches “${page.query}”` : 'The catalogue listed no pets'}
          </p>
          {page.query ? (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              className="rounded-md border border-border px-2.5 py-1 text-xs transition-colors duration-quick hover:bg-accent"
            >
              Clear search
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {page.entries.map((entry, index) => (
            <Reveal
              key={entry.id}
              as="li"
              variant="fade"
              delayMs={readStaggerDelay(index)}
            >
              <CatalogueCard
                entry={entry}
                installed={installedIds.has(entry.id)}
                installing={installingId === entry.id}
                onInstall={onInstall}
              />
            </Reveal>
          ))}
        </ul>
      )}

      <p className="text-[11px] text-muted-foreground">
        Browsed live from {page.baseUrl}. Installing downloads that one pet — about 1.7MB — and
        writes it to your own pets folder.
      </p>
    </section>
  );
}
