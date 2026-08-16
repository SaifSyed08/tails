import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  hideDesktopPet,
  PetSprite,
  readPetDragFrame,
  refreshDesktopPet,
  resolveCellBox,
  SPRITE_KEYFRAMES,
  suppressDesktopPet,
  usePetDragState,
  type InstalledPet,
  type PetStateName,
} from '@/components/marketplace';
import { useWebSocket } from '@/contexts/WebSocketContext';
import { useReducedMotion } from '@/shared/ui/Motion';

import {
  activatePet,
  readDisplayPet,
  readSessionPet,
  readStage,
  savePetStage,
  type PetStage,
} from './chat-pet-api';
import { onDesktopPetDetails, placeDesktopPetAt } from './desktop-handoff';
import { PetDetailsPanel } from './PetDetailsPanel';
import { PetPill } from './PetPill';
import { advanceMotion, type Motion } from './pet-motion';
import { fpsForState } from './sprite-rate';
import { useChatActivity } from './useChatActivity';
import { useInChatCarry } from './useInChatCarry';

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
 * ## He has weight
 *
 * Everything that puts him somewhere puts him there *in the air*, and he falls
 * to the floor from it — dropped in from the tray, or picked up and let go
 * inside the window. Teleporting him onto the floor under the cursor was the
 * thing that read as wrong: a pet who arrives without falling is a sprite being
 * repositioned, not an animal being put down. A drop from the tray also grows
 * him from the size the drag layer drew him at to the size he stands at here,
 * so the small icon you were carrying and the pet who lands are one thing.
 *
 * ## Two entrances
 *
 * Opening a chat he is assigned to, he walks in from behind the sidebar — that
 * is arriving somewhere he already lives. Dropped in, he lands where he was
 * dropped: the gesture already said where he should be.
 */

/** His designed standing height, in CSS pixels, before the user's own size. */
const PET_HEIGHT = 72;

/**
 * The height the tray's drag layer draws a carried pet at.
 *
 * Mirrored from `CARRIED_SIZE` in `PetDragLayer`, which is where a pet dropped
 * in from the carousel is arriving *from*. Only the start of the growth, so a
 * few pixels of disagreement cost nothing.
 */
const CARRIED_HEIGHT = 40;

/** The squash on landing. Brief: this is a landing, not a bounce. */
const SQUASH_MS = 150;

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
 * How much of the margin beside the transcript he strolls in.
 *
 * His words: about 80% of the left padding, less half his width. He lives in
 * that gutter, so the walk has to be measured against it rather than against
 * the window — a wander computed from the whole width sends him across the
 * text, and one computed from nothing keeps him standing in the corner.
 */
const WANDER_SPAN = 0.8;

/** How far past the chat's edge the hand goes before the desktop takes him. */
const EDGE_HYSTERESIS = 12;

/**
 * The shortest stroll worth performing.
 *
 * Small, because the gutter is small: at the old 40px he would decline almost
 * every wander a narrow margin offered him, which is a large part of why he
 * never appeared to walk left.
 */
const MIN_STROLL = 12;

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

const randomBetween = (low: number, high: number) => low + Math.random() * (high - low);

/**
 * Measures the boxes the chat view publishes.
 *
 * Null until they exist and have room: the overlay mounts with the chat view,
 * and the stage has no useful height until the transcript has laid out.
 */
function measure(overlay: HTMLElement, width: number, height: number): Geometry | null {
  const stage = document.querySelector('[data-tails-chat-stage]');
  if (!stage) return null;

  const overlayRect = overlay.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  if (stageRect.height < height || overlayRect.width < width * 2) return null;

  const columnRect = document.querySelector('[data-tails-chat-column]')?.getBoundingClientRect();

  return {
    floorTop: stageRect.bottom - overlayRect.top - height,
    maxX: overlayRect.width - width,
    column: columnRect
      ? { left: columnRect.left - overlayRect.left, right: columnRect.right - overlayRect.left }
      : null,
  };
}

