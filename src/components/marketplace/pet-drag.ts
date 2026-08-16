import { useSyncExternalStore } from 'react';

import type { InstalledPet } from './marketplace-api';

/**
 * Dragging a pet out of the marketplace and onto something.
 *
 * The drop target is in another feature entirely (a conversation row in the
 * sidebar, or the chat itself), so the contract between them lives here rather
 * than in either — a drag whose payload format is defined in the source and
 * re-guessed in the target is a drag that breaks the first time either side is
 * edited.
 *
 * ## Two gestures, one record
 *
 * The marketplace cards use HTML5 drag-and-drop. The carousel uses a
 * pointer-driven carry (`pet-carry.ts`), because `setDragImage` takes a static
 * bitmap and the pet is supposed to hang from the cursor and swing. Both
 * publish into the same record, so a drop target does not have to know which
 * gesture is carrying the pet — it asks what is in flight and where it would
 * land, and gets the same answer either way.
 *
 * ## Why there is a module-level record of the drag
 *
 * `dataTransfer.getData` deliberately returns nothing during `dragover`: only
 * the *types* are readable until the drop lands. But the whole point of this
 * gesture is that the target can say **"Assign Sonic to this chat"** while the
 * pointer is still hovering — the user is meant to know what will happen before
 * they let go. That needs the pet's name mid-drag, so the payload is also kept
 * here, in the one document doing the dragging, and cleared when the drag ends.
 * `dataTransfer` remains the source of truth on drop.
 *
 * ## Two channels, deliberately
 *
 * `usePetDragState` is React state: what is in flight and what it is over. It
 * changes a handful of times per drag. The pointer position is *not* in there —
 * it changes every frame, and pushing sixty renders a second through the tree
 * to move one element is how a drag starts dropping frames. Position goes
 * through `subscribeToPetDragFrame`, which the drag layer writes straight onto
 * a node. Same split, and the same reason, as `WebSocketContext`.
 */

export const PET_DRAG_MIME = 'application/x-tails-pet';

export type PetDragPayload = {
  /** `catalogue` pets are not installed yet; dropping one installs it first. */
  kind: 'installed' | 'catalogue';
  id: string;
  displayName: string;
};

/**
 * Where a drop would land.
 *
 * Two shapes because the two read differently to the user: the chat is a place
 * you drop *into* and says so across its whole surface, while a row is a thing
 * you drop *on* and gets a label beside the cursor instead.
 */
export type PetDropTarget =
  | { kind: 'chat' }
  | { kind: 'session'; sessionId: string };

/**
 * How a drop target announces itself to a pointer-driven carry.
 *
 * A pointer carry has no `dragover`, so it finds its target by hit-testing the
 * document — which means the target has to be identifiable from the element
 * under the cursor alone. These two attributes are that identification, and
 * they are the whole interface: anything carrying `data-pet-drop-session` is a
 * conversation and anything carrying `data-pet-drop-chat` is the chat.
 */
export const PET_DROP_SESSION_ATTR = 'data-pet-drop-session';
export const PET_DROP_CHAT_ATTR = 'data-pet-drop-chat';

export type PetDragState = {
  /** The pet in flight, whichever gesture is carrying it. */
  payload: PetDragPayload | null;
  /**
   * The sprite the drag layer should draw under the cursor.
   *
   * Only a pointer carry sets it: an HTML5 drag already has a ghost the browser
   * draws for it, and drawing a second one would put two pets on screen.
   */
  carried: InstalledPet | null;
  target: PetDropTarget | null;
};

const NOTHING_IN_FLIGHT: PetDragState = { payload: null, carried: null, target: null };

let state: PetDragState = NOTHING_IN_FLIGHT;
const listeners = new Set<() => void>();

