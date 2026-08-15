import { AlertTriangle, Check, CopyPlus, EyeOff, Film, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';

import type { InstalledPet } from './marketplace-api';
import { endPetDrag, startPetDrag } from './pet-drag';
import { frameCount, isGridUncertain, SOURCE_LABEL } from './pet-filters';
import { PetStage } from './PetStage';
import { Pill } from './Pill';

/**
 * One pet on the shelf.
 *
 * The card sells the pet and nothing else: a live preview, its name, what it
 * is, and the one action most likely to be wanted. Everything that needs
 * reading — the directory it lives in, the frame layout, the personality
 * prompt — is a click away in the detail sheet, because a grid where every
 * tile is a paragraph is a settings list with pictures.
 *
 * Hovering plays the walk cycle when the pet has one. That is the closest thing
 * to picking an item up, and it costs nothing: the frames are already loaded.
 */

type PetCardProps = {
  pet: InstalledPet;
  busy: boolean;
  confirmingRemove: boolean;
  /** True when another installed pet shares this one's display name; the id is shown to tell them apart. */
  ambiguousName: boolean;
  onOpen: (pet: InstalledPet) => void;
  onSetActive: (pet: InstalledPet) => void;
  /** Copies a read-only Codex pet into `~/.tails/pets`, where it can be edited. */
  onAddCopy: (pet: InstalledPet) => void;
  onRemove: (pet: InstalledPet) => void;
  /** Takes a pet out of the library without deleting anything. The only "remove" a Codex pet has. */
  onHide: (pet: InstalledPet) => void;
};

export function PetCard({
  pet,
  busy,
  confirmingRemove,
  ambiguousName,
  onOpen,
  onSetActive,
  onAddCopy,
  onRemove,
  onHide,
}: PetCardProps) {
  const [hovered, setHovered] = useState(false);
  const reduced = useReducedMotion();
  const { definition } = pet;
  // Hovering makes the pet acknowledge you. `waving` is the row Codex sheets
  // use for exactly that, and `PetSprite` falls back for sheets that have no
  // such row rather than freezing.
  const showcase = hovered ? 'waving' : 'idle';

  return (
    <article
      data-tails-part="card"
      draggable
      onDragStart={(event) => startPetDrag(event, {
        kind: 'installed',
        id: definition.id,
        displayName: definition.displayName,
      })}
      onDragEnd={endPetDrag}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`Drag ${definition.displayName} onto a chat to assign it`}
      className={cn(
        'group flex h-full cursor-grab flex-col overflow-hidden active:cursor-grabbing',
        // Lift and outline on hover. Outline rather than a ring or a shadow:
        // the surface contract owns `box-shadow` on any element carrying
        // `data-tails-part`, so those utilities never land here.
        'transition-transform duration-quick ease-standard',
        !reduced && 'hover:-translate-y-1',
        'hover:outline hover:outline-2 hover:-outline-offset-2 hover:outline-primary/40',
        pet.active && 'outline outline-2 -outline-offset-2 outline-primary',
        busy && 'pointer-events-none opacity-60',
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(pet)}
        className="relative block w-full focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        aria-label={`Open ${definition.displayName}`}
      >
        <PetStage pet={pet} height={104} state={showcase} glow={hovered} className="h-36 w-full" />
        <span className="pointer-events-none absolute right-2 top-2 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground opacity-0 transition-opacity duration-quick group-hover:opacity-100">
          Details
        </span>
        {pet.active ? (
          <Pill tone="accent" className="absolute left-2 top-2">
            <Check className="size-2.5" aria-hidden="true" /> On screen
          </Pill>
        ) : null}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{definition.displayName}</h3>
            {/* Two pets can ship under one name — Codex generated two called
                "Sonic" — and then the name alone does not say which is which. */}
            {ambiguousName ? (
              <p className="truncate text-[11px] text-muted-foreground" title={pet.directory}>
                {definition.id}
              </p>
            ) : null}
          </div>
          <Pill
            tone={pet.source === 'tails' ? 'positive' : 'neutral'}
            title={pet.directory}
          >
            {SOURCE_LABEL[pet.source]}
          </Pill>
        </div>

        {definition.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{definition.description}</p>
        ) : null}

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Film className="size-3" aria-hidden="true" />
            {frameCount(pet)} frames
          </span>
          {definition.kind ? <span className="capitalize">{definition.kind}</span> : null}
          {definition.author ? <span>by {definition.author}</span> : null}
        </p>

        {pet.warnings.length > 0 || isGridUncertain(pet.gridBasis) ? (
          <p className="flex items-start gap-1 text-[11px] text-warning">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            {pet.warnings.length > 0 ? pet.warnings[0] : 'The frame layout is a guess — open it to check.'}
          </p>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          <button
            type="button"
            onClick={() => onSetActive(pet)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-transform duration-instant ease-emphasis active:scale-95',
              pet.active
                ? 'border border-border hover:bg-accent'
                : 'bg-primary text-primary-foreground',
            )}
          >
            {pet.active ? 'Stand down' : 'Set active'}
          </button>

          {pet.source === 'codex' ? (
            <button
              type="button"
              onClick={() => onAddCopy(pet)}
              title="Copies it into your own pets folder, where it can be edited and removed."
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs transition-colors duration-quick hover:bg-accent"
            >
              <CopyPlus className="size-3" aria-hidden="true" /> Add to yours
            </button>
          ) : null}

          {pet.removable ? (
            <button
              type="button"
              data-tails-critical
              onClick={() => onRemove(pet)}
              aria-label={confirmingRemove ? `Confirm removing ${definition.displayName}` : `Remove ${definition.displayName}`}
              className={cn(
                'ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors duration-quick',
                confirmingRemove
                  ? 'bg-destructive text-destructive-foreground'
                  : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
              )}
            >
              <Trash2 className="size-3" aria-hidden="true" />
              {confirmingRemove ? 'Really?' : null}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onHide(pet)}
              title="Keeps the files where Codex put them and takes the pet out of your library."
              aria-label={`Hide ${definition.displayName} from the library`}
              className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
            >
              <EyeOff className="size-3" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
