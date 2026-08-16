import { useCallback, useEffect, useRef, useState } from 'react';

import { prefersReducedMotion } from '@/theme/motion';

import type { InstalledPet } from './marketplace-api';
import {
  endPetDrag,
  publishPetDragFrame,
  resolvePetDropTarget,
  setPetDropTarget,
  startPetCarry,
  type PetDragPayload,
  type PetDropTarget,
} from './pet-drag';

/**
 * Carrying a pet with the pointer, rather than with HTML5 drag-and-drop.
 *
 * The pet is meant to hang from the cursor as if pinched at the scruff, and to
 * swing the way he is being pulled. `setDragImage` takes a static bitmap: it
 * cannot rotate, cannot animate, and cannot be re-drawn once the drag has
 * started. So the gesture is rebuilt out of pointer events, the pet is a real
 * element (`PetDragLayer` draws it), and this file is the part that knows where
 * the pointer is and how far he has swung.
 *
 * The marketplace cards keep the HTML5 gesture. They are dragged between
 * surfaces, sometimes out of the window, which is what that API is actually
 * good at — and both gestures publish the same record, so a drop target cannot
 * tell them apart.
 *
 * Everything here is written to survive being interrupted. A pointer drag that
 * loses its capture and does not notice leaves a pet stuck to the cursor and a
 * window that no longer responds to clicks, which is a far worse failure than
 * the drag simply not completing.
 */

/**
 * Pointer travel before a press becomes a carry.
 *
 * The carousel icon is also a button — clicking it opens the pet's menu — so a
 * press that never really moves has to stay a click.
 */
const CARRY_THRESHOLD_PX = 4;

/**
 * How far he is allowed to swing, in degrees.
 *
 * Past roughly this he stops reading as something hanging from your hand and
 * starts reading as something spinning, which is the "unhinged" the clamp
 * exists to prevent.
 */
const MAX_TILT_DEG = 22;

/** Degrees per pixel-per-millisecond of horizontal speed. A brisk drag is ~1px/ms. */
const TILT_PER_VELOCITY = 26;

/**
 * How much of the new measurement each move takes on.
 *
 * Raw per-event velocity is noisy enough to make the pet jitter, because the
 * gap between two pointer events can be one millisecond or twenty.
 */
const VELOCITY_BLEND = 0.4;

/**
 * Speed retained per frame when no move arrives.
 *
 * This is what brings him back upright when the pointer stops: the target
 * angle is derived from velocity, so a velocity that decays to nothing is an
 * angle that eases to nothing.
 */
const VELOCITY_DECAY = 0.84;

/** How far the angle closes on its target each frame. Lower is heavier. */
const TILT_EASE = 0.2;

const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));

/** Where the pet is in his swing: how fast he is being pulled, and how far over he is. */
export type PetSwing = { velocity: number; angle: number };

/**
 * One frame of the swing.
 *
 * Pulled out of the loop and made pure because it is the whole of the feel, and
 * the feel is the part worth being able to check: pull right and the angle goes
 * positive (clockwise, so his weight trails behind the pinch), pull left and it
 * goes negative, and stop and it comes back to upright on its own rather than
 * snapping. `still` is reduced motion, where he hangs straight down and none of
 * this happens at all.
 */
export function advanceSwing({ velocity, angle }: PetSwing, still: boolean): PetSwing {
  const decayed = velocity * VELOCITY_DECAY;
  const tilt = still ? 0 : clamp(decayed * TILT_PER_VELOCITY, MAX_TILT_DEG);
  return { velocity: decayed, angle: angle + (tilt - angle) * TILT_EASE };
}

type Carry = {
  pointerId: number;
  /** The element holding the pointer capture — always the icon that was pressed. */
  node: HTMLElement;
  pet: InstalledPet;
  payload: PetDragPayload;
  /** Where the press landed. The threshold is measured from here, not from the last move. */
  startX: number;
  startY: number;
  /** Latest pointer position, written by the move handler and read by the frame loop. */
  x: number;
  y: number;
  lastX: number;
  lastAt: number;
  /** Smoothed horizontal speed, px/ms. The only input to the tilt. */
  velocity: number;
  angle: number;
  /** False until the pointer has travelled far enough for this to be a drag. */
  carrying: boolean;
  /** Reduced motion is read once, when the press starts, and held for the gesture. */
  still: boolean;
  frame: number | undefined;
  /** Removes this gesture's window listeners. Called exactly once, by `finish`. */
  detach: () => void;
};

