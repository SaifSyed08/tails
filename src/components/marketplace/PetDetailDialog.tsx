import { AlertTriangle, Check, CopyPlus, EyeOff, Sliders, Trash2, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { FrameGridEditor } from './FrameGridEditor';
import {
  PET_STATE_NAMES,
  type FrameGrid,
  type InstalledPet,
  type PetStateName,
  type PetStates,
} from './marketplace-api';
import {
  describeGrid,
  formatAdded,
  frameCount,
  GRID_BASIS_NOTE,
  isGridUncertain,
  SOURCE_LABEL,
} from './pet-filters';
import { PetStage } from './PetStage';
import { Pill } from './Pill';

/**
 * The product page.
 *
 * Everything the card deliberately left out, in one place: where the pet lives,
 * how its sheet is cut, which animations it actually has, and the destructive
 * actions. Each animation is playable here rather than described, because
 * "walk: frames 8–15" tells the user nothing about whether the walk is right.
 *
 * Fields with no value are omitted rather than shown empty. Most pets carry no
 * author and no personality — printing "Author: unknown" on all of them would
 * be filling a page with the absence of data.
 */

type PetDetailDialogProps = {
  pet: InstalledPet;
  busy: boolean;
  confirmingRemove: boolean;
  onClose: () => void;
  onSetActive: (pet: InstalledPet) => void;
  onAddCopy: (pet: InstalledPet) => void;
  onRemove: (pet: InstalledPet) => void;
  onHide: (pet: InstalledPet) => void;
  onSaveLayout: (id: string, patch: { frame: FrameGrid; states: PetStates }) => Promise<void>;
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 border-b border-border py-1.5 last:border-b-0">
      <dt className="w-28 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 break-words text-xs">{children}</dd>
    </div>
  );
}

export function PetDetailDialog({
  pet,
  busy,
  confirmingRemove,
  onClose,
  onSetActive,
  onAddCopy,
  onRemove,
  onHide,
  onSaveLayout,
}: PetDetailDialogProps) {
  const { definition } = pet;
  const [previewState, setPreviewState] = useState<PetStateName>('idle');
  const [adjusting, setAdjusting] = useState(false);

  // Escape closes, because this opens over a page the user was browsing and
  // reaching for the corner every time is what makes a modal feel like a trap.
  // While the frame editor is open it closes that instead: one keystroke must
  // not discard a layout someone was halfway through correcting.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (adjusting) {
        setAdjusting(false);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [adjusting, onClose]);

  const availableStates = PET_STATE_NAMES.filter((name) => definition.states[name]);
  const addedOn = formatAdded(pet.installedAt);

  return (
    <div
      data-tails-part="scrim"
      className="fixed inset-0 z-50 flex items-start justify-center p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`${definition.displayName} details`}
    >
      <div
        data-tails-part="card"
        className={cn('flex max-h-full w-full max-w-3xl flex-col overflow-hidden', busy && 'opacity-60')}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="truncate font-display text-base font-semibold">{definition.displayName}</h2>
            <Pill tone={pet.source === 'tails' ? 'positive' : 'neutral'}>{SOURCE_LABEL[pet.source]}</Pill>
            {definition.kind ? <Pill>{definition.kind}</Pill> : null}
            {pet.active ? (
              <Pill tone="accent">
                <Check className="size-2.5" aria-hidden="true" /> On screen
              </Pill>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <div className="grid gap-5 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            <div className="space-y-2">
              <PetStage
                pet={pet}
                height={152}
                range={definition.states[previewState] ?? definition.states.idle}
                className="h-52 w-full rounded-lg border border-border"
              />
              <div className="flex flex-wrap gap-1.5">
                {availableStates.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setPreviewState(name)}
                    aria-pressed={previewState === name}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-xs capitalize transition-colors duration-quick',
                      previewState === name
                        ? 'border-primary bg-primary/15 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
              {availableStates.length === 1 ? (
                <p className="text-[11px] text-muted-foreground">
                  Only an idle loop is assigned. The other rows of the sheet are unlabelled — name
                  them under Adjust frames.
                </p>
              ) : null}
            </div>

            <div className="min-w-0 space-y-3">
              {definition.description ? (
                <p className="text-sm text-muted-foreground">{definition.description}</p>
              ) : null}

              <dl className="rounded-lg border border-border px-3 py-1">
                <Fact label="Id"><code className="rounded bg-muted px-1 py-0.5">{definition.id}</code></Fact>
                {definition.author ? <Fact label="Author">{definition.author}</Fact> : null}
                <Fact label="Source">
                  {pet.source === 'tails'
                    ? 'Yours — editable and removable.'
                    : 'Installed by Codex — read-only here.'}
                </Fact>
                <Fact label="Folder">
                  <code className="rounded bg-muted px-1 py-0.5">{pet.directory}</code>
                </Fact>
                <Fact label="Frames">{frameCount(pet)} · {describeGrid(pet)}</Fact>
                {pet.spriteSize ? (
                  <Fact label="Sheet">{pet.spriteSize.width}x{pet.spriteSize.height} px</Fact>
                ) : null}
                <Fact label="Layout">
                  <span className={cn(isGridUncertain(pet.gridBasis) && 'text-warning')}>
                    {GRID_BASIS_NOTE[pet.gridBasis]}
                  </span>
                </Fact>
                {definition.spriteVersionNumber === undefined ? null : (
                  <Fact label="Sheet rev">{definition.spriteVersionNumber}</Fact>
                )}
                {addedOn ? (
                  <Fact label="Added">
                    <span title="When T.A.I.L.S. first recorded this pet, not when the artwork was made.">
                      {addedOn}
                    </span>
                  </Fact>
                ) : null}
                {definition.personality ? (
                  <Fact label="Personality">{definition.personality}</Fact>
                ) : null}
              </dl>

              {pet.warnings.map((warning) => (
                <p key={warning} className="flex items-start gap-1.5 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  {warning}
                </p>
              ))}
            </div>
          </div>

          {adjusting ? (
            <FrameGridEditor
              pet={pet}
              onSave={async (patch) => {
                await onSaveLayout(definition.id, patch);
                setAdjusting(false);
              }}
              onCancel={() => setAdjusting(false)}
            />
          ) : null}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={() => onSetActive(pet)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-transform duration-instant ease-emphasis active:scale-95',
              pet.active
                ? 'border border-border hover:bg-accent'
                : 'bg-primary text-primary-foreground',
            )}
          >
            {pet.active ? 'Stand down' : 'Set active'}
          </button>

          <button
            type="button"
            onClick={() => setAdjusting((current) => !current)}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition-colors duration-quick hover:bg-accent"
          >
            <Sliders className="size-3.5" aria-hidden="true" />
            {adjusting ? 'Close editor' : 'Adjust frames'}
          </button>

          {pet.source === 'codex' ? (
            <button
              type="button"
              onClick={() => onAddCopy(pet)}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition-colors duration-quick hover:bg-accent"
            >
              <CopyPlus className="size-3.5" aria-hidden="true" /> Add a copy to yours
            </button>
          ) : null}

          {pet.removable ? (
            <button
              type="button"
              data-tails-critical
              onClick={() => onRemove(pet)}
              className={cn(
                'ml-auto flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors duration-quick',
                confirmingRemove
                  ? 'bg-destructive text-destructive-foreground'
                  : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
              )}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {confirmingRemove ? 'Really remove — this deletes the folder' : 'Remove'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onHide(pet)}
              title="Codex owns this folder, so the files stay exactly where they are."
              className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
            >
              <EyeOff className="size-3.5" aria-hidden="true" /> Hide from my library
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
