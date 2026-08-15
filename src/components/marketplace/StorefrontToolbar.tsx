import { Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';

import {
  SORT_ORDERS,
  SOURCE_FILTERS,
  type SortOrder,
  type SourceFilter,
} from './pet-filters';

/**
 * Search, shelves and sorting.
 *
 * The three controls a shop needs and no more. Category chips are built from
 * the `kind` values the installed pets actually declare, so the row is empty
 * when nothing is categorised rather than offering departments with nothing in
 * them.
 */

type StorefrontToolbarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  source: SourceFilter;
  onSourceChange: (value: SourceFilter) => void;
  /** Distinct `kind` values across the library; the row hides itself when empty. */
  kinds: string[];
  kind: string | null;
  onKindChange: (value: string | null) => void;
  order: SortOrder;
  onOrderChange: (value: SortOrder) => void;
  /** Per-shelf totals, so a tab can say how much is behind it before it is clicked. */
  sourceCounts: Record<SourceFilter, number>;
};

const CHIP_CLASS = 'rounded-full border px-2.5 py-1 text-xs transition-colors duration-quick';

export function StorefrontToolbar({
  query,
  onQueryChange,
  source,
  onSourceChange,
  kinds,
  kind,
  onKindChange,
  order,
  onOrderChange,
  sourceCounts,
}: StorefrontToolbarProps) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search pets by name, kind or author"
            aria-label="Search pets"
            data-tails-part="input"
            className="w-full py-1.5 pl-8 pr-8 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {query ? (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors duration-quick hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          {SOURCE_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onSourceChange(option.value)}
              aria-pressed={source === option.value}
              className={cn(
                'rounded px-2.5 py-1 text-xs transition-colors duration-quick',
                source === option.value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {option.label}
              <span className="ml-1 tabular-nums opacity-70">{sourceCounts[option.value]}</span>
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Sort
          <select
            value={order}
            onChange={(event) => onOrderChange(event.target.value as SortOrder)}
            aria-label="Sort pets"
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            {SORT_ORDERS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      {kinds.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onKindChange(null)}
            aria-pressed={kind === null}
            className={cn(
              CHIP_CLASS,
              kind === null
                ? 'border-primary bg-primary/15 text-primary'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            All kinds
          </button>
          {kinds.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onKindChange(kind === value ? null : value)}
              aria-pressed={kind === value}
              className={cn(
                CHIP_CLASS,
                'capitalize',
                kind === value
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {value}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
