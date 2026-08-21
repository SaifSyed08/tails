import { useEffect, useState } from 'react';

import { useWebSocket } from '@/contexts/WebSocketContext';

/**
 * The pet saying something, in a bubble drawn like a sprite.
 *
 * ## Why the border is box-shadows and not a border
 *
 * The pet is pixel art at an integer scale. A 1px CSS border with a rounded
 * corner next to him is *smooth*, and next to hard-edged pixels a smooth edge
 * reads as a mistake — the two look like they came from different programs. So
 * the frame is built the way the sprite is: from blocks. Four offset shadows
 * make a stepped outline, and the notched corners are two more, which gives the
 * chamfer every 8-bit dialog box has without a single curve or a single image.
 *
 * The tail is the same trick, one block narrower than the one above it.
 *
 * ## Why it is one line and disappears
 *
 * A remark is a flourish. It is explicitly not allowed to carry anything the
 * user needs — see `pet-voice.tools.ts` — so it can afford to vanish, and
 * anything that vanishes must never be the only place something was said.
 */

/** How long a remark stays up. Long enough to read twice at a glance. */
const VISIBLE_MS = 6_500;

export type PetRemark = { id: string; text: string };

/** Stored with the conversation it belongs to. See the hook. */
type HeldRemark = PetRemark & { sessionId: string | null };

/**
 * Listens for the pet's remarks on the run stream.
 *
 * Kept beside the bubble rather than in the pet component because it is the
 * bubble's whole input, and because the pet has enough state of its own. Returns
 * the current remark or null, and forgets it after a while — the timer is here
 * rather than server-side because "how long a thing is readable" is a property
 * of the screen it is on.
 */
export function usePetRemark(sessionId: string | null): PetRemark | null {
  const { subscribe } = useWebSocket();
  const [held, setHeld] = useState<HeldRemark | null>(null);

  useEffect(() => subscribe((message) => {
    if (message.kind !== 'pet_remark' || !message.content) return;
    // Only for the conversation on screen. A remark about a chat the user left
    // would be a pet reacting to something they cannot see.
    if (sessionId && message.sessionId && message.sessionId !== sessionId) return;

    setHeld({ id: message.id, text: message.content, sessionId });
  }), [subscribe, sessionId]);

  useEffect(() => {
    if (!held) return undefined;
    const timer = window.setTimeout(() => setHeld(null), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [held]);

  /*
    Changing conversation drops it, and that is derived rather than cleared.

    The obvious version is an effect that nulls the state when `sessionId`
    changes, which is a synchronous setState in an effect body — a re-render for
    a value that was already knowable during the first one. Tagging the remark
    with the conversation it belongs to answers the same question by comparison,
    and the stale entry is collected by the timer that was already running.
  */
  if (!held || held.sessionId !== sessionId) return null;
  return held;
}

/**
 * The frame, as a stack of offset shadows.
 *
 * Written as a constant because it is unreadable inline and because the numbers
 * are related: `2px` is the pixel size the whole thing is built from, and the
 * corner notches are the same size stepped in by one. Changing the scale means
 * changing one number in four places, which is the argument for it being here
 * rather than in the class list.
 */
const PIXEL = 2;
const frame = (color: string, background: string) => [
  // The four sides.
  `${PIXEL}px 0 0 0 ${color}`,
  `-${PIXEL}px 0 0 0 ${color}`,
  `0 ${PIXEL}px 0 0 ${color}`,
  `0 -${PIXEL}px 0 0 ${color}`,
  // And the notch: a block of background over each corner, which is what turns
  // a rectangle into the chamfered box an 8-bit dialog has.
  `${PIXEL}px ${PIXEL}px 0 0 ${background}`,
  `-${PIXEL}px ${PIXEL}px 0 0 ${background}`,
  `${PIXEL}px -${PIXEL}px 0 0 ${background}`,
  `-${PIXEL}px -${PIXEL}px 0 0 ${background}`,
].join(', ');

type Props = {
  text: string;
  /** Width of the pet, so the bubble can be centred over him. */
  petWidth: number;
};

export function PetSpeechBubble({ text, petWidth }: Props) {
  return (
    <div
      /*
        Anchored to the pet's top edge and centred on him, growing upward. The
        pet's own box does not change size when this appears — a bubble that
        pushed the sprite down would look like the pet flinching every time it
        spoke.
      */
      className="pet-bubble pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5"
      style={{
        // Wide enough for a sentence, never wider than about three pets, so it
        // stays something the animal is saying rather than a panel beside him.
        minWidth: Math.min(petWidth * 1.6, 150),
        maxWidth: Math.max(petWidth * 3, 210),
      }}
    >
      <div
        className="px-2 py-1 text-center text-[10px] leading-[1.5] tracking-tight text-foreground"
        style={{
          background: 'var(--background)',
          boxShadow: frame('var(--foreground)', 'var(--background)'),
          // A pixel typeface if the machine has one, and a fallback chain that
          // stays monospaced rather than dropping to the body font — the
          // rhythm is most of what makes it read as 8-bit.
          fontFamily: '"Press Start 2P", "Silkscreen", ui-monospace, "Cascadia Mono", Consolas, monospace',
          // Never smoothed, to match the sprite beside it.
          imageRendering: 'pixelated',
        }}
      >
        {text}
      </div>

      {/*
        The tail: two stacked blocks, each narrower than the last, with the same
        stepped outline. Drawn as elements rather than a rotated square because
        a rotated square has anti-aliased diagonals, which is the one thing this
        whole component exists to avoid.
      */}
      <div className="flex flex-col items-center">
        <span
          style={{
            width: PIXEL * 4,
            height: PIXEL,
            background: 'var(--background)',
            boxShadow: `${PIXEL}px 0 0 0 var(--foreground), -${PIXEL}px 0 0 0 var(--foreground)`,
          }}
        />
        <span
          style={{
            width: PIXEL * 2,
            height: PIXEL,
            background: 'var(--foreground)',
          }}
        />
      </div>
    </div>
  );
}
