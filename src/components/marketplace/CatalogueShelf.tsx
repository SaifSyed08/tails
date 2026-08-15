import { Eye, Globe, PawPrint, RefreshCw } from 'lucide-react';

import type { CatalogueResult } from './marketplace-api';
import { Pill } from './Pill';

/**
 * The codex-pet.net shelf.
 *
 * The stated goal is browsing that library — or at least its top 100 pets by
 * views — from in here. **No public endpoint for it has been confirmed**, so
 * this shelf has nothing real to put out, and the one thing it must not do is
 * fill itself with plausible-looking pets. Everything a fake row would earn in
 * the first ten seconds it loses the moment someone clicks one.
 *
 * So the unconfigured case is drawn as an empty display case: outlines where
 * stock will go, a plain account of what is missing, and the environment
 * variable that switches it on. It reads as a shelf awaiting delivery rather
 * than as a section that failed to load.
 */

type CatalogueShelfProps = {
  result: CatalogueResult | null;
  onRetry: () => void;
};

const SHIMMER = 'animate-shimmer bg-gradient-to-r from-muted via-accent to-muted bg-[length:200%_100%]';

/** Outlines, not products: no name, no number, nothing to mistake for stock. */
function EmptyCase() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-hidden="true">
      {[0, 1, 2, 3].map((slot) => (
        <li
          key={slot}
          className="flex h-28 items-center justify-center rounded-lg border border-dashed border-border"
        >
          <PawPrint className="size-6 text-muted-foreground/30" />
        </li>
      ))}
    </ul>
  );
}

function ShelfHeader({ status, tone }: { status: string; tone: 'neutral' | 'warning' | 'positive' }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="flex items-center gap-1.5 font-display text-sm font-semibold">
        <Globe className="size-3.5" aria-hidden="true" /> codex-pet.net library
      </h2>
      <Pill tone={tone}>{status}</Pill>
    </div>
  );
}

export function CatalogueShelf({ result, onRetry }: CatalogueShelfProps) {
  if (!result) {
    return (
      <section className="space-y-3">
        <ShelfHeader status="checking" tone="neutral" />
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((slot) => (
            <li key={slot} className={`h-28 rounded-lg ${SHIMMER}`} />
          ))}
        </ul>
      </section>
    );
  }

  if (!result.configured) {
    return (
      <section className="space-y-3">
        <ShelfHeader status="coming soon" tone="neutral" />
        <p className="max-w-prose text-xs text-muted-foreground">
          Browsing the shared library — the plan is its top 100 pets by views — needs a catalogue
          URL in <code className="rounded bg-muted px-1 py-0.5">TAILS_PET_CATALOGUE_URL</code>. No
          public API for codex-pet.net has been confirmed, so this shelf is deliberately empty
          rather than stocked with pets that do not exist. Set the variable once a real endpoint is
          known and it fills itself in. Until then, importing a folder puts any pet you already have
          on the shelf above.
        </p>
        <EmptyCase />
      </section>
    );
  }

  if (result.error) {
    return (
      <section className="space-y-3">
        <ShelfHeader status="unreachable" tone="warning" />
        <div
          data-tails-critical
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1">{result.error}</span>
          <button
            type="button"
            onClick={onRetry}
            className="flex items-center gap-1.5 rounded-md border border-destructive/40 px-2 py-1 transition-colors duration-quick hover:bg-destructive/10"
          >
            <RefreshCw className="size-3" aria-hidden="true" /> Try again
          </button>
        </div>
      </section>
    );
  }

  if (result.entries.length === 0) {
    return (
      <section className="space-y-3">
        <ShelfHeader status="empty" tone="neutral" />
        <p className="text-xs text-muted-foreground">
          The catalogue at {result.baseUrl} answered, but listed no pets.
        </p>
        <EmptyCase />
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <ShelfHeader status={`${result.entries.length} pets`} tone="positive" />
      <p className="text-xs text-muted-foreground">
        Listed by {result.baseUrl}. Installing straight from a catalogue is not wired up yet, so
        these are browse-only — download a pet folder and import it from the button above.
      </p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {result.entries.map((entry) => (
          <li key={entry.id} data-tails-part="card" className="flex flex-col overflow-hidden">
            {entry.previewUrl ? (
              <img
                src={entry.previewUrl}
                alt=""
                loading="lazy"
                className="h-28 w-full bg-muted/40 object-contain"
                style={{ imageRendering: 'pixelated' }}
              />
            ) : (
              <div className="flex h-28 items-center justify-center bg-muted/40">
                <PawPrint className="size-6 text-muted-foreground/40" aria-hidden="true" />
              </div>
            )}
            <div className="flex flex-1 flex-col gap-1 p-3">
              <p className="truncate text-sm font-medium">{entry.displayName}</p>
              {entry.description ? (
                <p className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
              ) : null}
              {entry.views === null ? null : (
                <p className="mt-auto flex items-center gap-1 pt-1 text-[11px] text-muted-foreground">
                  <Eye className="size-3" aria-hidden="true" /> {entry.views.toLocaleString()} views
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
