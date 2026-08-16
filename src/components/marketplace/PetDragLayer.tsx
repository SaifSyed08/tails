import { CornerDownLeft } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

import {
  clearPetDropTarget,
  isPetDrag,
  publishPetDragFrame,
  readPetDrag,
  readPetDragFrame,
  setPetDropTarget,
  subscribeToPetDragFrame,
  usePetDragState,
  type PetDragFrame,
  type PetDragPayload,
  type PetDropTarget,
} from './pet-drag';
import { PetThumbnail } from './PetThumbnail';

/**
 * Everything that is drawn *because* a pet is being carried.
 *
 * One layer for the whole gesture, portalled to the body, rather than each
 * surface drawing its own half of it. Two reasons, and both came from the
 * alternative being tried first:
 *
 * - The pet hanging from the cursor has to be able to travel anywhere in the
 *   window, so it cannot live inside the sidebar that it came from.
 * - The two drop affordances are deliberately different, and keeping them in
 *   one file is what keeps the difference legible. Dropping into the chat is
 *   dropping into a *place*, so the whole place says so. Dropping onto a
 *   conversation row is dropping onto a *thing* in a list of near-identical
 *   things, so the label goes beside the cursor. A row that replaced its own
 *   title with a banner read, in the user's words, "really odd": the row you
 *   are aiming at is the one thing that must not change shape as you aim.
 *
 * The pointer position never passes through React here — see the note in
 * `pet-drag.ts`. This component renders when the *target* changes, a handful of
 * times per drag, and the frame subscription moves the elements in between.
 */

/**
 * Where the label sits relative to the cursor.
 *
 * Above it, because the pet hangs below it: the two would otherwise occupy the
 * same few square centimetres, and the label would be reading through him.
 */
const LABEL_OFFSET_X = 12;
const LABEL_OFFSET_Y = -32;
/** Keeps the label off the window edges when the drag reaches one. */
const EDGE_MARGIN = 8;

/** Rendered height of the pet hanging from the cursor. Bigger than the tray icon he left. */
const CARRIED_SIZE = 40;

export type PetDragLayerProps = {
  /**
   * The conversation the chat pane is currently showing.
   *
   * Null means there is nothing for a drop into the chat to be *about* — a
   * marketplace page is open, or no conversation has been chosen — and the chat
   * affordance is not offered at all rather than offered and then refused.
   */
  chatSessionId: string | null;
  /** Called for a drop the layer handled itself: the chat overlay. */
  onAssign: (target: PetDropTarget, payload: PetDragPayload) => void;
};

