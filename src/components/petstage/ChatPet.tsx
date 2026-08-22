import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  claimDesktop,
  claimsDesktop,
  hideDesktopPet,
  onDesktopPetDock,
  PetSprite,
  readPetDragFrame,
  refreshDesktopPet,
  releaseDesktopClaim,
  resolveCellBox,
  setDesktopPetDockable,
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
  assignPetToSession,
  clearActivePet,
  readDisplayPet,
  savePetVoice,
  readSessionPet,
  readStage,
  savePetStage,
  type PetStage,
  type PetVoice,
} from './chat-pet-api';
import { onDesktopPetDetails, placeDesktopPetAt } from './desktop-handoff';
import { PetDetailsPanel } from './PetDetailsPanel';
import { PetPill } from './PetPill';
import { PetSpeechBubble, usePetRemark } from './PetSpeechBubble';
import { advanceMotion, type Bounds, type Motion } from './pet-motion';
import { collisionSoundEnabled, playCollision } from './pet-sfx';
import { fpsForState } from './sprite-rate';
import { useChatActivity } from './useChatActivity';
import { useDesktopPetAlerts } from './useDesktopPetAlerts';
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

/**
 * His designed standing height in the chat, in CSS pixels, before the user's
 * own size.
 *
 * Raised from 72 to close the gap with the desktop pet, who stands at 128: the
 * same animal was noticeably smaller indoors, and the jump between the two
 * surfaces was the thing that read as wrong rather than either size on its own.
 * The desktop pet is deliberately unchanged.
 */
const PET_HEIGHT = 96;

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

