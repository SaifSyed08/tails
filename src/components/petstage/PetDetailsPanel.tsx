import { EyeOff, Monitor, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { PetSprite, type InstalledPet, type PetStateName } from '@/components/marketplace';
import { describeGrid, formatAdded, SOURCE_LABEL } from '@/components/marketplace/pet-filters';
import { cn } from '@/lib/utils';

import { MAX_PET_SCALE, MIN_PET_SCALE, type PetStage } from './chat-pet-api';

/**
 * The pet's own page, opened from his pill.
 *
 * What the marketplace's detail dialog is for a pet you are *choosing*, this is
 * for the pet you already have standing next to you: who he is, how his sheet
 * is cut, what he can do — playable rather than described, because "waving:
 * frames 24-27" tells you nothing about whether the wave is any good — and the
 * two settings that are about him being here rather than about him existing.
 *
 * It is a panel rather than the small menu it replaces because the menu could
 * only ever hold a list, and a list is the wrong shape for "show me this pet".
 * It deliberately borrows the marketplace's furniture — the same card, the same
 * fact rows, the same formatters — so the same pet does not describe himself
 * two different ways in two places.
 *
 * Fields with no value are left out rather than shown empty: most pets carry no
 * author, and "Author: unknown" is a page full of the absence of data.
 */

export type PetDetailsPanelProps = {
  pet: InstalledPet;
  stage: PetStage;
  onChange: (stage: PetStage) => void;
  onClose: () => void;
  /** Puts him on the desktop, out of the chat. Absent when he is already there. */
  onSendToDesktop?: () => void;
  onHide: () => void;
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 border-b border-border py-1.5 last:border-b-0">
      <dt className="w-24 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 break-words text-xs">{children}</dd>
    </div>
  );
}

export function PetDetailsPanel({
  pet,
  stage,
  onChange,
  onClose,
  onSendToDesktop,
  onHide,
}: PetDetailsPanelProps) {
  const { definition } = pet;
  const [previewState, setPreviewState] = useState<PetStateName>('idle');

  // Only the rows this sheet actually has. A pet with nine animations and a pet
  // with eleven are both correct, and offering a button for a row that is not
  // there would play the fallback and look like a bug in the sprite.
  const states = Object.keys(definition.states) as PetStateName[];
  const added = formatAdded(pet.installedAt);

  return createPortal(
    <div
      data-tails-part="scrim"
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        data-tails-part="card"
        role="dialog"
        aria-label={`${definition.displayName} details`}
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-display text-sm font-semibold">{definition.displayName}</h2>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {SOURCE_LABEL[pet.source]}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close pet details"
            className="rounded-md p-1.5 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <div className="flex items-end justify-center rounded-lg border border-border bg-muted/30 py-3">
            <PetSprite pet={pet} size={112} state={previewState} />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {states.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setPreviewState(name)}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-quick',
                  name === previewState
                    ? 'border-primary bg-primary/15 text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {name}
              </button>
            ))}
          </div>

          {definition.description ? (
            <p className="text-xs text-muted-foreground">{definition.description}</p>
          ) : null}

          <dl>
            {definition.author ? <Fact label="Author">{definition.author}</Fact> : null}
            <Fact label="Sheet">{describeGrid(pet)}</Fact>
            <Fact label="Animations">{states.length}</Fact>
            {added ? <Fact label="Added">{added}</Fact> : null}
          </dl>

          <section className="space-y-3 rounded-lg border border-border p-3">
            <h3 className="font-display text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              On screen
            </h3>

            <label className="block space-y-1 text-sm">
              <span className="flex items-baseline justify-between">
                <span>Size</span>
                <span className="text-xs text-muted-foreground">
                  {Math.round(stage.scale * 100)}%
                </span>
              </span>
              <input
                type="range"
                min={MIN_PET_SCALE}
                max={MAX_PET_SCALE}
                step={0.05}
                value={stage.scale}
                onChange={(event) => onChange({ ...stage, scale: Number(event.target.value) })}
                className="w-full accent-primary"
              />
            </label>

            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                Wander
                <span className="block text-xs text-muted-foreground">
                  He strolls about when nothing is happening.
                </span>
              </span>
              <input
                type="checkbox"
                checked={stage.walks}
                onChange={(event) => onChange({ ...stage, walks: event.target.checked })}
                className="size-4 accent-primary"
              />
            </label>
          </section>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
          {onSendToDesktop ? (
            <button
              type="button"
              onClick={onSendToDesktop}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
            >
              <Monitor className="size-3.5" aria-hidden="true" />
              Put on the desktop
            </button>
          ) : <span />}

          <button
            type="button"
            onClick={onHide}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <EyeOff className="size-3.5" aria-hidden="true" />
            Hide him
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
