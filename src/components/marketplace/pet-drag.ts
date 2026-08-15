import { useEffect, useState } from 'react';

/**
 * Dragging a pet out of the marketplace and onto something.
 *
 * The drop target is in another feature entirely (a conversation row in the
 * sidebar), so the contract between them lives here rather than in either — a
 * drag whose payload format is defined in the source and re-guessed in the
 * target is a drag that breaks the first time either side is edited.
 *
 * ## Why there is a module-level record of the drag
 *
 * `dataTransfer.getData` deliberately returns nothing during `dragover`: only
 * the *types* are readable until the drop lands. But the whole point of this
 * gesture is that the row can say **"Assign Sonic to this chat"** while the
 * pointer is still hovering — the user is meant to know what will happen before
 * they let go. That needs the pet's name mid-drag, so the payload is also kept
 * here, in the one document doing the dragging, and cleared when the drag ends.
 * `dataTransfer` remains the source of truth on drop.
 */

export const PET_DRAG_MIME = 'application/x-tails-pet';

export type PetDragPayload = {
  /** `catalogue` pets are not installed yet; dropping one installs it first. */
  kind: 'installed' | 'catalogue';
  id: string;
  displayName: string;
};

let active: PetDragPayload | null = null;
const listeners = new Set<(payload: PetDragPayload | null) => void>();

function publish(payload: PetDragPayload | null) {
  active = payload;
  for (const listener of listeners) listener(payload);
}

/** Call from `onDragStart` on anything that represents a pet. */
export function startPetDrag(event: React.DragEvent, payload: PetDragPayload): void {
  event.dataTransfer.setData(PET_DRAG_MIME, JSON.stringify(payload));
  // A plain-text fallback so dragging into a text field does something sane
  // rather than nothing.
  event.dataTransfer.setData('text/plain', payload.displayName);
  event.dataTransfer.effectAllowed = 'copy';
  publish(payload);
}

/** Call from `onDragEnd`. Ends the "a pet is in flight" state for every target. */
export function endPetDrag(): void {
  publish(null);
}

/** Whether the thing being dragged over this target is a pet. Safe during `dragover`. */
export function isPetDrag(event: React.DragEvent | DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes(PET_DRAG_MIME) : false;
}

/** The payload, on drop. Falls back to the in-flight record if the transfer is empty. */
export function readPetDrag(event: React.DragEvent | DragEvent): PetDragPayload | null {
  const raw = event.dataTransfer?.getData(PET_DRAG_MIME);
  if (!raw) return active;

  try {
    const parsed = JSON.parse(raw) as PetDragPayload;
    if (!parsed?.id || (parsed.kind !== 'installed' && parsed.kind !== 'catalogue')) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The pet currently being dragged, or null.
 *
 * Lets a drop target name the pet before the drop happens, which is the
 * difference between "something will happen here" and "Sonic will be assigned
 * to this chat".
 */
export function usePetDrag(): PetDragPayload | null {
  const [payload, setPayload] = useState<PetDragPayload | null>(active);

  useEffect(() => {
    listeners.add(setPayload);
    // A drag that ends outside any target still fires `dragend` on the source,
    // but a drag cancelled by the OS may not — this catches the stragglers so a
    // target is never left highlighted.
    const clear = () => publish(null);
    window.addEventListener('drop', clear);
    window.addEventListener('dragend', clear);

    return () => {
      listeners.delete(setPayload);
      window.removeEventListener('drop', clear);
      window.removeEventListener('dragend', clear);
    };
  }, []);

  return payload;
}
