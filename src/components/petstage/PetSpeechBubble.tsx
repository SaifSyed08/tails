import { useEffect, useState } from 'react';

import { useWebSocket } from '@/contexts/WebSocketContext';
import { useReducedMotion } from '@/shared/ui/Motion';

/**
 * The pet saying something.
 *
 * ## A speech balloon, not a UI panel
 *
 * The first version built the outline from eight offset box-shadows so the
 * border was made of blocks like the sprite is — notched corners, no curves,
 * very faithful to the pixel art. It was too much: a heavy stepped frame in the
 * theme's foreground colour over a themed background reads as a piece of the
 * interface rather than as something the animal said.
 *
 * So it is white, barely see-through, with one hairline of an edge. White rather
 * than a theme token on purpose: speech should look the same over a dark theme
 * and a light one, the way a comic balloon does, and a bubble that follows the
 * theme stops reading as a separate voice. The pixel discipline is kept where it
 * still earns its place — square corners, no blur, no shadow, and a tail made of
 * stacked blocks rather than a rotated square, because a rotated square has
 * anti-aliased diagonals.
 *
 * ## Two things it says, and both can vanish
 *
 * A reaction to a turn, and — every couple of minutes with a chat open — an idle
 * mutter to itself. Neither is allowed to carry anything the user needs, which
 * is what lets both disappear after a few seconds without costing anything.
 */

/** How long a remark stays up. Long enough to read twice at a glance. */
const VISIBLE_MS = 6_500;

/**
 * Older than this and it is history, not a remark.
 *
 * Generous, because a slow turn can put a few seconds between the tool call and
 * the client seeing it, and the failure this guards is a replayed remark from a
 * previous session — which is minutes or hours old, not seconds.
 */
const STALE_MS = 30_000;

export type PetRemark = { id: string; text: string };

/** Stored with the conversation it belongs to. See the hook. */
type HeldRemark = PetRemark & { sessionId: string | null };

/**
 * How long between idle mutterings.
 *
 * Two minutes, which is what was asked for and is about the longest gap that
 * still reads as company rather than as a glitch. It is a floor, not a metronome:
 * the timer restarts whenever he says anything, so a reaction to a turn also
 * pushes the next idle line out — otherwise a busy stretch would have him
 * commenting and then muttering ten seconds later.
 */
const IDLE_EVERY_MS = 120_000;

/**
 * Listens for the pet's remarks on the run stream.
 *
 * Kept beside the bubble rather than in the pet component because it is the
 * bubble's whole input, and because the pet has enough state of its own. Returns
 * the current remark or null, and forgets it after a while — the timer is here
 * rather than server-side because "how long a thing is readable" is a property
 * of the screen it is on.
 */
