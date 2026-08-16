import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Picking the in-chat pet up with the pointer.
 *
 * ## Why this is not `usePetCarry`
 *
 * The tray's carry lifts a pet *out* of a list: the drag layer draws him small,
 * hanging from the cursor, swinging, with drop targets lighting up behind him.
 * That is right for choosing a pet and wrong for one who is already standing in
 * the room — there he is a thing you pick up and put down, the size he already
 * is, and the only two outcomes are "back on the floor" and "out to the
 * desktop". The user's words: it should feel like dragging him when he is free
 * of the window.
 *
 * So this hook reports the pointer and nothing else. The pet keeps being drawn
 * by `ChatPet`, at his own size, unrotated, from the point he was grabbed by —
 * no re-parenting, no ghost, no second copy.
 *
 * What it does share with the tray's carry is the shape of a safe gesture,
 * because those parts are not stylistic: a movement threshold so a press is
 * still a click, pointer capture, and one exit taken by every way out
 * (released, cancelled, Escape, the window losing focus, unmounting). A drag
 * that loses its capture without noticing leaves a pet stuck to the cursor.
 */

/** Pointer travel before a press becomes a carry, so a click stays a click. */
const CARRY_THRESHOLD_PX = 4;

export type InChatRelease = {
  /** Where the pet's top-left corner is, in viewport coordinates. */
  x: number;
  y: number;
  /** Where the pointer is, in the screen's coordinates. For handing him to the desktop. */
  screenX: number;
  screenY: number;
};

export type InChatCarryOptions = {
  /** The pet's top-left corner has moved, in viewport coordinates. */
  onMove: (x: number, y: number) => void;
  /** The hand opened. Not called for an interruption — see the note above. */
  onRelease: (release: InChatRelease) => void;
};

type Gesture = {
  pointerId: number;
  node: HTMLElement;
  /** Where the press landed, for the threshold. */
  startX: number;
  startY: number;
  /** Pointer offset inside the pet's box, so he does not jump to the cursor. */
  grabX: number;
  grabY: number;
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  carrying: boolean;
  detach: () => void;
};

export function useInChatCarry(options: InChatCarryOptions): {
  carrying: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onClickCapture: (event: React.MouseEvent) => void;
} {
  const gestureRef = useRef<Gesture | null>(null);
  const [carrying, setCarrying] = useState(false);
  /**
   * Set by a carry that ended, cleared by the click it has to eat.
   *
   * A gesture that ends on the pet it started on is still a click as far as the
   * browser is concerned, and him jumping in delight the instant you put him
   * down is the wrong reaction to being put down.
   */
  const swallowClickRef = useRef(false);

  // Read at call time rather than captured when the press started, so a release
  // never calls a handler the component has since replaced.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  /** The single exit. `released` is the only thing that distinguishes the ways out. */
  const finish = useCallback((released: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;

    gesture.detach();
    // `hasPointerCapture` first: releasing a capture the node does not hold
    // throws, and a node unmounted mid-gesture has already lost it.
    if (gesture.node.isConnected && gesture.node.hasPointerCapture(gesture.pointerId)) {
      gesture.node.releasePointerCapture(gesture.pointerId);
    }
    document.body.style.removeProperty('user-select');

    if (!gesture.carrying) return;
    swallowClickRef.current = true;
    setCarrying(false);
    if (!released) return;

    optionsRef.current.onRelease({
      x: gesture.x - gesture.grabX,
      y: gesture.y - gesture.grabY,
      screenX: gesture.screenX,
      screenY: gesture.screenY,
    });
  }, []);

  // Not scoped to the subtree: a captured pointer outlives the element it
  // started on, and unmounting mid-gesture is itself an interruption.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish(false);
    };
    const onBlur = () => finish(false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onBlur);
      finish(false);
    };
  }, [finish]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    // Left button only, and never on top of an existing gesture.
    if (event.button !== 0 || gestureRef.current) return;

    const node = event.currentTarget;
    const rect = node.getBoundingClientRect();

    const track = (move: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || move.pointerId !== gesture.pointerId) return;

      gesture.x = move.clientX;
      gesture.y = move.clientY;
      gesture.screenX = move.screenX;
      gesture.screenY = move.screenY;

      if (!gesture.carrying) {
        const travelled = Math.hypot(move.clientX - gesture.startX, move.clientY - gesture.startY);
        // Still a press. The browser is owed a click, so nothing is prevented.
        if (travelled < CARRY_THRESHOLD_PX) return;

        gesture.carrying = true;
        setCarrying(true);
        // Dragging across the window must not paint a text selection behind
        // him. Removed in `finish`, on every path out.
        document.body.style.setProperty('user-select', 'none');
      }

      move.preventDefault();
      optionsRef.current.onMove(move.clientX - gesture.grabX, move.clientY - gesture.grabY);
    };

    const up = (end: PointerEvent) => {
      if (end.pointerId !== gestureRef.current?.pointerId) return;
      finish(true);
    };
    const cancel = () => finish(false);

    window.addEventListener('pointermove', track);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);

    gestureRef.current = {
      pointerId: event.pointerId,
      node,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      x: event.clientX,
      y: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      carrying: false,
      detach: () => {
        window.removeEventListener('pointermove', track);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
      },
    };

    node.setPointerCapture(event.pointerId);
  }, [finish]);

  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!swallowClickRef.current) return;
    swallowClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { carrying, onPointerDown, onClickCapture };
}