function publish(next: PetDragState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let netArmed = false;

/**
 * The safety net: armed by the first drag, never taken down again.
 *
 * A drag that ends outside any target still fires `dragend` on the source, but
 * one cancelled by the OS may not, and one whose source element was unmounted
 * mid-flight definitely will not. Deliberately not scoped to whether anything
 * is currently subscribed — a record left non-null is not merely a stale
 * highlight, it is the fallback `readPetDrag` reaches for when a later drop
 * arrives with an empty transfer, which is how a drag of one pet ends up
 * assigning another. Armed on first use rather than at import so the module
 * stays loadable without a DOM.
 */
function armSafetyNet(): void {
  if (netArmed) return;
  netArmed = true;
  window.addEventListener('drop', endPetDrag);
  window.addEventListener('dragend', endPetDrag);
}

/** Call from `onDragStart` on anything that represents a pet. */
export function startPetDrag(event: React.DragEvent, payload: PetDragPayload): void {
  event.dataTransfer.setData(PET_DRAG_MIME, JSON.stringify(payload));
  // A plain-text fallback so dragging into a text field does something sane
  // rather than nothing.
  event.dataTransfer.setData('text/plain', payload.displayName);
  event.dataTransfer.effectAllowed = 'copy';
  armSafetyNet();
  publish({ payload, carried: null, target: null });
}

/**
 * Call when a pointer-driven carry begins. See `pet-carry.ts`.
 *
 * Takes the pet as well as the payload because this gesture draws its own pet:
 * there is no browser ghost to inherit.
 */
export function startPetCarry(payload: PetDragPayload, pet: InstalledPet): void {
  // No safety net needed: a carry produces no drag events to miss, and
  // `pet-carry.ts` guarantees its own single exit.
  publish({ payload, carried: pet, target: null });
}

/** Call from `onDragEnd`. Ends the "a pet is in flight" state for every target. */
export function endPetDrag(): void {
  if (state === NOTHING_IN_FLIGHT) return;
  publish(NOTHING_IN_FLIGHT);
}

/**
 * Records what the pet is over.
 *
 * Set by whichever gesture is carrying — `dragover` for HTML5, a hit test per
 * frame for a carry — so a target lights up identically either way, and the
 * label saying what will happen is drawn once, by the layer, beside the cursor
 * rather than inside the row it is about.
 */
export function setPetDropTarget(target: PetDropTarget | null): void {
  if (!state.payload) return;
  if (sameTarget(state.target, target)) return;
  publish({ ...state, target });
}

function sameTarget(left: PetDropTarget | null, right: PetDropTarget | null): boolean {
  if (!left || !right) return left === right;
  if (left.kind === 'session' && right.kind === 'session') return left.sessionId === right.sessionId;
  return left.kind === right.kind;
}

/**
 * Clears the target, but only if it is still the one the caller set.
 *
 * Moving from one row to the next fires `dragenter` on the new row *before*
 * `dragleave` on the old one, so an unguarded clear would wipe the target that
 * had just been set and the label would blink between every pair of rows.
 */
export function clearPetDropTarget(target: PetDropTarget): void {
  if (sameTarget(state.target, target)) setPetDropTarget(null);
}

/** Whether the thing being dragged over this target is a pet. Safe during `dragover`. */
export function isPetDrag(event: React.DragEvent | DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes(PET_DRAG_MIME) : false;
}

/** The payload, on drop. Falls back to the in-flight record if the transfer is empty. */
export function readPetDrag(event: React.DragEvent | DragEvent): PetDragPayload | null {
  const raw = event.dataTransfer?.getData(PET_DRAG_MIME);
  if (!raw) return state.payload;

  try {
    const parsed = JSON.parse(raw) as PetDragPayload;
    if (!parsed?.id || (parsed.kind !== 'installed' && parsed.kind !== 'catalogue')) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * What a drop at this point would land on.
 *
 * The chat is checked last: its overlay spans the whole chat pane, and the
 * sidebar rows are not inside it, so the order only matters for a target that
 * somehow nests — in which case the more specific answer is the right one.
 */
export function resolvePetDropTarget(x: number, y: number): PetDropTarget | null {
  const element = document.elementFromPoint(x, y);
  if (!element) return null;

  const row = element.closest(`[${PET_DROP_SESSION_ATTR}]`);
  const sessionId = row?.getAttribute(PET_DROP_SESSION_ATTR);
  if (sessionId) return { kind: 'session', sessionId };

  return element.closest(`[${PET_DROP_CHAT_ATTR}]`) ? { kind: 'chat' } : null;
}

/**
 * The pet currently being dragged, or null.
 *
 * Lets a drop target name the pet before the drop happens, which is the
 * difference between "something will happen here" and "Sonic will be assigned
 * to this chat".
 */
export function usePetDrag(): PetDragPayload | null {
  return useSyncExternalStore(subscribe, () => state.payload, () => null);
}

/** Everything about the drag in flight. For the drag layer and for drop targets. */
export function usePetDragState(): PetDragState {
  return useSyncExternalStore(subscribe, () => state, () => NOTHING_IN_FLIGHT);
}

/**
 * Where the pet is, and how far it has swung.
 *
 * `angle` is degrees, clockwise-positive, and is always 0 for an HTML5 drag —
 * the browser's ghost cannot be rotated, so nothing pretends otherwise.
 */
export type PetDragFrame = { x: number; y: number; angle: number };

let frame: PetDragFrame = { x: 0, y: 0, angle: 0 };
const frameListeners = new Set<(frame: PetDragFrame) => void>();

export function publishPetDragFrame(next: PetDragFrame): void {
  frame = next;
  for (const listener of frameListeners) listener(next);
}

export function readPetDragFrame(): PetDragFrame {
  return frame;
}

/**
 * Follows the pointer without re-rendering anything.
 *
 * Subscribers write the position straight onto a DOM node. That is the whole
 * reason this is not React state — see the note at the top of the file.
 */
export function subscribeToPetDragFrame(listener: (frame: PetDragFrame) => void): () => void {
  frameListeners.add(listener);
  return () => {
    frameListeners.delete(listener);
  };
}