export function usePetRemark(
  sessionId: string | null,
  /**
   * His idle lines, for the muttering between turns.
   *
   * Passed in rather than fetched here: the pet component already has the whole
   * pet, and a second fetch for one field would be a second thing to keep in
   * step with it.
   */
  idleLines: string[] = [],
): PetRemark | null {
  const { subscribe } = useWebSocket();
  const [held, setHeld] = useState<HeldRemark | null>(null);
  /** Bumped whenever the idle timer fires, so the effect below can restart. */
  const [idleTick, setIdleTick] = useState(0);

  useEffect(() => subscribe((message) => {
    if (message.kind !== 'pet_remark' || !message.content) return;
    // Only for the conversation on screen. A remark about a chat the user left
    // would be a pet reacting to something they cannot see.
    if (sessionId && message.sessionId && message.sessionId !== sessionId) return;

    /*
      And only if it just happened.

      Remarks travel as a message kind, which means they land in the run's replay
      buffer along with everything else — so re-opening a conversation replayed
      the last one and the pet said something about a turn from an hour ago.
      Caught by the timing in a live test: the bubble appeared 1.5 seconds after
      a message that had not been answered yet.

      A remark is a live flourish and nothing else; a stale one is not worth
      showing, so it is dropped rather than queued. Everything else in the replay
      is transcript, which is exactly why the general rule cannot be "skip the
      replay" and this has to be the remark's own rule.
    */
    const at = Date.parse(message.timestamp ?? '');
    if (Number.isFinite(at) && Date.now() - at > STALE_MS) return;

    setHeld({ id: message.id, text: message.content, sessionId });
  }), [subscribe, sessionId]);

  useEffect(() => {
    if (!held) return undefined;
    const timer = window.setTimeout(() => setHeld(null), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [held]);

  /*
    Muttering to himself between turns.

    Three conditions, and each rules out a way this becomes annoying rather than
    companionable:

    - **A conversation is open.** He is commenting on your work; there is nothing
      to keep company with on the marketplace.
    - **The window is visible.** A pet talking to an empty desk is spending
      nothing usefully, and the browser suspends the timer anyway — this makes
      that explicit rather than accidental, and re-arms on the way back.
    - **He is not already talking.** Restarted whenever anything is said, so a
      reaction to a turn pushes the next mutter out by the full interval.

    `idleTick` is what lets the interval restart cleanly: firing bumps it, the
    effect tears down and sets a fresh timer. A `setInterval` would keep its own
    schedule regardless of what else he said.
  */
  useEffect(() => {
    if (!sessionId || idleLines.length === 0 || held) return undefined;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      // Re-armed by the listener below when the window comes back.
      return undefined;
    }

    const timer = window.setTimeout(() => {
      const line = idleLines[Math.floor(Math.random() * idleLines.length)];
      if (line) setHeld({ id: `idle-${Date.now()}`, text: line, sessionId });
      setIdleTick((tick) => tick + 1);
    }, IDLE_EVERY_MS);

    return () => window.clearTimeout(timer);
  }, [sessionId, idleLines, held, idleTick]);

  // The window becoming visible again re-arms the timer above, which the guard
  // inside it declined to set while nobody was looking.
  useEffect(() => {
    const wake = () => setIdleTick((tick) => tick + 1);
    document.addEventListener('visibilitychange', wake);
    return () => document.removeEventListener('visibilitychange', wake);
  }, []);

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
 * The frame.
 *
 * ## Why this stopped being a stack of box-shadows
 *
 * The first version built the outline out of eight offset shadows, so the border
 * was made of blocks like the sprite is, with notched corners and no curves. It
 * was faithful and it was too much: a heavy stepped frame in the theme's
 * foreground colour, sitting over a themed background, read as a UI panel rather
 * than as something the animal said.
 *
 * What was actually wanted is a speech bubble — white, barely see-through, one
 * hairline of an edge. So the frame is now a real border, one pixel, and the
 * pixel-art discipline is kept where it still earns its place: square corners,
 * no blur, no shadow, and a tail made of stacked blocks rather than a rotated
 * square, because a rotated square has anti-aliased diagonals.
 *
 * White rather than a token, deliberately. It is speech, not chrome — it should
 * look the same over a dark theme and a light one, the way a comic balloon does,
 * and a bubble that follows the theme stops reading as a separate voice.
 */
const PIXEL = 2;

type Props = {
  text: string;
  /** Width of the pet, so the bubble can be centred over him. */
  petWidth: number;
};

/** Milliseconds per character. Fast enough to finish a short line in a beat. */
const TYPE_MS = 28;

/**
 * Reveals a string one character at a time.
 *
 * A timer per character rather than a CSS animation, because the width has to
 * grow with the text and CSS cannot animate to a length it does not know. It
 * also means the caret and the bubble stay in step for free: they are the same
 * element growing.
 *
 * Restarts whenever the text changes, which is what makes a new remark type
 * itself rather than appearing whole because the element was reused.
 */
function useTyped(text: string): string {
  const reduced = useReducedMotion();

  /*
    How much of the current line has been revealed.

    Held with the text it belongs to, and reset during *render* when the text
    changes rather than in an effect. An effect that calls setState in its body
    is a second render for a value that was already knowable in the first, and it
    is the thing this codebase's lint rule exists to prevent. The pattern is used
    elsewhere here for the same reason.
  */
  const [typed, setTyped] = useState(() => ({ text, count: reduced ? text.length : 1 }));

  if (typed.text !== text) setTyped({ text, count: reduced ? text.length : 1 });

  useEffect(() => {
    if (reduced) return undefined;

    // Every setState below is inside a callback, so none of them run during the
    // effect body.
    const timer = window.setInterval(() => {
      setTyped((current) => {
        if (current.text !== text) return current;
        if (current.count >= text.length) {
          window.clearInterval(timer);
          return current;
        }
        return { text, count: current.count + 1 };
      });
    }, TYPE_MS);

    return () => window.clearInterval(timer);
  }, [text, reduced]);

  // Sliced from the live text, so the very first render after a change shows the
  // new line's first character rather than the old line's.
  return text.slice(0, typed.text === text ? typed.count : (reduced ? text.length : 1));
}

export function PetSpeechBubble({ text, petWidth }: Props) {
  const shown = useTyped(text);

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
        /*
          As wide as the words and no wider.

          It used to have a minimum width scaled off the sprite, which meant a
          two-word line sat in the middle of a box built for a sentence. There is
          no reason for the bubble to know how big the animal is — only how long
          the line is — so the width is the text's, and the only limit is a
          ceiling so a long one wraps instead of crossing the chat.
        */
        width: 'max-content',
        maxWidth: Math.max(petWidth * 3, 210),
      }}
    >
      <div
        className="px-2 py-1 text-center text-[10px] leading-[1.4] tracking-tight"
        style={{
          // Almost opaque: enough to read black text on, enough that what is
          // behind it is still faintly there.
          background: 'rgba(255, 255, 255, 0.92)',
          border: '1px solid rgba(0, 0, 0, 0.28)',
          // A touch of rounding. Square corners were more faithful to the
          // sprite and read as a dialog box; this is enough to say "balloon"
          // without becoming a tooltip.
          borderRadius: 5,
          // Ink, not the theme's foreground. See the note above — the bubble is
          // a voice, and it looks the same whatever the app is wearing.
          color: '#111',
          fontFamily: '"Press Start 2P", "Silkscreen", ui-monospace, "Cascadia Mono", Consolas, monospace',
          imageRendering: 'pixelated',
        }}
      >
        {shown}
        {/*
          A caret while it is still typing, so a half-finished line reads as
          being said rather than as having been cut off. Gone the moment the
          text is complete — a blinking cursor on a settled bubble is a text
          field, not speech.
        */}
        {shown.length < text.length ? (
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: '0.5em',
              marginLeft: 1,
              background: '#111',
              // A hair under the line, so it sits on the baseline rather than
              // spanning the whole line box.
              height: '0.85em',
              verticalAlign: '-0.1em',
            }}
          />
        ) : null}
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
            background: 'rgba(255, 255, 255, 0.92)',
            // Sides only. A border along the top would draw a line across the
            // underside of the bubble it is hanging from.
            borderLeft: '1px solid rgba(0, 0, 0, 0.28)',
            borderRight: '1px solid rgba(0, 0, 0, 0.28)',
          }}
        />
        <span
          style={{
            width: PIXEL * 2,
            height: PIXEL,
            background: 'rgba(255, 255, 255, 0.92)',
            border: '1px solid rgba(0, 0, 0, 0.28)',
            borderTop: 'none',
          }}
        />
      </div>
    </div>
  );
}