/** The fastest a throw can leave the hand, in px/s. */
const MAX_THROW = 2400;

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
  /** Who the desktop window would show right now, or null for nobody. */
  const [activePetId, setActivePetId] = useState<string | null>(null);
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

  /**
   * The room, for the frame loop.
   *
   * A ref because the loop is started once and must not be restarted when the
   * window resizes — the last time this was a dependency, the rAF cancelled
   * itself on every layout pass and he stopped walking mid-stride.
   */
  const roomRef = useRef<Bounds>({ maxX: Number.POSITIVE_INFINITY, ceiling: Number.NEGATIVE_INFINITY });

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

  /**
   * The last pet this surface had standing in a conversation.
   *
   * Remembered past the conversation ending, because that is exactly when it
   * matters: opening a different chat used to release the desktop window, and
   * the pet you had just been looking at would reappear floating over
   * everything. He has a home, and it is not the desktop.
   */
  const lastInChatPetRef = useRef<string | null>(null);

  /*
   * The escape hatch from the rule above lives in `desktop-claim.ts`.
   *
   * It used to be a `useRef` here, which meant it was forgotten on the very
   * navigation the rule is about — see that file for the measured sequence.
   */

  /**
   * Who was on the desktop before a pick-up borrowed the slot.
   *
   * Picking him up activates him so the desktop window has him loaded and sized
   * before the hand reaches the edge. A hand that never gets there has decided
   * nothing, so the borrow is given back. `undefined` means nothing is
   * outstanding; `null` means the slot was empty and should be again.
   */
  const restoreActiveRef = useRef<string | null | undefined>(undefined);

  /** The last point he was carried to outside the chat, in page coordinates. */
  const lastOutsideRef = useRef<{ x: number; y: number } | null>(null);

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

  /*
   * The desktop pet's notifications.
   *
   * Hosted here because this component is the app's one always-mounted piece of
   * pet — it is rendered whatever view is on screen, with a null session when
   * that view is not a chat, which is exactly the situation the notification is
   * for. See the hook for why the decision is split between here and the shell.
   */
  useDesktopPetAlerts({ sessionId, activePetId });

  /*
    What the pet last said, if anything.

    Subscribed here rather than beside the bubble's own render, because this
    component returns early in several places — a hook below one of those
    returns is a hook that runs on some renders and not others.
  */
  const remark = usePetRemark(sessionId, pet?.lines?.idle ?? []);

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
    // Both at once: who lives in this chat, and who is on the desktop. The
    // second is needed to keep a conversation's pet from leaking onto the
    // desktop when you simply open another conversation — see the suppression
    // effect below.
    Promise.all([readSessionPet(sessionId), readDisplayPet().catch(() => null)])
      .then(([resolved, display]) => {
        if (cancelled) return;
        // Only a pet assigned to *this* conversation lives here. The globally
        // active pet lives on the desktop and is not a guest in every chat.
        setAssignment({ sessionId, pet: resolved.source === 'session' ? resolved.pet : null });
        setActivePetId(display?.pet?.definition.id ?? null);
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

  // The walls he can be thrown against, put where the frame loop can read them
  // without being restarted by a resize.
  useEffect(() => {
    roomRef.current = geometry
      ? { maxX: geometry.maxX, ceiling: -geometry.floorTop }
      : { maxX: Number.POSITIVE_INFINITY, ceiling: Number.NEGATIVE_INFINITY };
  }, [geometry]);

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
      vx: 0,
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

      setMotion((current) => (current ? advanceMotion(current, elapsed, roomRef.current) : current));

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
   *
   * ## Why this un-hides rather than un-suppresses
   *
   * Carrying a pet past the edge of the chat is the most explicit "put him on
   * the desktop" there is — more explicit than the marketplace switch, because
   * the user is holding him at the time. It therefore has to clear *every*
   * reason he might not appear, and the pill's X is one of them.
   *
   * Releasing the suppression alone was not enough, and the failure was silent:
   * `hidden` is a separate flag with its own veto, so after the X had been
   * pressed a pet carried out of a chat was placed, activated and carried on a
   * window that was never shown. The hand opened over the desktop and nothing
   * was there — and the way back was the marketplace, which is not something
   * anyone would think to look for while dragging an animal.
   *
   * `hide(false)` is the whole job rather than half of it: see `setPetHidden`
   * in the shell, which clears the suppression and puts an unreachable window
   * back on a display as part of un-hiding. That is exactly what handing him
   * out means here.
   */
  const takeOutside = useCallback((petId: string, show: boolean) => {
    if (activatedRef.current !== petId) {
      activatedRef.current = petId;
      void activatePet(petId).then(refreshDesktopPet).catch(() => {
        // He will still be carried on the desktop layer; he just may be the pet
        // the window already had. Nothing here is worth interrupting a drag.
      });
    }
    if (!show) return;
    hideDesktopPet(false);
    // And it is a decision about where he lives, not just about this gesture.
    // See `desktop-claim.ts`: without a record of it, the rule that keeps a
    // conversation's pet off the desktop applies to him too, and swallows him
    // the next time his own chat is opened.
    claimDesktop(petId);
  }, []);

  /**
   * Gives back everything a pick-up borrowed.
   *
   * Called when the gesture ends anywhere inside the chat, including when it is
   * interrupted. Three things to undo, and all three have bitten: the active
   * pet (so a pet who never left does not silently become the desktop's), the
   * shell's carry (which has no natural end when the app is driving it, and
   * leaves the window unclickable while it is believed to be running), and the
   * record of where he was outside.
   */
  const endBorrowedDesktop = useCallback(() => {
    const held = lastOutsideRef.current;
    lastOutsideRef.current = null;
    if (held) placeDesktopPetAt(held.x, held.y, false);

    const restore = restoreActiveRef.current;
    restoreActiveRef.current = undefined;
    const carried = activatedRef.current;
    activatedRef.current = null;
    if (restore === undefined || !carried || restore === carried) return;

    void (restore === null ? clearActivePet(carried) : activatePet(restore))
      .then(refreshDesktopPet)
      .catch(() => {
        // Worst case the pet he was just holding stays the active one, which is
        // a defensible answer to an ambiguous gesture and not worth a dialog.
      });
  }, []);

  const { carrying, onPointerDown, onClickCapture } = useInChatCarry({
    onPress: () => {
      // Pressed, not yet dragged. Whatever was moving him stops now: he used to
      // carry on strolling for the few frames before the drag threshold and
      // then snap to the hand, which is the "teleports elsewhere for a frame".
      setMotion((current) => (current ? {
        ...current,
        target: null,
        vx: 0,
        // Grabbed mid-arrival, he is simply here now. The alternative is a
        // sprite whose size and position are still being interpolated while a
        // hand is holding it, which is a frame of him somewhere he is not.
        grow: 1,
      } : current));
    },
    onStart: () => {
      // Whoever was on the desktop is remembered, so a pick-up that comes to
      // nothing does not quietly change who lives there.
      restoreActiveRef.current = activePetId;
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
        // Moved before it is shown, so the window never appears for a frame at
        // wherever it was left last time and then jumps to the hand.
        if (isOutside) {
          placeDesktopPetAt(pointer.x, pointer.y, true);
          takeOutside(pet.definition.id, true);
        } else {
          suppressDesktopPet(true);
        }
      }

      if (isOutside) {
        // He is the desktop window now, and it follows the pointer directly.
        // No grab offset and no read-back: every position comes from the hand,
        // so nothing can accumulate — which is what six rounds of drift were.
        placeDesktopPetAt(pointer.x, pointer.y, true);
        lastOutsideRef.current = pointer;
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
      // `endBorrowedDesktop` clears the record of who was activated, so it must
      // read it first — clearing it here would make the restore a no-op.
      endBorrowedDesktop();
      setMotion((current) => (current ? { ...current, carried: false, vy: 0 } : current));
    },
    onRelease: ({ clientX, clientY, velocity }) => {
      const wasOutside = outsideRef.current;
      outsideRef.current = false;
      setOutside(false);

      if (wasOutside) {
        // Left on the desktop, and that is a decision: the assignment is
        // untouched — he still belongs to this conversation and coming back
        // brings him in — but until then the desktop is where he lives, and the
        // rule that keeps a chat's pet off the desktop has to know that.
        placeDesktopPetAt(clientX, clientY);
        if (pet) claimDesktop(pet.definition.id);
        restoreActiveRef.current = undefined;
        activatedRef.current = null;
        lastOutsideRef.current = null;
        if (arrival) setHandedOffArrival(arrival);
        return;
      }

      // Let go inside, so nothing was decided: the desktop slot goes back to
      // whoever had it, and any carry the shell still thinks it is running is
      // ended where it actually left him rather than left to time out.
      endBorrowedDesktop();

      /*
       * Let go inside: he keeps the hand's speed and gravity does the rest.
       *
       * A throw and a handoff are the same gesture ending in two different
       * places, and they are told apart by *where the hand was*, not by how
       * fast it was going: crossing the chat's edge while still holding him is
       * a handoff — it already happened, above, in `onMove` — and opening the
       * hand inside is a throw, however hard. So he cannot be flung out of the
       * window; thrown at the sidebar he hits the wall and bounces.
       */
      setMotion((current) => (current ? {
        ...current,
        carried: false,
        target: null,
        x: Math.max(0, Math.min(geometry?.maxX ?? current.x, current.x)),
        y: reduced ? 0 : current.y,
        // Capped: a flick of the wrist can measure thousands of pixels a
        // second, and past a point the arc is a teleport with extra steps.
        vx: reduced ? 0 : Math.max(-MAX_THROW, Math.min(MAX_THROW, velocity.x)),
        vy: reduced ? 0 : Math.max(-MAX_THROW, Math.min(MAX_THROW, velocity.y)),
        squash: reduced,
      } : current));
    },
  });

  // Declared before the suppression effect below, which reads it: effects run
  // in order, so this is what makes "the pet we were just showing" true by the
  // time the question is asked.
  useEffect(() => {
    if (!pet || handedOff) return;
    lastInChatPetRef.current = pet.definition.id;
    // And he is not living on the desktop any more, because he is standing
    // here. Without this the claim only ever grows, and a rule that applies to
    // nobody is the same as no rule.
    releaseDesktopClaim(pet.definition.id);
  }, [pet, handedOff]);

  /**
   * When the desktop window may have him, and when it may not.
   *
   * Two clauses, and the second is the whole of this fix:
   *
   * - While he is standing in this chat, the desktop stands aside.
   * - And it goes on standing aside for a pet who *lives* in a conversation,
   *   even after you have navigated away from it. Opening a different chat
   *   unmounts him here, and the desktop window would otherwise take that as
   *   its cue and show him floating over everything — a pet nobody asked for,
   *   arriving as a side effect of a click.
   *
   * The way onto the desktop is to carry him there, which records the choice.
   * Activating somebody else releases this too, because then he is no longer
   * the pet the window would show.
   */
  /*
    Whether the pill should offer to send him back in here.

    Three things at once, and the shell can answer none of them: this
    conversation has a pet, that pet is the one the desktop window is showing,
    and he is not already standing in the chat. The last is what stops the arrow
    appearing beside a pet who is visibly already where it would send him.
  */
  useEffect(() => {
    /*
      Three conditions, and the third is not the durable claim — which is what I
      reached for first and had to take back out.

      The claim is released the moment the pet is drawn in this conversation, by
      design: "coming back to that chat brings him in" is the existing rule. So
      in every state where the claim is still set, he is already standing here and
      the arrow would be offering to send him where he is. `handedOff` and
      `outside` are the states that actually mean "not in this chat", and they are
      exactly the two the carry-out produces.
    */
    setDesktopPetDockable(
      Boolean(pet) && activePetId === pet?.definition.id && (handedOff || outside),
    );
  }, [pet, activePetId, handedOff, outside]);

  /*
    And the press itself: he walks back in.

    Two things to undo, which are the two things carrying him out did. The claim
    is what keeps a chat's pet on the desktop after you navigate away, and the
    handoff is what stops this conversation drawing him — clearing one without
    the other leaves him either invisible or straight back outside.
  */
  useEffect(() => {
    onDesktopPetDock((petId) => {
      releaseDesktopClaim(petId);
      setHandedOffArrival(null);
    });
  }, []);

  useEffect(() => {
    const homedInAChat = activePetId !== null
      && activePetId === lastInChatPetRef.current
      && !claimsDesktop(activePetId);

    suppressDesktopPet((Boolean(pet) && !handedOff && !outside) || homedInAChat);
  }, [pet, handedOff, outside, activePetId]);

  /*
   * Released only when this surface goes away entirely.
   *
   * Not on every change of the effect above: its cleanup used to run first and
   * un-suppress for the instant before the new value was applied, which on a
   * conversation change meant showing and hiding a real window in the same
   * tick. The value is recomputed whenever anything it depends on moves, so
   * there is nothing for a per-run cleanup to do.
   */
  useEffect(() => () => suppressDesktopPet(false), []);

  useEffect(() => () => {
    if (wanderRef.current !== undefined) window.clearTimeout(wanderRef.current);
    if (gestureRef.current !== undefined) window.clearTimeout(gestureRef.current);
  }, []);

  /*
    The wall, if he just found one.

    `bumped` carries the speed of contact for exactly one frame, so this reads
    it and does not have to remember anything. Read through a ref rather than an
    effect dependency because the motion object changes every animation frame:
    a dependency would run this sixty times a second to do nothing fifty-nine
    of them.
  */
  const bumped = here?.bumped ?? 0;
  const bumpedRef = useRef(0);
  useEffect(() => {
    const previous = bumpedRef.current;
    bumpedRef.current = bumped;
    // Rising edge only. A pet resting against a wall reports contact on frame
    // after frame, and playing a thud for each is a drum roll.
    if (bumped > 0 && previous === 0 && collisionSoundEnabled()) {
      // Normalised against a hard throw, which is what MAX_THROW is.
      playCollision(bumped / MAX_THROW);
    }
  }, [bumped]);

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

  /**
   * His voice, saved as it is picked.
   *
   * No optimistic copy, unlike the stage settings: the change is a select and
   * two sliders whose value is read back from the pet, and the reload the save
   * triggers arrives in a few milliseconds. `null` clears the choice rather
   * than silencing him — see `savePetVoice`.
   */
  const changeVoice = useCallback((petId: string, next: PetVoice | null) => {
    void savePetVoice(petId, next)
      .then(() => setReloadToken((current) => current + 1))
      .then(refreshDesktopPet)
      .catch(() => {
        // The pet keeps the voice he had. Nothing about a voice is worth a
        // dialog over a chat.
      });
  }, []);

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
      onChangeVoice={(next) => changeVoice(desktopPet.definition.id, next)}
      onClose={() => setDesktopPet(null)}
      /*
       * Only when there is a conversation open to send him to, and only when he
       * is not already its pet — an action that does nothing is worse than an
       * action that is missing, because you have to try it to find out.
       */
      onSendToChat={sessionId && desktopPet.definition.id !== pet?.definition.id
        ? () => {
          const target = sessionId;
          const petId = desktopPet.definition.id;
          setDesktopPet(null);
          setHandedOffArrival(null);
          void assignPetToSession(target, petId)
            .then(() => setReloadToken((current) => current + 1))
            .catch(() => {});
        }
        : undefined}
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
          {/*
            Inside the pet's own box, so it travels with him: he is thrown,
            dragged and walks around, and a bubble positioned against the chat
            would have to chase him. `bottom-full` puts it above his head
            without changing his size — see the component.
          */}
          {remark ? (
            <PetSpeechBubble
              text={remark.text}
              petWidth={width}
              petLeft={here.x}
              petTop={geometry.floorTop + here.y + (fullHeight - height)}
              /*
                The stage, not the pet. `maxX` is how far left the pet's own left
                edge may go, so the stage is that plus the pet — which is the
                width the bubble must fit inside, because the layer clips.
              */
              bounds={{ width: geometry.maxX + width, height: geometry.floorTop + fullHeight }}
            />
          ) : null}

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
          onChangeVoice={(next) => changeVoice(pet.definition.id, next)}
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
