import { PawPrint, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

import { petsApi, PetThumbnail, type InstalledPet } from '../marketplace';

/**
 * How large the preview box is, in CSS pixels.
 *
 * This used to crop the idle frame itself, from a hand-written type that
 * described a pet the server does not send: `definition.name` (it is
 * `displayName`) and `states.idle.from` (it is `start`). Both silently read
 * `undefined`, so every pet fell through to a paw placeholder. It was also the
 * third copy of "crop one cell out of a spritesheet" in the app, and the
 * one-frame-per-loop bug had already been fixed in only some of them.
 *
 * `PetThumbnail` exists precisely to end that: the server publishes a `preview`
 * frame and one component draws it.
 */
const PREVIEW_SIZE = 44;

type PetPickerProps = {
  sessionId: string;
  /** The pet this conversation already has, if any. */
  petId: string | null;
  /**
   * Carries the whole pet, not just its id: the caller shows the name and the
   * thinking indicator uses the phrases, and only this list has either.
   */
  onAssigned: (pet: { id: string; name: string; phrases: string[] } | null) => void;
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
  const [pets, setPets] = useState<InstalledPet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    petsApi.listPets()
      .then((library) => {
        if (!cancelled) setPets(library.pets);
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

  const assign = async (next: { id: string; name: string; phrases: string[] } | null) => {
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
                onClick={() => void assign({
                  id: pet.definition.id,
                  name: pet.definition.displayName,
                  phrases: pet.thinkingPhrases ?? [],
                })}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors duration-quick disabled:opacity-60',
                  selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/50',
                )}
              >
                <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/60">
                  <PetThumbnail pet={pet} size={PREVIEW_SIZE} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{pet.definition.displayName}</span>
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