export type PetCarryProps = {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onClickCapture: (event: React.MouseEvent) => void;
  /**
   * Off, so the browser's own drag never starts underneath this one.
   *
   * Two drags at once means two ghosts, and the HTML5 one cannot be told to
   * stop once it has begun.
   */
  draggable: false;
  style: React.CSSProperties;
};

/**
 * The pointer-driven carry, for a surface with several pets in it.
 *
 * One gesture at a time is the physical truth — there is one pointer — so this
 * is one hook for the whole surface rather than one per icon, and the caller
 * asks for the props of whichever pet it is rendering.
 */
export function usePetCarry(
  onDrop?: (target: PetDropTarget, payload: PetDragPayload) => void,
): { carryingId: string | null; getCarryProps: (pet: InstalledPet) => PetCarryProps } {
  const carryRef = useRef<Carry | null>(null);
  const [carryingId, setCarryingId] = useState<string | null>(null);
  /**
   * Set by a carry that ended, cleared by the click it has to eat.
   *
   * A gesture that ends over the icon it started from is still a click as far
   * as the browser is concerned, and the pet's menu opening on top of a drop
   * the user has just made is the worst possible moment for it.
   */
  const swallowClickRef = useRef(false);
  // Read at drop time rather than captured when the gesture started, so a drop
  // never calls a handler the caller has since replaced.
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  });

  /**
   * Ends the gesture and puts everything back.
   *
   * One exit for every way out — dropped, cancelled, Escape, the window losing
   * focus — because the capture, the frame loop, the listeners and the page's
   * text selection all have to be released together or not at all.
   */
  const finish = useCallback((dropped: boolean) => {
    const carry = carryRef.current;
    if (!carry) return;
    carryRef.current = null;

    if (carry.frame !== undefined) cancelAnimationFrame(carry.frame);
    carry.detach();
    // `hasPointerCapture` first: releasing a capture the node does not hold
    // throws, and a node that has been unmounted mid-gesture has already lost
    // it — which is a case this gesture is specifically built to survive.
    if (carry.node.isConnected && carry.node.hasPointerCapture(carry.pointerId)) {
      carry.node.releasePointerCapture(carry.pointerId);
    }
    document.body.style.removeProperty('user-select');

    if (!carry.carrying) return;
    swallowClickRef.current = true;

    // Resolved here rather than remembered from the last frame: the pointer can
    // move between the final frame and the release, and the pet lands where it
    // was let go of, not where it was last painted.
    const target = dropped ? resolvePetDropTarget(carry.x, carry.y) : null;
    endPetDrag();
    setCarryingId(null);
    if (target) onDropRef.current?.(target, carry.payload);
  }, []);

  // Nothing here is scoped to a React subtree: a captured pointer outlives the
  // element it started on, so the escape hatches have to be on the window.
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
      // Unmounting mid-gesture is itself an interruption.
      finish(false);
    };
  }, [finish]);

  const begin = useCallback((carry: Carry) => {
    carry.carrying = true;
    // The pet is drawn by the layer from here on, and the icon he came from
    // dims, so the tray reads as "he is out of it right now".
    startPetCarry(carry.payload, carry.pet);
    setCarryingId(carry.pet.definition.id);
    // Dragging across the window must not paint a text selection behind the
    // pet. Restored in `finish`, on every path out.
    document.body.style.setProperty('user-select', 'none');
    publishPetDragFrame({ x: carry.x, y: carry.y, angle: 0 });

    /**
     * The swing, one frame at a time.
     *
     * Velocity decays every frame and the angle chases it, so the two things
     * the user asked for fall out of one loop: pulling him right tilts him
     * clockwise and pulling him left tilts him back, and stopping brings him
     * upright on his own rather than snapping.
     */
    const step = () => {
      const current = carryRef.current;
      if (!current) return;

      const swung = advanceSwing(current, current.still);
      current.velocity = swung.velocity;
      current.angle = swung.angle;

      publishPetDragFrame({ x: current.x, y: current.y, angle: current.angle });
      // Hit-testing is a layout read, so it happens once a frame rather than
      // once per pointer event — which on a fast mouse is several a frame.
      setPetDropTarget(resolvePetDropTarget(current.x, current.y));

      current.frame = requestAnimationFrame(step);
    };

    carry.frame = requestAnimationFrame(step);
  }, []);

  /** One pointer move: where he is, how fast, and whether this is a drag at all yet. */
  const track = useCallback((event: PointerEvent) => {
    const carry = carryRef.current;
    if (!carry || event.pointerId !== carry.pointerId) return;

    carry.x = event.clientX;
    carry.y = event.clientY;

    if (!carry.carrying) {
      const travelled = Math.hypot(event.clientX - carry.startX, event.clientY - carry.startY);
      // Still just a press. The browser is owed a click, so nothing is
      // prevented and nothing is drawn.
      if (travelled < CARRY_THRESHOLD_PX) return;
      begin(carry);
    }

    // Floored, because two events can share a timestamp and dividing by that
    // gap gives an infinite swing.
    const elapsed = Math.max(4, event.timeStamp - carry.lastAt);
    const measured = (event.clientX - carry.lastX) / elapsed;
    carry.velocity = carry.velocity * (1 - VELOCITY_BLEND) + measured * VELOCITY_BLEND;
    carry.lastX = event.clientX;
    carry.lastAt = event.timeStamp;
    event.preventDefault();
  }, [begin]);

  const getCarryProps = useCallback((pet: InstalledPet): PetCarryProps => ({
    onPointerDown: (event) => {
      // Left button only, and never a modified click: both of those are ways of
      // asking for a menu, not for the pet.
      if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
      finish(false);
      // A carry that ended away from its icon never got its click, so the flag
      // is cleared at the start of the next press rather than left to eat one.
      swallowClickRef.current = false;

      const node = event.currentTarget;
      // Captured on the press rather than when the threshold is crossed: a fast
      // flick can leave a 36px icon before a single move event lands on it, and
      // a gesture that needs the pointer to still be over its origin to start
      // is a gesture that fails exactly when it is used confidently.
      node.setPointerCapture(event.pointerId);

      /**
       * The gesture listens on the window, not on the icon.
       *
       * Pointer capture alone would be neater, but it is held by the icon, and
       * the icon is the one element in this gesture that can disappear
       * underneath it: the tray re-reads the library on every write, and a
       * React re-render that drops the node takes the capture with it. The
       * events still reach the window afterwards, so the carry survives losing
       * the thing it started from — which is the failure the HTML5 version had
       * no answer to, because its ghost *was* a picture of that node.
       */
      const onMove = (moved: PointerEvent) => track(moved);
      const onUp = (released: PointerEvent) => {
        const carry = carryRef.current;
        if (!carry || released.pointerId !== carry.pointerId) return;
        carry.x = released.clientX;
        carry.y = released.clientY;
        finish(true);
      };
      const onCancel = () => finish(false);

      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);

      carryRef.current = {
        pointerId: event.pointerId,
        node,
        pet,
        // The carousel only holds installed pets; a catalogue listing is dragged
        // from the marketplace, which still uses the HTML5 gesture.
        payload: { kind: 'installed', id: pet.definition.id, displayName: pet.definition.displayName },
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        lastAt: event.timeStamp,
        velocity: 0,
        angle: 0,
        carrying: false,
        still: prefersReducedMotion(),
        frame: undefined,
        detach: () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
        },
      };
    },

    onClickCapture: (event) => {
      if (!swallowClickRef.current) return;
      swallowClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },

    draggable: false,
    // The browser must not claim the gesture for panning before it is known
    // whether this is a drag.
    style: { touchAction: 'none' },
  }), [finish, track]);

  return { carryingId, getCarryProps };
}
