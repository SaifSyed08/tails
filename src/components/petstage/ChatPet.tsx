import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  PetSprite,
  readPetDragFrame,
  resolveCellBox,
  usePetCarry,
  usePetDragState,
  suppressDesktopPet,
  type InstalledPet,
  type PetStateName,
} from '@/components/marketplace';
import { useWebSocket } from '@/contexts/WebSocketContext';
import { useReducedMotion } from '@/shared/ui/Motion';

import { readSessionPet } from './chat-pet-api';
import { PetPill } from './PetPill';
import { useChatActivity } from './useChatActivity';

/**
 * The pet who lives in a conversation.
 *
 * Assigned to a chat, he is *in* that chat: he arrives when you open it, walks
 * about above the composer, reacts to being pointed at, and shows what Claude
 * is doing while it does it. Carried out of the window he goes back to the
 * desktop; unassigned, he leaves.
 *
 * ## Where it draws
 *
 * Into `[data-tails-chat-overlay]`, by portal, because the chat view owns its
 * own tree and a pet is not its business. It reads the boxes the chat view
 * publishes rather than assuming any geometry: the overlay is the coordinate
 * space, `[data-tails-chat-stage]`'s bottom edge is the floor, and
 * `[data-tails-chat-column]` is the reading area he keeps out of. The column
 * scrolls and resizes, so it is re-read rather than cached.
 *
 * ## Two entrances
 *
 * Opening a chat he is assigned to, he walks in from behind the sidebar —
 * that is arriving somewhere he already lives. Dropped into the chat, he lands
 * where he was dropped: the gesture already said where he should be, and
 * marching him back to the door would throw that away.
 */

/** His height in the window, in CSS pixels. */
const PET_HEIGHT = 72;

/** Walking speed, in pixels per second. A stroll rather than a scurry. */
const WALK_SPEED = 120;

/** How far in from the overlay's left edge he enters and rests. */
const GUTTER_INSET = 6;

/** Gap between wanders. He is company, not a screensaver. */
const WANDER_MIN_MS = 7000;
const WANDER_MAX_MS = 16000;

/** How long each beat of the arrival greeting lasts. */
const GREETING_MS = 900;

/** How long a click's jump lasts before he settles again. */
const REACTION_MS = 1200;

/**
 * How long after a drag ends a new assignment still counts as that drop.
 *
 * The assignment is written by the server and comes back over the wire, so it
 * lands a moment after the hand opened. Generous, because the alternative is a
 * pet who was clearly just put down marching back in from the doorway.
 */
const DROP_GRACE_MS = 2500;

type ChatPetProps = {
  /** The conversation on screen, or null when there is none. */
  sessionId: string | null;
};

type Geometry = {
  /** Top edge for a pet standing on the floor. */
  floorTop: number;
  /** The walkable span, in overlay coordinates. */
  maxX: number;
  /** The reading column, which he crosses but does not loiter in. */
  column: { left: number; right: number } | null;
};

type Arrival = 'walk' | 'drop';

/** Where he is and what he is doing, all keyed to one arrival. */
type Motion = {
  arrival: string;
  x: number;
  /** Non-null while walking somewhere. */
  target: number | null;
  facing: 'left' | 'right';
  /** Overrides the resting animation: the greeting beats and click reactions. */
  gesture: PetStateName | null;
};

const randomBetween = (low: number, high: number) => low + Math.random() * (high - low);

/**
 * Measures the boxes the chat view publishes.
 *
 * Null until they exist and have room: the overlay mounts with the chat view,
 * and the stage has no useful height until the transcript has laid out.
 */
function measure(overlay: HTMLElement, spriteWidth: number): Geometry | null {
  const stage = document.querySelector('[data-tails-chat-stage]');
  if (!stage) return null;

  const overlayRect = overlay.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  if (stageRect.height < PET_HEIGHT || overlayRect.width < spriteWidth * 2) return null;

  const columnRect = document.querySelector('[data-tails-chat-column]')?.getBoundingClientRect();

  return {
    floorTop: stageRect.bottom - overlayRect.top - PET_HEIGHT,
    maxX: overlayRect.width - spriteWidth,
    column: columnRect
      ? { left: columnRect.left - overlayRect.left, right: columnRect.right - overlayRect.left }
      : null,
  };
}

/**
 * Somewhere to stand that is not on top of what Claude wrote.
 *
 * He may cross the column — the room is not divided in half — but he does not
 * stop in it. When neither margin is wide enough to hold him, he stays where he
 * is rather than picking the least-bad spot on the text.
 */