/**
 * Somewhere to stand that is not on top of what Claude wrote.
 *
 * Measured against the margin he lives in rather than against the window, so
 * the walk is as long as the space actually is: a wide window gives him room to
 * roam and a narrow one keeps him tucked beside the composer. A margin too thin
 * to hold him means he stays where he is rather than standing on the text.
 */
function pickWanderTarget(geometry: Geometry, spriteWidth: number, from: number): number | null {
  const { column, maxX } = geometry;

  // No column means no transcript to keep off, so the room is his.
  const limit = column
    ? WANDER_SPAN * column.left - spriteWidth / 2
    : maxX;
  const high = Math.min(maxX, limit);
  if (high <= GUTTER_INSET) return null;

  const target = randomBetween(GUTTER_INSET, high);
  // A stroll of two pixels is a twitch. Ask again rather than perform it.
  return Math.abs(target - from) < MIN_STROLL ? null : target;
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  /**
   * The desktop pet, when his own pill asked for this panel.
   *
   * Hosted here because this component is the app's one always-mounted piece of
   * pet, and the panel has to open whichever conversation happens to be on
   * screen — including none. He is resolved rather than passed: the shell knows
   * which pet was clicked, but only the server can turn that into a pet.
   */
  const [desktopPet, setDesktopPet] = useState<InstalledPet | null>(null);
  /** The size and walk settings as the user is changing them, before the reload. */
  const [pendingStage, setPendingStage] = useState<{ petId: string; stage: PetStage } | null>(null);

  // Derived rather than reset: a pet left over from the previous conversation
  // is simply not this conversation's pet.
  const pet = assignment && assignment.sessionId === sessionId ? assignment.pet : null;
  const arrival = pet && sessionId ? `${sessionId}:${pet.definition.id}` : null;
  const handedOff = handedOffArrival !== null && handedOffArrival === arrival;
  const here = motion && motion.arrival === arrival ? motion : null;

  const stage = pendingStage && pet && pendingStage.petId === pet.definition.id
    ? pendingStage.stage
    : readStage(pet);

  /**
   * His box, at the size the user has chosen.
   *
   * The ratio rather than the width, because the box has to be re-derived at
   * every height he passes through while growing, and the cell's shape is the
   * only part of that which is fixed.
   */
  const fullHeight = Math.round(PET_HEIGHT * stage.scale);
  const widthPerHeight = useMemo(() => (
    pet ? resolveCellBox(pet.definition.frame, 100).cellWidth / 100 : 1
  ), [pet]);
  const fullWidth = Math.round(fullHeight * widthPerHeight);

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
   * evidence that someone put him there, and it carries the point as well.
   */
  const dropRef = useRef<{ at: number; x: number; y: number } | null>(null);

  // Watches for a carry ending anywhere in the app. Recorded rather than acted
  // on: whether it concerns this chat is only known when the assignment arrives.
  const dragging = usePetDragState().payload !== null;
  const wasDraggingRef = useRef(false);
  useEffect(() => {
    if (dragging) {
      wasDraggingRef.current = true;
      return undefined;
    }
    // Nothing was in flight, so this is the component mounting rather than a
    // hand opening — and treating that as a drop would have every pet who was
    // already assigned fall out of the top-left corner instead of walking in.
    if (!wasDraggingRef.current) return undefined;
    wasDraggingRef.current = false;

    const frame = readPetDragFrame();
    dropRef.current = { at: performance.now(), x: frame.x, y: frame.y };

    // A hand opening anywhere retires the last handoff. Without this, a pet
    // carried out to the desktop and then dropped back into the same chat would
    // be refused: the arrival is the same string, and it was marked handed off.
    // Deferred out of the effect body because that is a render-time write.
    queueMicrotask(() => setHandedOffArrival(null));
    return undefined;
  }, [dragging]);

  // The desktop pet's settings button. The shell has already raised the app.
  useEffect(() => {
    onDesktopPetDetails(() => {
      void readDisplayPet()
        .then((resolved) => setDesktopPet(resolved.pet))
        .catch(() => setDesktopPet(null));
    });
  }, []);

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
      const next = measure(overlay, fullWidth, fullHeight);
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
    const stageNode = document.querySelector('[data-tails-chat-stage]');
    const column = document.querySelector('[data-tails-chat-column]');
    if (stageNode) observer.observe(stageNode);
    if (column) observer.observe(column);
    window.addEventListener('resize', update);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [overlay, pet, fullWidth, fullHeight]);

  /** Walks him to a target. */
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

    const base = {
      arrival,
      vy: 0,
      target: null,
      facing: 'right' as const,
      gesture: null,
      carried: false,
      squash: false,
    };

    // Which entrance: he was just carried and let go, or he was already here
    // and you opened the door.
    const drop = dropRef.current;
    if (drop && performance.now() - drop.at < DROP_GRACE_MS) {
      const rect = overlay?.getBoundingClientRect();
      const overlayLeft = rect?.left ?? 0;
      const overlayTop = rect?.top ?? 0;
      // Where the hand opened. Clamped horizontally, because a pet dropped on
      // the far edge still has to stand somewhere, and never below the floor —
      // there is nothing to fall from down there.
      const x = Math.max(GUTTER_INSET, Math.min(geometry.maxX, drop.x - overlayLeft - fullWidth / 2));
      const y = Math.min(0, drop.y - overlayTop - geometry.floorTop - fullHeight / 2);

      setMotion({ ...base, x, y: reduced ? 0 : y, grow: reduced ? 1 : 0 });
      return undefined;
    }

    setMotion({
      ...base,
      x: reduced ? GUTTER_INSET : -fullWidth,
      y: 0,
      grow: 1,
      target: reduced ? null : GUTTER_INSET,
    });

    return undefined;
  }, [geometry, arrival, pet, handedOff, reduced, fullWidth, fullHeight, overlay]);

  useEffect(() => {
    if (enteredRef.current !== null && enteredRef.current !== arrival) enteredRef.current = null;
  }, [arrival]);

  /**
   * Coming back to a conversation brings him back.
   *
   * Where he is standing is not a fact about the conversation — the assignment
   * is, and taking him out to the desktop never touched it. So leaving the chat
   * retires the handoff, and returning finds him living there as he always was.
   * Deferred out of the effect body because that is a render-time write.
   */
  useEffect(() => {
    queueMicrotask(() => setHandedOffArrival(null));
  }, [sessionId]);

  /**
   * Everything that moves him, one frame at a time.
   *
   * One loop for the lifetime of the component rather than one per journey: a
   * loop started and cancelled by effects gets cancelled by things that are not
   * the end of a journey, which is how an earlier version left him standing
   * behind the sidebar. It returns the state object unchanged when nothing is
   * happening, so a settled pet costs one comparison a frame and no renders.
   */
  useEffect(() => {
    let previous = performance.now();

    const step = (now: number) => {
      const elapsed = (now - previous) / 1000;
      previous = now;

      setMotion((current) => (current ? advanceMotion(current, elapsed) : current));

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

  // Wandering, once he is settled and nothing is happening. Off when the user
  // has turned it off — some people want a companion, not a distraction.
  useEffect(() => {
    if (!here || !geometry || reduced || !stage.walks) return undefined;
    if (activity !== 'idle' || hovered || here.carried) return undefined;
    // Already on his way somewhere, or in the air. Both end with him standing
    // still, and this effect re-runs then.
    if (here.target !== null || here.y < 0) return undefined;

    wanderRef.current = window.setTimeout(() => {
      const target = pickWanderTarget(geometry, fullWidth, here.x);
      if (target !== null) walkTo(target);
    }, randomBetween(WANDER_MIN_MS, WANDER_MAX_MS));

    return () => {
      if (wanderRef.current !== undefined) window.clearTimeout(wanderRef.current);
    };
  }, [here, geometry, reduced, activity, hovered, fullWidth, walkTo, stage.walks]);

  /**
   * Carrying him.
   *
   * His own gesture rather than the tray's — see `useInChatCarry` for why. He
   * stays the size he is, keeps his feet under the point you grabbed him by,
   * and the two ways it can end are the two things you can do with an animal
   * you have picked up: put him down, or put him outside.
   *
   * ## Crossing the edge of the chat
   *
   * The app window clips its own contents, so a pet carried towards the sidebar
   * used to slide *under* it and disappear — the hand kept moving and the
   * animal it was holding was gone. So the handoff happens the moment the
   * pointer leaves the chat, not when it is released: the desktop window is
   * un-suppressed and follows the pointer from there, and this stops drawing
   * him. Both halves are the same pet in the same place, so what the user sees
   * is one continuous gesture that happens to cross a window boundary.
   *
   * Coming back into the chat reverses it, because a hand that has not opened
   * has not decided anything yet.
   */
  const [outside, setOutside] = useState(false);
  const outsideRef = useRef(false);
  const activatedRef = useRef<string | null>(null);

  /**
   * Hands him to the desktop window, once per gesture.
   *
   * Activating him is the point: the desktop window shows the *active* pet and
   * nothing else, so without this a pet dragged out either vanished (nobody
   * active) or turned into whoever was — which is what "a different pet appears
   * outside the chat interface" was.
   */
  const takeOutside = useCallback((petId: string, show: boolean) => {
    if (activatedRef.current !== petId) {
      activatedRef.current = petId;
      void activatePet(petId).then(refreshDesktopPet).catch(() => {
        // He will still be carried on the desktop layer; he just may be the pet
        // the window already had. Nothing here is worth interrupting a drag.
      });
    }
    if (show) suppressDesktopPet(false);
  }, []);

  const { carrying, onPointerDown, onClickCapture } = useInChatCarry({
    onStart: () => {
      // Activated at the first movement, not when he crosses the edge.
      //
      // The desktop window only ever draws the active pet, and it has to fetch
      // the sheet, work out its cell and tell the shell what size to be. Doing
      // that at the boundary meant he arrived on the desktop as the *previous*
      // pet's geometry against the new sheet — a sprite cut off mid-row. Done
      // at pick-up, the window is sized and ready long before the hand gets
      // there, and it is still suppressed so nothing shows in the meantime.
      if (pet) takeOutside(pet.definition.id, false);
    },
    onMove: (left, top, pointer) => {
      const rect = overlay?.getBoundingClientRect();
      if (!rect || !geometry || !pet) return;

      // His middle, against the chat's box, with a dead band around the edge.
      // Crossing hands a window between two owners, and a hand that wobbles on
      // the boundary would otherwise hide and show a real OS window several
      // times a second.
      const centreX = left + fullWidth / 2;
      const centreY = top + fullHeight / 2;
      const beyond = Math.max(
        rect.left - centreX, centreX - rect.right,
        rect.top - centreY, centreY - rect.bottom,
      );
      const isOutside = beyond > (outsideRef.current ? -EDGE_HYSTERESIS : EDGE_HYSTERESIS);

      if (isOutside !== outsideRef.current) {
        outsideRef.current = isOutside;
        setOutside(isOutside);
        if (isOutside) takeOutside(pet.definition.id, true);
        else suppressDesktopPet(true);
      }

      if (isOutside) {
        // He is the desktop window now, and it follows the pointer directly.
        // No grab offset and no read-back: every position comes from the hand,
        // so nothing can accumulate — which is what six rounds of drift were.
        placeDesktopPetAt(pointer.x, pointer.y);
        return;
      }

      const x = left - rect.left;
      // Never below the floor: there is no room down there, and a pet behind
      // the composer is a pet nobody can get back.
      const y = Math.min(0, top - rect.top - geometry.floorTop);

      setMotion((current) => (current ? {
        ...current,
        carried: true,
        target: null,
        squash: false,
        x,
        y,
        facing: x < current.x - 1 ? 'left' : x > current.x + 1 ? 'right' : current.facing,
      } : current));
    },
    onCancel: () => {
      // Changed your mind mid-flight. He goes back to the chat, and the desktop
      // window steps aside again — an interruption decides nothing.
      outsideRef.current = false;
      setOutside(false);
      activatedRef.current = null;
      setMotion((current) => (current ? { ...current, carried: false, vy: 0 } : current));
    },
    onRelease: ({ clientX, clientY }) => {
      const wasOutside = outsideRef.current;
      outsideRef.current = false;
      setOutside(false);
      activatedRef.current = null;

      if (wasOutside) {
        // Left on the desktop. The assignment is untouched: he still belongs to
        // this conversation, and coming back to it brings him back in.
        placeDesktopPetAt(clientX, clientY);
        if (arrival) setHandedOffArrival(arrival);
        return;
      }

      // Let go inside: the hand opens and he falls from there. Clamped
      // horizontally, because the hand may have been over the edge of the
      // overlay even though the pet's middle was not.
      setMotion((current) => (current ? {
        ...current,
        carried: false,
        vy: 0,
        x: Math.max(0, Math.min(geometry?.maxX ?? current.x, current.x)),
        y: reduced ? 0 : current.y,
        squash: reduced,
      } : current));
    },
  });

  // While he is in the window the desktop one stands aside, and takes over
  // again the moment he is not — closed chat, unassigned, or carried out.
  useEffect(() => {
    suppressDesktopPet(Boolean(pet) && !handedOff && !outside);
    return () => suppressDesktopPet(false);
  }, [pet, handedOff, outside]);

  useEffect(() => () => {
    if (wanderRef.current !== undefined) window.clearTimeout(wanderRef.current);
    if (gestureRef.current !== undefined) window.clearTimeout(gestureRef.current);
  }, []);

  // Landing lasts a moment. Held in the motion rather than measured at render
  // time, because a component may re-render for any reason at all and "how long
  // ago did he land" is not something a render is allowed to ask.
  const landed = here?.squash ?? false;
  useEffect(() => {
    if (!landed) return undefined;
    const timer = window.setTimeout(
      () => setMotion((current) => (current ? { ...current, squash: false } : current)),
      SQUASH_MS,
    );
    return () => window.clearTimeout(timer);
  }, [landed]);

  /** Saved as it is changed, and shown immediately rather than after the round trip. */
  const changeStage = useCallback((petId: string, next: PetStage) => {
    setPendingStage({ petId, stage: next });
    void savePetStage(petId, next)
      // The desktop window polls every couple of seconds; this makes the slider
      // feel like it is attached to the pet rather than to a timer.
      .then(refreshDesktopPet)
      .catch(() => {
        // A setting that would not save is not worth an alert over a pet's
        // size; the next read puts the slider back where the server says it is.
      });
  }, []);

  /**
   * The desktop pet's panel, which is not about this conversation at all.
   *
   * Built before the guard below, because it has to open whether or not there
   * is a chat pet to draw — the pet who asked for it is on the desktop, and the
   * app may be showing an empty chat or the marketplace.
   */
  const desktopPanel = desktopPet ? (
    <PetDetailsPanel
      key={desktopPet.definition.id}
      pet={desktopPet}
      stage={pendingStage && pendingStage.petId === desktopPet.definition.id
        ? pendingStage.stage
        : readStage(desktopPet)}
      onChange={(next) => changeStage(desktopPet.definition.id, next)}
      onClose={() => setDesktopPet(null)}
      onHide={() => {
        setDesktopPet(null);
        // The persisted hide, the same one his X uses. He is not unassigned and
        // not deactivated: he is put away, and the marketplace brings him back.
        hideDesktopPet(true);
      }}
    />
  ) : null;

  if (!overlay || !pet || !geometry || !here || handedOff || outside) return desktopPanel;

  const height = Math.round(CARRIED_HEIGHT + (fullHeight - CARRIED_HEIGHT) * here.grow);
  const width = Math.round(height * widthPerHeight);


  /**
   * What he is playing, most specific first.
   *
   * Being carried, falling and walking are things happening to him now; a
   * gesture is a reaction he owes someone; the activity is the room's state;
   * idle is the absence of all of it.
   */
  const state: PetStateName = carrying || here.target !== null
    // Carried and walking are both "his legs are going". In the air they are
    // not: he is falling, and the sheet's jump is the only frame set that is
    // about not being on the ground.
    ? (here.facing === 'left' ? 'running-left' : 'running-right')
    : here.y < 0
      ? 'jumping'
      : here.gesture
        ?? (hovered ? 'waving'
          : activity === 'thinking' ? 'waiting'
            : activity === 'working' ? 'running'
              : activity === 'done' ? 'jumping'
                : 'idle');

  return (
    <>
      {/*
        The sprite animations are CSS keyframes, and they have to be in the
        document for any of them to run. They were rendered only by the
        marketplace page, so a pet drawn anywhere else held his first frame
        forever — which is exactly what "every animation state is one frame"
        was, and why hovering him appeared to do nothing at all. Into the head,
        because a rule is not part of this pet and must not depend on where he
        happens to be standing. A duplicate of the marketplace's copy is
        harmless: identical @keyframes of the same name.
      */}
      {createPortal(<style>{SPRITE_KEYFRAMES}</style>, document.head)}

      {createPortal(
        <div
          onPointerDown={onPointerDown}
          onClickCapture={onClickCapture}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onClick={() => gesture('jumping', REACTION_MS)}
          // No right-click on the pet, here or on the desktop: the pill is the
          // way in, and one way in is the point of having made it visible.
          onContextMenu={(event) => event.preventDefault()}
          style={{
            position: 'absolute',
            left: `${here.x}px`,
            // The feet stay on the floor as he grows, so the growth reads as
            // him getting bigger rather than as the floor moving.
            top: `${geometry.floorTop + here.y + (fullHeight - height)}px`,
            width: `${width}px`,
            height: `${height}px`,
            // Squashed on landing, from the feet. Cheap weight: one transform
            // for a tenth of a second is the difference between landing and
            // arriving.
            transform: here.squash ? 'scaleY(0.88) scaleX(1.06)' : 'none',
            transformOrigin: 'bottom center',
            transition: reduced ? 'none' : 'transform 120ms ease-out',
            // The overlay is inert so the transcript stays clickable through
            // it; he is the one thing in it that is not.
            pointerEvents: 'auto',
            cursor: carrying ? 'grabbing' : 'grab',
            touchAction: 'none',
            userSelect: 'none',
          }}
          title={`${pet.definition.displayName} — right-click for options, or carry him out of the window`}
        >
          <PetSprite
            pet={pet}
            size={height}
            state={state}
            /*
             * Mirrored only when the sheet has no row of its own for the
             * direction. A Codex sheet has both `running-left` and
             * `running-right`, and playing the left row *and* flipping it was
             * making him moonwalk — two negatives that cancel, so he faced the
             * way he came from. Same rule as the desktop page.
             */
            facing={pet.definition.states[state] ? 'right' : here.facing}
            /* Per state: moments are brisk, resting states breathe. */
            fps={fpsForState(pet.definition.frame.fps, state)}
          />
          <PetPill
            open={hovered && !carrying}
            width={width}
            onOpenDetails={() => setDetailsOpen(true)}
            onHide={() => {
              // Away for now, not unassigned. He belongs to this conversation
              // whether or not he is standing in it, so coming back brings him
              // back — the same rule as carrying him out to the desktop.
              if (arrival) setHandedOffArrival(arrival);
            }}
          />
        </div>,
        overlay,
      )}

      {desktopPanel}

      {detailsOpen ? (
        <PetDetailsPanel
          pet={pet}
          stage={stage}
          onChange={(next) => changeStage(pet.definition.id, next)}
          onClose={() => setDetailsOpen(false)}
          onSendToDesktop={() => {
            setDetailsOpen(false);
            takeOutside(pet.definition.id, true);
            if (arrival) setHandedOffArrival(arrival);
          }}
          onHide={() => {
            setDetailsOpen(false);
            if (arrival) setHandedOffArrival(arrival);
          }}
        />
      ) : null}
    </>
  );
}
