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
  /**
   * How fast the hand was moving when it opened, in pixels per second.
   *
   * The difference between putting him down and throwing him. Zero when the
   * hand had come to rest, so an ordinary careful placement stays one.
   */
  velocity: { x: number; y: number };
  /**
   * Where the pointer is, in the page's own coordinates.
   *
   * Client pixels, deliberately — not `screenX`. Turning a page coordinate into
   * a place on the screen needs the window's position, its invisible frame and
   * the page's zoom factor, and the renderer can answer none of those reliably.
   * The shell does that conversion; this reports what it actually knows.
   */
  clientX: number;
  clientY: number;
};

export type InChatCarryOptions = {
  /**
   * The pet's top-left corner has moved, and where the pointer is.
   *
   * Both, because the two answers are needed at once: the corner says where to
   * draw him in the chat, and the pointer is what the shell converts when he
   * has to be carried outside it.
   */
  onMove: (x: number, y: number, pointer: { x: number; y: number }) => void;
  /** The press became a carry. Fired once, when the threshold is crossed. */
  onStart?: () => void;
  /**
   * A button went down on him, before any movement.
   *
   * Earlier than `onStart` on purpose: between the press and the threshold he
   * is still under whatever was moving him, and a pet who was mid-stroll kept
   * walking for those few frames and then snapped to the hand. Pressing him
   * should stop him where he is.
   */
  onPress?: () => void;
  /** The hand opened. Not called for an interruption — see the note above. */
  onRelease: (release: InChatRelease) => void;
  /**
   * The gesture was interrupted: Escape, the window losing focus, unmounting.
   *
   * Separate from a release because it decides nothing — it puts everything
   * back the way it was. A carry that has changed something along the way (this
   * one moves a whole window) needs somewhere to undo that.
   */
  onCancel?: () => void;
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
  /** Smoothed pointer speed in px/ms, and when it was last measured. */
  vx: number;
  vy: number;
  lastX: number;
  lastY: number;
  lastAt: number;
  carrying: boolean;
  detach: () => void;
};

/**
 * How much of each new speed measurement to take on.
 *
 * Raw per-event speed is noisy — the gap between two pointer events can be one
 * millisecond or twenty — so a throw judged on the last event alone is a
 * lottery. Weighted towards the newest, because a throw is about where the hand
 * was going at the end, not on average.
 */
const VELOCITY_BLEND = 0.6;

/**
 * How stale the last movement can be and still count as a throw, in ms.
 *
 * A hand that stopped, held, and then let go has thrown nothing. Without this,
 * the last measured speed — from whenever the hand last moved — would be
 * applied to a release that was deliberately still.
 */
const THROW_WINDOW_MS = 90;

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
    if (!released) {
      optionsRef.current.onCancel?.();
      return;
    }

    const fresh = performance.now() - gesture.lastAt < THROW_WINDOW_MS;
    optionsRef.current.onRelease({
      x: gesture.x - gesture.grabX,
      y: gesture.y - gesture.grabY,
      // px/ms while it is measured, px/s for anyone doing physics with it.
      velocity: fresh ? { x: gesture.vx * 1000, y: gesture.vy * 1000 } : { x: 0, y: 0 },
      clientX: gesture.x,
      clientY: gesture.y,
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

      const now = performance.now();
      const gap = Math.max(1, now - gesture.lastAt);
      // Blended rather than taken raw, and only over a plausible frame gap: a
      // 200ms stall between events would otherwise read as a slow, deliberate
      // movement when it was in fact no movement at all.
      if (gap < 120) {
        gesture.vx += ((move.clientX - gesture.lastX) / gap - gesture.vx) * VELOCITY_BLEND;
        gesture.vy += ((move.clientY - gesture.lastY) / gap - gesture.vy) * VELOCITY_BLEND;
      } else {
        gesture.vx = 0;
        gesture.vy = 0;
      }
      gesture.lastX = move.clientX;
      gesture.lastY = move.clientY;
      gesture.lastAt = now;

      gesture.x = move.clientX;
      gesture.y = move.clientY;

      if (!gesture.carrying) {
        const travelled = Math.hypot(move.clientX - gesture.startX, move.clientY - gesture.startY);
        // Still a press. The browser is owed a click, so nothing is prevented.
        if (travelled < CARRY_THRESHOLD_PX) return;

        gesture.carrying = true;
        setCarrying(true);
        optionsRef.current.onStart?.();
        // Dragging across the window must not paint a text selection behind
        // him. Removed in `finish`, on every path out.
        document.body.style.setProperty('user-select', 'none');
      }

      move.preventDefault();
      optionsRef.current.onMove(
        move.clientX - gesture.grabX,
        move.clientY - gesture.grabY,
        { x: move.clientX, y: move.clientY },
      );
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
      vx: 0,
      vy: 0,
      lastX: event.clientX,
      lastY: event.clientY,
      lastAt: performance.now(),
      carrying: false,
      detach: () => {
        window.removeEventListener('pointermove', track);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
      },
    };

    node.setPointerCapture(event.pointerId);
    optionsRef.current.onPress?.();
  }, [finish]);

  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!swallowClickRef.current) return;
    swallowClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { carrying, onPointerDown, onClickCapture };
}