function pickWanderTarget(geometry: Geometry, spriteWidth: number, from: number): number | null {
  const bands: [number, number][] = [];
  const { column, maxX } = geometry;

  if (!column) {
    bands.push([GUTTER_INSET, maxX]);
  } else {
    // Both margins, however narrow — the filter below throws out the ones with
    // no room, which is the same test written once instead of twice.
    bands.push([GUTTER_INSET, column.left - spriteWidth - GUTTER_INSET]);
    bands.push([column.right + GUTTER_INSET, maxX - GUTTER_INSET]);
  }

  const usable = bands.filter(([low, high]) => high > low);
  if (usable.length === 0) return null;

  const [low, high] = usable[Math.floor(Math.random() * usable.length)];
  const target = randomBetween(low, high);
  // A stroll of two pixels is a twitch. Ask again rather than perform it.
  return Math.abs(target - from) < 40 ? null : target;
}

export function ChatPet({ sessionId }: ChatPetProps) {
  const reduced = useReducedMotion();
  const { subscribe } = useWebSocket();
  const activity = useChatActivity(sessionId);

  const [overlay, setOverlay] = useState<HTMLElement | null>(null);
  const [assignment, setAssignment] = useState<{ sessionId: string; pet: InstalledPet | null } | null>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [motion, setMotion] = useState<Motion | null>(null);
  const [hovered, setHovered] = useState(false);
  const [handedOffArrival, setHandedOffArrival] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Derived rather than reset: a pet left over from the previous conversation
  // is simply not this conversation's pet.
  const pet = assignment && assignment.sessionId === sessionId ? assignment.pet : null;
  const arrival = pet && sessionId ? `${sessionId}:${pet.definition.id}` : null;
  const handedOff = handedOffArrival !== null && handedOffArrival === arrival;
  const here = motion && motion.arrival === arrival ? motion : null;

  const spriteWidth = useMemo(() => (
    pet ? resolveCellBox(pet.definition.frame, PET_HEIGHT).cellWidth : PET_HEIGHT
  ), [pet]);

  const frameRef = useRef<number | undefined>(undefined);
  const wanderRef = useRef<number | undefined>(undefined);
  const gestureRef = useRef<number | undefined>(undefined);
  const enteredRef = useRef<string | null>(null);
  /**
   * The last carry that ended, and where.
   *
   * This is what tells the two entrances apart. Session identity cannot: a chat
   * you already had open is exactly the case where both a drop and a first
   * assignment look the same from here. A drag that just ended is the actual
   * evidence that someone put him there, and it carries the x as well.
   */
  const dropRef = useRef<{ at: number; x: number } | null>(null);

  // Watches for a carry ending anywhere in the app. Recorded rather than acted
  // on: whether it concerns this chat is only known when the assignment arrives.
  const dragging = usePetDragState().payload !== null;
  useEffect(() => {
    if (dragging) return undefined;
    dropRef.current = { at: performance.now(), x: readPetDragFrame().x };
    return undefined;
  }, [dragging]);

  // The overlay belongs to the chat view, which mounts and unmounts as the user
  // moves between chat and the marketplace.
  useEffect(() => {
    const find = () => setOverlay(document.querySelector<HTMLElement>('[data-tails-chat-overlay]'));
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    find();

    return () => observer.disconnect();
  }, []);

  // Who lives in this conversation. Re-read whenever something might have
  // changed it — the server resolves the assignment; this surface only knows
  // which chat is open.
  useEffect(() => {
    if (!sessionId) return undefined;

    let cancelled = false;
    readSessionPet(sessionId)
      .then((resolved) => {
        if (cancelled) return;
        // Only a pet assigned to *this* conversation lives here. The globally
        // active pet lives on the desktop and is not a guest in every chat.
        setAssignment({ sessionId, pet: resolved.source === 'session' ? resolved.pet : null });
      })
      .catch(() => {
        if (!cancelled) setAssignment({ sessionId, pet: null });
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadToken]);

  /**
   * When to look again.
   *
   * Assignment is written by the sessions module, which does not announce it,
   * so this listens for everything that might mean it changed: the pets
   * broadcast (which the assign path now publishes), any session change, and
   * the window coming back. See the report — one broadcast from `assignPet`
   * would replace all of this.
   */
  useEffect(() => {
    const reload = () => setReloadToken((current) => current + 1);

    const unsubscribe = subscribe((message) => {
      if (message.kind === 'pets_changed' || message.kind === 'sessions_changed') reload();
    });
    window.addEventListener('focus', reload);

    return () => {
      unsubscribe();
      window.removeEventListener('focus', reload);
    };
  }, [subscribe]);

  // Re-measured as the transcript grows and the window resizes: the floor is
  // the top of the composer, and the column's width decides where he can rest.
  useEffect(() => {
    if (!overlay || !pet) return undefined;

    const update = () => setGeometry((current) => {
      const next = measure(overlay, spriteWidth);
      // Compared by value: a ResizeObserver fires for every layout pass, and a
      // fresh object each time would re-run everything downstream.
      if (current && next
        && current.floorTop === next.floorTop
        && current.maxX === next.maxX
        && current.column?.left === next.column?.left
        && current.column?.right === next.column?.right) {
        return current;
      }
      return next;
    });

    const observer = new ResizeObserver(update);
    observer.observe(overlay);
    const stage = document.querySelector('[data-tails-chat-stage]');
    const column = document.querySelector('[data-tails-chat-column]');
    if (stage) observer.observe(stage);
    if (column) observer.observe(column);
    window.addEventListener('resize', update);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [overlay, pet, spriteWidth]);

  /** Walks him to a target, or puts him there directly under reduced motion. */
  const walkTo = useCallback((target: number) => {
    setMotion((current) => (current ? { ...current, target } : current));
  }, []);

  /** Plays a one-off animation, then lets him settle back. */
  const gesture = useCallback((state: PetStateName, forMs: number) => {
    if (gestureRef.current !== undefined) window.clearTimeout(gestureRef.current);
    setMotion((current) => (current ? { ...current, gesture: state } : current));
    gestureRef.current = window.setTimeout(() => {
      gestureRef.current = undefined;
      setMotion((current) => (current ? { ...current, gesture: null } : current));
    }, forMs);
  }, []);

  // The entrance, once per arrival.
  useEffect(() => {
    if (!geometry || !arrival || !pet || handedOff || enteredRef.current === arrival) return undefined;
    enteredRef.current = arrival;

    // Which entrance: he was just carried and let go, or he was already here
    // and you opened the door.
    const drop = dropRef.current;
    const entrance: Arrival = drop && performance.now() - drop.at < DROP_GRACE_MS ? 'drop' : 'walk';

    if (entrance === 'drop' && drop) {
      const overlayLeft = overlay?.getBoundingClientRect().left ?? 0;
      // Where the hand opened, on the floor. Clamped, because a pet dropped on
      // the far edge of the window still has to stand somewhere.
      const x = Math.max(GUTTER_INSET, Math.min(
        geometry.maxX,
        drop.x - overlayLeft - spriteWidth / 2,
      ));
      setMotion({ arrival, x, target: null, facing: 'right', gesture: 'jumping' });
      gestureRef.current = window.setTimeout(() => {
        gestureRef.current = undefined;
        setMotion((current) => (current ? { ...current, gesture: null } : current));
      }, REACTION_MS);
      return undefined;
    }

    const start = reduced ? GUTTER_INSET : -spriteWidth;
    setMotion({
      arrival,
      x: start,
      target: reduced ? null : GUTTER_INSET,
      facing: 'right',
      gesture: null,
    });

    return undefined;
  }, [geometry, arrival, pet, handedOff, reduced, sessionId, spriteWidth, overlay]);

  useEffect(() => {
    if (enteredRef.current !== null && enteredRef.current !== arrival) enteredRef.current = null;
  }, [arrival]);

  /**
   * The walk itself.
   *
   * One frame loop for the lifetime of the component rather than one per
   * journey: a loop that is started and cancelled by effects gets cancelled by
   * things that are not the end of a journey, which is how an earlier version
   * left him standing behind the sidebar.
   */
  useEffect(() => {
    let previous = performance.now();

    const step = (now: number) => {
      const elapsed = Math.min(0.05, (now - previous) / 1000);
      previous = now;

      setMotion((current) => {
        if (!current || current.target === null) return current;

        const direction = current.target > current.x ? 1 : -1;
        const next = current.x + direction * WALK_SPEED * elapsed;
        const arrived = direction > 0 ? next >= current.target : next <= current.target;

        if (arrived) {
          return { ...current, x: current.target, target: null };
        }
        return { ...current, x: next, facing: direction > 0 ? 'right' : 'left' };
      });

      frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  /** The greeting: he looks around, waves, then gets on with it. */
  const greeted = useRef<string | null>(null);
  useEffect(() => {
    if (!here || here.target !== null || !arrival || greeted.current === arrival) return undefined;
    if (reduced) {
      greeted.current = arrival;
      return undefined;
    }
    greeted.current = arrival;

    const look = window.setTimeout(() => gesture('look-right-side', GREETING_MS), 0);
    const wave = window.setTimeout(() => gesture('waving', GREETING_MS), GREETING_MS);

    return () => {
      window.clearTimeout(look);
      window.clearTimeout(wave);
    };
  }, [here, arrival, reduced, gesture]);

  // Wandering, once he is settled and nothing is happening.
  useEffect(() => {
    if (!here || !geometry || reduced || activity !== 'idle' || hovered) return undefined;

    wanderRef.current = window.setTimeout(() => {
      const target = pickWanderTarget(geometry, spriteWidth, here.x);
      if (target !== null) walkTo(target);
    }, randomBetween(WANDER_MIN_MS, WANDER_MAX_MS));

    return () => {
      if (wanderRef.current !== undefined) window.clearTimeout(wanderRef.current);
    };
  }, [here, geometry, reduced, activity, hovered, spriteWidth, walkTo]);

  /**
   * Carrying him.
   *
   * The same gesture as everywhere else in the app — one carry, one threshold,
   * one definition of "let go outside the window", one set of escape hatches.
   * While it runs he is drawn by the drag layer rather than by this component,
   * so the sprite here steps aside for the duration.
   *
   * Where he lands is this surface's business: let go over nothing inside the
   * window, he goes back on the floor where the hand opened. Let go outside it,
   * he is on the desktop and this stops drawing him. Let go on a real drop
   * target, that target decides, and the assignment comes back over the wire.
   */
  const { carryingId, getCarryProps } = usePetCarry({
    onRelease: ({ target, x, outsideWindow }) => {
      if (outsideWindow) {
        if (arrival) setHandedOffArrival(arrival);
        suppressDesktopPet(false);
        return;
      }
      if (target) return;

      const rect = overlay?.getBoundingClientRect();
      const geometryNow = geometry;
      if (!rect || !geometryNow) return;
      // Only the horizontal is kept: he stands on a floor, and putting him
      // down in mid-air would mean deciding what he does up there.
      const landing = Math.max(0, Math.min(geometryNow.maxX, x - rect.left - spriteWidth / 2));
      setMotion((current) => (current ? { ...current, x: landing, target: null } : current));
    },
  });
  const carrying = pet !== null && carryingId === pet.definition.id;

  // While he is in the window the desktop one stands aside, and takes over
  // again the moment he is not — closed chat, unassigned, or carried out.
  useEffect(() => {
    suppressDesktopPet(Boolean(pet) && !handedOff);
    return () => suppressDesktopPet(false);
  }, [pet, handedOff]);

  useEffect(() => () => {
    if (wanderRef.current !== undefined) window.clearTimeout(wanderRef.current);
    if (gestureRef.current !== undefined) window.clearTimeout(gestureRef.current);
  }, []);

  if (!overlay || !pet || !geometry || !here || handedOff) return null;

  /**
   * What he is playing, most specific first.
   *
   * Being carried and walking are things happening to him now; a gesture is a
   * reaction he owes someone; the activity is the room's state; idle is the
   * absence of all of it.
   */
  const state: PetStateName = here.target !== null
    ? (here.facing === 'left' ? 'running-left' : 'running-right')
    : here.gesture
      ?? (hovered ? 'waving'
        : activity === 'thinking' ? 'waiting'
          : activity === 'working' ? 'running'
            : activity === 'done' ? 'jumping'
              : 'idle');

  return createPortal(
    <div
      {...getCarryProps(pet)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onClick={() => gesture('jumping', REACTION_MS)}
      onContextMenu={(event) => {
        // Right-click still works. The pill is an additional way in, not a
        // replacement for the one people already know.
        event.preventDefault();
        gesture('waving', REACTION_MS);
      }}
      style={{
        ...getCarryProps(pet).style,
        position: 'absolute',
        left: `${here.x}px`,
        top: `${geometry.floorTop}px`,
        width: `${spriteWidth}px`,
        height: `${PET_HEIGHT}px`,
        // The overlay is inert so the transcript stays clickable through it; he
        // is the one thing in it that is not.
        pointerEvents: 'auto',
        // Drawn by the drag layer while he is in the air, so this space is left
        // empty rather than showing a second copy of him.
        opacity: carrying ? 0 : 1,
        touchAction: 'none',
      }}
      title={`${pet.definition.displayName} — carry him out of the window to put him back on your desktop`}
    >
      <PetSprite pet={pet} size={PET_HEIGHT} state={state} facing={here.facing} />
      <PetPill
        open={hovered && !carrying}
        width={spriteWidth}
        onOpenMenu={() => gesture('waving', REACTION_MS)}
      />
    </div>,
    overlay,
  );
}
