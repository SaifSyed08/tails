import { PawPrint, Plus, SearchX } from 'lucide-react';

/**
 * The three states a shelf can be in that are not "here are your pets".
 *
 * Drawn rather than left blank, because each one is a different problem and a
 * bare gap answers none of them: nothing loaded yet, nothing installed at all,
 * or nothing matching what was typed. The first is the only one that should
 * look like waiting, so it is the only one that shimmers.
 */

const SHIMMER = 'animate-shimmer bg-gradient-to-r from-muted via-accent to-muted bg-[length:200%_100%]';

/** Mirrors the real card's proportions so the grid does not jump when pets land. */
export function LibrarySkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {[0, 1, 2, 3, 4, 5].map((slot) => (
        <div key={slot} data-tails-part="card" className="overflow-hidden">
          <div className={`h-36 ${SHIMMER}`} />
          <div className="space-y-2 p-3">
            <div className={`h-3.5 w-2/3 rounded ${SHIMMER}`} />
            <div className={`h-3 w-full rounded ${SHIMMER}`} />
            <div className={`h-6 w-24 rounded-md ${SHIMMER}`} />
          </div>
        </div>
      ))}
    </div>
  );
}

type LibraryEmptyProps = {
  sources: { codex: string; tails: string };
  onImport: () => void;
};

export function LibraryEmpty({ sources, onImport }: LibraryEmptyProps) {
  return (
    <div data-tails-part="card" className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-muted/60">
        <PawPrint className="size-7 text-muted-foreground" aria-hidden="true" />
      </div>
      <div>
        <h2 className="font-display text-lg font-semibold">The shelf is empty</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          A pet is a spritesheet plus a small manifest, so getting one in here is copying a folder.
          Import one and it appears with a live preview.
        </p>
      </div>
      <button
        type="button"
        onClick={onImport}
        className="flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95"
      >
        <Plus className="size-4" aria-hidden="true" /> Import a pet
      </button>
      <p className="mx-auto max-w-lg text-[11px] text-muted-foreground">
        Scanned on every refresh: <code className="rounded bg-muted px-1 py-0.5">{sources.codex}</code>
        {' and '}
        <code className="rounded bg-muted px-1 py-0.5">{sources.tails}</code>
      </p>
    </div>
  );
}

export function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <SearchX className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">No pet matches those filters</p>
      <button
        type="button"
        onClick={onClear}
        className="rounded-md border border-border px-2.5 py-1 text-xs transition-colors duration-quick hover:bg-accent"
      >
        Clear filters
      </button>
    </div>
  );
}