export function PetDragLayer({ chatSessionId, onAssign }: PetDragLayerProps) {
  const { payload, carried, target } = usePetDragState();
  const followRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  /**
   * The chat's own box, read from the DOM rather than passed in, and written
   * back onto the node rather than held in state.
   *
   * The chat view already publishes `[data-tails-chat-stage]` as "the frame an
   * overlay measures itself against", so measuring it here means the drop
   * affordance needs nothing at all from the chat feature — no prop, no
   * callback, no component mounted inside it that has to be kept in step. And
   * the value is a measurement of another element, so feeding it back through a
   * render buys nothing; `FloatingCard` positions itself the same way and for
   * the same reason.
   *
   * No stage in the document means the marketplace is open in that pane, and
   * there is nothing to drop into.
   */
  useLayoutEffect(() => {
    const node = chatRef.current;
    if (!node) return undefined;

    const place = () => {
      const rect = document.querySelector('[data-tails-chat-stage]')?.getBoundingClientRect();
      if (!rect) {
        node.style.display = 'none';
        return;
      }
      node.style.display = '';
      node.style.left = `${rect.left}px`;
      node.style.top = `${rect.top}px`;
      node.style.width = `${rect.width}px`;
      node.style.height = `${rect.height}px`;
    };

    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [payload, chatSessionId]);

  /**
   * Moves the pet and the label, without rendering.
   *
   * Re-run when the target changes as well as when the drag starts, because the
   * label is mounted by that change. Before paint, not after: an element that
   * follows the cursor must never be committed at the origin, or picking a pet
   * up flashes him in the window's top-left corner first.
   */
  useLayoutEffect(() => {
    if (!payload) return undefined;

    // Measured once per label rather than per frame: the text is fixed for the
    // duration of a drag, and reading `offsetWidth` in the frame loop is a
    // forced layout sixty times a second.
    const labelWidth = labelRef.current?.offsetWidth ?? 0;

    const write = (nextFrame: PetDragFrame) => {
      const follow = followRef.current;
      if (follow) {
        // Rotation about the wrapper's own origin, which the translate has just
        // placed under the cursor. That is what makes him pivot from the pinch
        // rather than from his middle.
        follow.style.transform = `translate3d(${nextFrame.x}px, ${nextFrame.y}px, 0) rotate(${nextFrame.angle.toFixed(2)}deg)`;
      }

      const label = labelRef.current;
      if (label) {
        // Flipped to the other side of the cursor rather than allowed to run
        // off: the sidebar is on the left of the window, so a drag onto a row
        // is always near an edge in one direction or the other.
        const wouldOverflow = nextFrame.x + LABEL_OFFSET_X + labelWidth > window.innerWidth - EDGE_MARGIN;
        const x = wouldOverflow ? nextFrame.x - LABEL_OFFSET_X - labelWidth : nextFrame.x + LABEL_OFFSET_X;
        const y = Math.max(EDGE_MARGIN, nextFrame.y + LABEL_OFFSET_Y);
        label.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
    };

    write(readPetDragFrame());
    return subscribeToPetDragFrame(write);
  }, [payload, target]);

  if (!payload) return null;

  const overChat = target?.kind === 'chat';

  return createPortal(
    <>
      {/* The chat, as a place. Mounted only while a pet is in flight, so it
          never sits between the user and the transcript. */}
      {chatSessionId ? (
        <div
          ref={chatRef}
          data-pet-drop-chat=""
          // `t-overlay` is not decoration: it is what takes an element layered
          // over the chrome back out of the window's drag region. See the note
          // in index.css — z-index does not govern those rectangles.
          className="t-overlay fixed z-40 flex items-center justify-center"
          // Placed by the layout effect above, before the first paint. Hidden
          // until then so it can never flash in the window's top-left corner.
          style={{ display: 'none' }}
          onDragOver={(event) => {
            if (!isPetDrag(event)) return;
            // Both required, and both on every move: without `preventDefault`
            // the browser refuses the drop, and without it on `dragover`
            // specifically the cursor shows "no entry" the whole way across.
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setPetDropTarget({ kind: 'chat' });
            publishPetDragFrame({ x: event.clientX, y: event.clientY, angle: 0 });
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            // Guarded, because leaving the chat means entering a sidebar row,
            // and that row's `dragenter` has already fired.
            clearPetDropTarget({ kind: 'chat' });
          }}
          onDrop={(event) => {
            if (!isPetDrag(event)) return;
            event.preventDefault();
            const dropped = readPetDrag(event);
            clearPetDropTarget({ kind: 'chat' });
            if (dropped) onAssign({ kind: 'chat' }, dropped);
          }}
        >
          <div
            className={cn(
              'pointer-events-none absolute inset-3 rounded-xl border-2 border-dashed',
              'transition-colors duration-quick',
              overChat ? 'border-primary bg-primary/15' : 'border-primary/40 bg-primary/5',
            )}
          />
          <p className="pointer-events-none relative flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg">
            <CornerDownLeft className="size-4 shrink-0" aria-hidden="true" />
            Drop anywhere to assign {payload.displayName} to this chat
          </p>
        </div>
      ) : null}

      {/* The row label. Beside the cursor, never over the row: the promise is
          about the thing you are pointing at, so it must not cover it. */}
      {target?.kind === 'session' ? (
        <div
          ref={labelRef}
          className="t-overlay pointer-events-none fixed left-0 top-0 z-50 will-change-transform"
          role="status"
        >
          <div className="flex items-center gap-1.5 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground shadow-lg">
            <CornerDownLeft className="size-3 shrink-0" aria-hidden="true" />
            Assign {payload.displayName} to this chat
          </div>
        </div>
      ) : null}

      {/* The pet himself, but only for the pointer gesture: an HTML5 drag comes
          with a ghost the browser draws, and two pets on screen is one too many. */}
      {carried ? (
        <div
          ref={followRef}
          aria-hidden="true"
          className="t-overlay pointer-events-none fixed left-0 top-0 z-50 will-change-transform"
          // Pinched at the top, hanging below. The origin is the pinch, so the
          // rotation above swings him from the cursor rather than about his own
          // centre — which is the difference between "carried" and "spinning".
          style={{ transformOrigin: '0 0' }}
        >
          <div className="-translate-x-1/2 drop-shadow-[0_4px_6px_rgba(0,0,0,0.45)]">
            <PetThumbnail pet={carried} size={CARRIED_SIZE} />
          </div>
        </div>
      ) : null}
    </>,
    document.body,
  );
}
