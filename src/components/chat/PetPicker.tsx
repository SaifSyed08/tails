import { PawPrint, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * The parts of a pet this picker reads.
 *
 * Deliberately a narrow, all-optional view of the pets module's own shape: it
 * owns that type and is still changing it, and a picker is not worth breaking
 * a build over. Anything missing degrades to the paw placeholder.
 */
type PickablePet = {
  definition: {
    id: string;
    name: string;
    frame?: { width: number; height: number; columns: number; rows: number };
    states?: { idle?: { from: number } };
  };
  spriteUrl: string;
};

/** How large the preview box is, in CSS pixels. */
const PREVIEW_SIZE = 44;

/**
 * One frame of a pet's spritesheet, scaled to fit the preview box.
 *
 * A spritesheet dropped into an `<img>` shows every frame at once, which reads
 * as a contact sheet rather than a character — so the idle frame is cropped
 * out with background positioning. Pixel art is scaled with `pixelated`,
 * because smoothing it is the one thing that makes it look broken.
 */
function PetFrame({ pet }: { pet: PickablePet }) {
  const frame = pet.definition.frame;
  if (!frame?.width || !frame.height || !frame.columns) {
    return <PawPrint className="size-5 text-muted-foreground" aria-hidden="true" />;
  }

  const index = pet.definition.states?.idle?.from ?? 0;
  const scale = PREVIEW_SIZE / Math.max(frame.width, frame.height);

  return (
    <span
      className="relative block overflow-hidden"
      style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
      aria-hidden="true"
    >
      <span
        className="absolute left-0 top-0 block origin-top-left"
        style={{
          width: frame.width,
          height: frame.height,
          transform: `scale(${scale})`,
          backgroundImage: `url(${pet.spriteUrl})`,
          backgroundPosition: `${-(index % frame.columns) * frame.width}px ${-Math.floor(index / frame.columns) * frame.height}px`,
          imageRendering: 'pixelated',
        }}
      />
    </span>
  );
}

type PetPickerProps = {
  sessionId: string;
  /** The pet this conversation already has, if any. */
  petId: string | null;
  /** Carries the name too: the caller shows it, and only this list knows it. */
  onAssigned: (pet: { id: string; name: string } | null) => void;
  onClose: () => void;
};

/**
 * Gives one conversation a companion of its own.
 *
 * Per-conversation rather than global because that is what was asked for, and
 * because it is the more useful shape: the pet becomes part of how a
 * particular piece of work feels, not a single app-wide setting.
 */
export function PetPicker({ sessionId, petId, onAssigned, onClose }: PetPickerProps) {
  const [pets, setPets] = useState<PickablePet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    api.listPets()
      .then((library) => {
        if (!cancelled) setPets(library.pets as PickablePet[]);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setPets([]);
        setError(reason instanceof Error ? reason.message : 'Could not read your pets.');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const assign = async (next: { id: string; name: string } | null) => {
    setSaving(true);
    try {
      await api.setSessionPet(sessionId, next?.id ?? null);
      onAssigned(next);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save that.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button
        type="button"
        data-tails-part="scrim"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Assign a pet to this conversation"
        data-tails-part="card"
        className="animate-scale-in relative flex max-h-[70vh] w-full max-w-md flex-col p-4"
      >
        <div className="mb-3 flex items-center gap-2">
          <PawPrint className="size-4 text-primary" aria-hidden="true" />
          <span className="text-sm font-medium">Assign a pet</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-md p-1 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <p className="mb-3 text-xs text-muted-foreground">
          This one conversation only. Everything else keeps your usual companion.
        </p>

        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
          {pets === null ? (
            <p className="py-6 text-center text-xs text-muted-foreground">Reading your pets…</p>
          ) : null}

          {pets?.length === 0 && !error ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No pets installed yet — the Marketplace has some.
            </p>
          ) : null}

          {pets?.map((pet) => {
            const selected = pet.definition.id === petId;
            return (
              <button
                key={pet.definition.id}
                type="button"
                disabled={saving}
                aria-pressed={selected}
                onClick={() => void assign({ id: pet.definition.id, name: pet.definition.name })}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors duration-quick disabled:opacity-60',
                  selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/50',
                )}
              >
                <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/60">
                  <PetFrame pet={pet} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{pet.definition.name}</span>
                {selected ? <span className="text-xs text-primary">Assigned</span> : null}
              </button>
            );
          })}
        </div>

        {error ? (
          <p className="mt-2 text-xs text-destructive">{error}</p>
        ) : null}

        <button
          type="button"
          disabled={saving || petId === null}
          onClick={() => void assign(null)}
          className="mt-3 self-start rounded-md border border-border px-3 py-1.5 text-xs transition-colors duration-quick hover:bg-accent disabled:opacity-50"
        >
          No pet for this chat
        </button>
      </div>
    </div>
  );
}
