import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  PetSprite,
  resolveCellBox,
  suppressDesktopPet,
  type InstalledPet,
} from '@/components/marketplace';
// Deep imports, deliberately: the carry gesture and the drag state are not on
// the marketplace's public surface yet, and that surface belongs to someone
// else this round. Importing the modules directly reuses their gesture without
// editing their barrel — see the report for the two exports worth promoting.
import { usePetCarry } from '@/components/marketplace/pet-carry';
import { readPetDragFrame, usePetDragState } from '@/components/marketplace/pet-drag';
import { useReducedMotion } from '@/shared/ui/Motion';

import { readSessionPet } from './chat-pet-api';

/**
 * The pet that walks out when you open its conversation.
 *
 * A pet assigned to a chat belongs to that chat, so opening it should feel like
 * arriving somewhere he already lives: he comes out from behind the sidebar,
 * walks into the left gutter, and stays there until he is picked up. Carrying
 * him out of the window hands him back to the desktop.
 *
 * ## Where it draws
 *
 * Into `[data-tails-chat-overlay]`, by portal, because the chat view owns its
 * own tree and a pet is not its concern. The chat view publishes the boxes and
 * this reads them rather than assuming any geometry:
 *
 * - the overlay, which is the coordinate space;
 * - `[data-tails-chat-stage]`, whose bottom edge is the floor — the stage stops
 *   where the composer starts, which is the line he should stand above.
 *
 * ## Everything is keyed to the arrival
 *
 * "This pet, in this conversation, this time" is the unit of state. The walk
 * happens once per arrival, and the position and the handoff belong to one — so
 * they are derived from it rather than reset by effects when the conversation
 * changes. That is also what keeps the animation frame alive: an earlier
 * version cancelled its own walk whenever a re-measure re-ran the effect, and
 * the pet spent his life standing behind the sidebar.
 */

/** His height in the window, in CSS pixels. Small enough to share the gutter with text. */
const PET_HEIGHT = 72;

/** Walking speed, in pixels per second. A stroll rather than a scurry. */
const WALK_SPEED = 120;

/** How far in from the overlay's left edge he settles — the chat's left padding. */
const GUTTER_INSET = 6;

type ChatPetProps = {
  /** The conversation on screen, or null when there is none. */
  sessionId: string | null;
};

type Placement = { floorTop: number; restX: number; startX: number };

/** Where he is right now, and which arrival it belongs to. */
type Walk = { arrival: string; x: number; walking: boolean };

/**
 * Measures the boxes the chat view publishes.
 *
 * Returns null until they exist: the overlay mounts with the chat view, and the
 * stage has no useful height until the transcript has laid out.
 */
function measure(overlay: HTMLElement, spriteWidth: number): Placement | null {
  const stage = document.querySelector('[data-tails-chat-stage]');
  if (!stage) return null;

  const overlayRect = overlay.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  if (stageRect.height < PET_HEIGHT) return null;

  return {
    floorTop: stageRect.bottom - overlayRect.top - PET_HEIGHT,
    // The chat's left padding, which is where he was asked to stand. On a
    // window narrow enough that the output column reaches the edge he will
    // overlap it slightly, which is better than standing off-screen.
    restX: GUTTER_INSET,
    // Off the left edge: the sidebar is immediately left of the overlay, so
    // this is behind it.
    startX: -spriteWidth,
  };
}

