import { Check, Info, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

import type { InstalledPet } from './marketplace-api';
import { describeGrid, frameCount, SOURCE_LABEL } from './pet-filters';
import { PetStage } from './PetStage';
import { Pill } from './Pill';

/**
 * The window display.
 *
 * A shop leads with one thing at full size, and here that thing is whichever
 * pet is currently on screen — or, when none is, the first one on the shelf
 * offered as the obvious way to start. Both cases are the same layout so
 * activating a pet does not make the page jump.
 *
 * The counts underneath are the only numbers in this marketplace, and they are
 * counted from the library rather than reported by anyone: there is no rating,
 * no install count and no popularity to show, because nothing supplies them.
 */

type PetSpotlightProps = {
  pet: InstalledPet;
  counts: { total: number; yours: number; codex: number };
  busy: boolean;
  onSetActive: (pet: InstalledPet) => void;
  onOpen: (pet: InstalledPet) => void;
};

export function PetSpotlight({ pet, counts, busy, onSetActive, onOpen }: PetSpotlightProps) {
  const [hovered, setHovered] = useState(false);
  const { definition } = pet;

  return (
    <section
      data-tails-part="card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn('overflow-hidden', busy && 'pointer-events-none opacity-60')}
    >
      <div className="grid gap-0 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        {/* The same reactions as the cards: a wave instead of the idle loop, the
            glow and grid behind, and the lean toward the pointer. */}
        <PetStage
          pet={pet}
          height={168}
          state={hovered ? 'waving' : 'idle'}
          glow={hovered}
          className="h-56 w-full md:h-full md:min-h-[15rem]"
        />

        <div className="flex min-w-0 flex-col justify-center gap-3 p-5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {pet.active ? (
              <>
                <Check className="size-3" aria-hidden="true" /> On screen now
              </>
            ) : (
              <>
                <Sparkles className="size-3" aria-hidden="true" /> Nothing on screen — start here
              </>
            )}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-2xl font-semibold tracking-tight">
              {definition.displayName}
            </h2>
            <Pill tone={pet.source === 'tails' ? 'positive' : 'neutral'} title={pet.directory}>
              {SOURCE_LABEL[pet.source]}
            </Pill>
            {definition.kind ? <Pill>{definition.kind}</Pill> : null}
          </div>

          {definition.description ? (
            <p className="max-w-prose text-sm text-muted-foreground">{definition.description}</p>
          ) : null}

          <p className="text-xs text-muted-foreground">
            {frameCount(pet)} frames · {describeGrid(pet)}
            {definition.author ? ` · by ${definition.author}` : ''}
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => onSetActive(pet)}
              className={cn(
                'rounded-md px-3.5 py-2 text-sm font-medium transition-transform duration-instant ease-emphasis active:scale-95',
                pet.active
                  ? 'border border-border hover:bg-accent'
                  : 'bg-primary text-primary-foreground',
              )}
            >
              {pet.active ? 'Take off screen' : `Put ${definition.displayName} on screen`}
            </button>
            <button
              type="button"
              onClick={() => onOpen(pet)}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm transition-colors duration-quick hover:bg-accent"
            >
              <Info className="size-3.5" aria-hidden="true" /> Details
            </button>
          </div>

          <p className="pt-1 text-[11px] text-muted-foreground">
            {counts.total} {counts.total === 1 ? 'pet' : 'pets'} in the library · {counts.yours} yours
            {' · '}
            {counts.codex} from Codex
          </p>
        </div>
      </div>
    </section>
  );
}
