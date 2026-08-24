import { useEffect, useMemo, useState } from 'react';

import { buildThinkingRotation, SPINNER_VERBS } from '@/components/chat/thinkingPhrases';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';

/** How long each word stays up. Long enough to read, short enough to notice. */
const WORD_INTERVAL_MS = 2600;

/**
 * The sweep that runs across the text.
 *
 * A gradient behind `background-clip: text`, so the highlight travels through
 * the letters rather than behind them. Both ends of the gradient are the
 * ordinary muted ink, which is why the word never looks like it changed
 * colour — only like light passed over it. Tokens throughout, so a re-theme
 * carries the effect with it.
 */
const SHIMMER_STYLE = {
  backgroundImage: [
    'linear-gradient(90deg,',
    'hsl(var(--muted-foreground)) 40%,',
    'hsl(var(--foreground)) 50%,',
    'hsl(var(--muted-foreground)) 60%)',
  ].join(' '),
  // Two tiles per cycle. The shimmer keyframe travels 400%, so only a tile
  // that divides that evenly wraps without the pattern jumping.
  backgroundSize: '200% 100%',
};

type ThinkingIndicatorProps = {
  /** Optional detail from a status event, e.g. "Compacting context". */
  detail?: string | null;
  /**
   * Lines contributed by the conversation's pet, mixed into the rotation.
   *
   * Never the whole rotation: the ordinary words are what keep this reading as
   * "work is happening" rather than as an idle animation.
   */
  petPhrases?: readonly string[];
  /**
   * Whether the reply is currently arriving on screen.
   *
   * The indicator used to be unmounted entirely while tokens streamed, on the
   * reasoning that the streaming row has its own caret and two things saying
   * "working" is one too many. That reasoning holds for the *word* and not for
   * the rest: a turn is a text block, then tools, then more text, and hiding
   * the whole indicator through the first block meant the one durable "this is
   * still running, and for how long" disappeared and came back repeatedly
   * through a single turn.
   *
   * So it stays for the whole turn, and goes quiet while the caret is talking:
   * no rotating word, no pulse, just the elapsed time.
   */
  streaming?: boolean;
};

/**
 * The "it is working" affordance.
 *
 * Shows elapsed seconds alongside the word, because the single most useful
 * thing during a long tool run is knowing how long it has actually been —
 * that is the difference between patience and reaching for the stop button.
 */
export function ThinkingIndicator({ detail, petPhrases, streaming = false }: ThinkingIndicatorProps) {
  const reduced = useReducedMotion();
  /**
   * The two words on screen, and which of them is showing.
   *
   * Two permanent spans that swap opacity, rather than one span remounted per
   * word: a remount restarts the entrance animation from zero, which is what
   * made the indicator blank for a frame on every change. Cross-fading two
   * live nodes means something is always fully legible.
   */
  /**
   * The words this indicator walks, pet lines included.
   *
   * Built once per pet rather than per tick, and the ellipsis is baked in
   * here: an ordinary word needs one, a hand-written pet line is already
   * punctuated the way its author wanted.
   */
  const rotation = useMemo(() => buildThinkingRotation(petPhrases), [petPhrases]);
  const [slots, setSlots] = useState<[string, string]>(
    () => [`${SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]}…`, ''],
  );
  const [active, setActive] = useState<0 | 1>(0);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const tick = window.setInterval(() => setSeconds((current) => current + 1), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    // Not while the caret is talking: the words are not on screen then, and
    // rotating them anyway is a re-render of the transcript every few seconds
    // to change something nobody can see.
    if (reduced || streaming) return undefined;

    const rotate = window.setInterval(() => {
      setActive((current) => {
        const next = current === 0 ? 1 : 0;
        setSlots((words) => {
          // A rotation that changed underneath us (a pet was just assigned)
          // reports -1 and simply starts again from the top.
          const showing = rotation.indexOf(words[current]);
          const upcoming = rotation[(showing + 1 + rotation.length) % rotation.length];
          const swapped: [string, string] = [...words] as [string, string];
          // Written into the hidden slot, so the text changes while that node
          // is still invisible and only then fades up.
          swapped[next] = upcoming;
          return swapped;
        });
        return next;
      });
    }, WORD_INTERVAL_MS);

    return () => window.clearInterval(rotate);
  }, [reduced, rotation, streaming]);

  const shimmerClass = !reduced && 'animate-shimmer bg-clip-text text-transparent';

  /*
    The quiet form, while the reply is being typed out.

    The elapsed time only — which is the number worth having on screen for the
    whole turn, because it is the difference between waiting and reaching for
    the stop button, and it was previously only visible during the silences.
  */
  if (streaming) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-hidden="true">
        <span className="size-1.5 rounded-full bg-primary/60" />
        <span className="tabular-nums opacity-60">{seconds}s</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
      <span className="relative flex size-2">
        {!reduced ? (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
        ) : null}
        <span className="relative inline-flex size-2 rounded-full bg-primary" />
      </span>

      {/*
        A real status from the run, shown verbatim and alone. The pet does not
        get a turn here: this is the branch that can carry information, so
        nothing may talk over it.
      */}
      {detail ? (
        <span className={cn(shimmerClass)} style={reduced ? undefined : SHIMMER_STYLE}>
          {detail}
        </span>
      ) : (
        // One grid cell holding both words: the cross-fade costs no layout,
        // and the row cannot reflow halfway through a swap.
        <span className="grid">
          {slots.map((word, index) => (
            <span
              key={index}
              aria-hidden={index === active ? undefined : true}
              className={cn(
                'col-start-1 row-start-1 transition-opacity duration-settle ease-standard',
                index === active ? 'opacity-100' : 'opacity-0',
                shimmerClass,
              )}
              style={reduced ? undefined : SHIMMER_STYLE}
            >
              {word}
            </span>
          ))}
        </span>
      )}

      {seconds >= 3 ? (
        <span className="tabular-nums text-xs opacity-60">{seconds}s</span>
      ) : null}
    </div>
  );
}