export function ChatPet({ sessionId }: ChatPetProps) {
  const reduced = useReducedMotion();
  const [overlay, setOverlay] = useState<HTMLElement | null>(null);
  const [assignment, setAssignment] = useState<{ sessionId: string; pet: InstalledPet | null } | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [walk, setWalk] = useState<Walk | null>(null);
  const [handedOffArrival, setHandedOffArrival] = useState<string | null>(null);

  // Derived rather than reset: a pet left over from the previous conversation
  // is simply not this conversation's pet.
  const pet = assignment && assignment.sessionId === sessionId ? assignment.pet : null;
  const arrival = pet && sessionId ? `${sessionId}:${pet.definition.id}` : null;
  const handedOff = handedOffArrival !== null && handedOffArrival === arrival;
  const position = walk && walk.arrival === arrival ? walk : null;

  const spriteWidth = useMemo(() => (
    pet ? resolveCellBox(pet.definition.frame, PET_HEIGHT).cellWidth : PET_HEIGHT
  ), [pet]);

  const frameRef = useRef<number | undefined>(undefined);
  const walkedRef = useRef<string | null>(null);

  // The overlay belongs to the chat view, which mounts and unmounts as the user
  // moves between chat and the marketplace, so this watches for it rather than
  // looking once.
  useEffect(() => {
    const find = () => setOverlay(document.querySelector<HTMLElement>('[data-tails-chat-overlay]'));
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    find();

    return () => observer.disconnect();
  }, []);

  // Which pet, if any, belongs to this conversation. The server resolves the
  // assignment; this surface only knows which chat is open.
  useEffect(() => {
    if (!sessionId) return undefined;

    let cancelled = false;
    readSessionPet(sessionId)
      .then((resolved) => {
        if (cancelled) return;
        // Only a pet assigned to *this* conversation walks out. The globally
        // active pet lives on the desktop and is not a guest in every chat.
        setAssignment({ sessionId, pet: resolved.source === 'session' ? resolved.pet : null });
      })
      .catch(() => {
        if (!cancelled) setAssignment({ sessionId, pet: null });
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Re-measured on resize and as the transcript grows: the floor is the top of
  // the composer, which moves.
  useEffect(() => {
    if (!overlay || !pet) return undefined;

    const update = () => setPlacement((current) => {
      const next = measure(overlay, spriteWidth);
      // Compared by value. A ResizeObserver fires for every layout pass, and a
      // fresh object each time re-runs everything downstream — which is what
      // used to cancel the walk mid-stride.
      if (current && next
        && current.floorTop === next.floorTop
        && current.restX === next.restX
        && current.startX === next.startX) {
        return current;
      }
      return next;
    });

    const observer = new ResizeObserver(update);
    observer.observe(overlay);
    const stage = document.querySelector('[data-tails-chat-stage]');
    if (stage) observer.observe(stage);
    window.addEventListener('resize', update);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [overlay, pet, spriteWidth]);

  // The walk: from behind the sidebar to the gutter, once per arrival.
  useEffect(() => {
    if (!placement || !arrival || handedOff || walkedRef.current === arrival) return undefined;
    walkedRef.current = arrival;

    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);

    let x = reduced ? placement.restX : placement.startX;
    let previous = performance.now();

    // Even the first placement goes through a frame rather than being set in
    // the effect body. Reduced motion lands him on the first tick instead of
    // animating: he should be present, not make an entrance.
    const step = (now: number) => {
      const elapsed = (now - previous) / 1000;
      previous = now;
      if (!reduced) x = Math.min(placement.restX, x + WALK_SPEED * elapsed);

      const walking = x < placement.restX;
      setWalk({ arrival, x, walking });

      if (!walking) {
        frameRef.current = undefined;
        return;
      }
      frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);

    // No cleanup here: the walk belongs to the arrival, and this effect re-runs
    // for things that are not a new arrival. Cancelling on those is what left
    // him behind the sidebar. It is cancelled below, where it is really over.
    return undefined;
  }, [placement, arrival, handedOff, reduced]);

  useEffect(() => {
    if (walkedRef.current !== null && walkedRef.current !== arrival) walkedRef.current = null;
  }, [arrival]);

  useEffect(() => () => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
  }, []);

  /**
   * Carrying him, using the same gesture as the carousel.
   *
   * Not a third drag: the pointer carry already knows how to pinch, swing and
   * resolve a drop, and a pet that behaved differently depending on which
   * surface he came from would be a bug rather than a feature.
   */
  const { carryingId, getCarryProps } = usePetCarry();
  const carried = pet !== null && carryingId === pet.definition.id;

  /**
   * Dropping him outside the window gives him back to the desktop.
   *
   * The carry reports a drop *target* only when he lands on one, so "nowhere"
   * has to be read from the last frame: released beyond the viewport means he
   * left the window.
   */
  const dragState = usePetDragState();
  const wasCarried = useRef(false);
  const handOff = useCallback((key: string) => setHandedOffArrival(key), []);

  useEffect(() => {
    const nowCarried = pet !== null && dragState.payload?.id === pet.definition.id;

    if (wasCarried.current && !nowCarried && arrival) {
      const frame = readPetDragFrame();
      const outside = frame.x < 0 || frame.y < 0
        || frame.x > window.innerWidth || frame.y > window.innerHeight;
      // Deferred out of the effect body: this reacts to an external store
      // changing, and setting state synchronously here cascades renders.
      if (outside) queueMicrotask(() => handOff(arrival));
    }

    wasCarried.current = nowCarried;
  }, [dragState, pet, arrival, handOff]);

  // While he is in the window the desktop one stands aside, and takes over
  // again the moment he is not — including when the chat is closed.
  useEffect(() => {
    suppressDesktopPet(Boolean(pet) && !handedOff);
    return () => suppressDesktopPet(false);
  }, [pet, handedOff]);

  if (!overlay || !pet || !placement || !position || handedOff || carried) return null;

  const carryProps = getCarryProps(pet);

  return createPortal(
    <div
      {...carryProps}
      style={{
        ...carryProps.style,
        position: 'absolute',
        left: `${position.x}px`,
        top: `${placement.floorTop}px`,
        // The overlay is inert so the transcript stays clickable through it; he
        // is the one thing in it that is not.
        pointerEvents: 'auto',
      }}
      title={`${pet.definition.displayName} — carry him out of the window to put him back on your desktop`}
    >
      <PetSprite pet={pet} size={PET_HEIGHT} state={position.walking ? 'running-right' : 'idle'} />
    </div>,
    overlay,
  );
}
