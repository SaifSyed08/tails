import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';

/**
 * How long the full sequence runs before handing off.
 *
 * Short enough that it never feels like a gate on a fast machine, long enough
 * that the wordmark and the caption both land. The app is loading underneath
 * the whole time, so this is largely spent on work that had to happen anyway.
 */
const SEQUENCE_MS = 2200;

/** The point at which the caption appears, after the wordmark has settled. */
const CAPTION_AT_MS = 900;

type IntroProps = {
  onDone: () => void;
};

/**
 * The T.A.I.L.S. cold-start sequence.
 *
 * Deliberately not a spinner. A spinner says "wait"; this says "you're
 * somewhere". It is skippable on any key or click because the twentieth launch
 * of a working day should not cost two seconds, and it is skipped outright
 * under reduced motion.
 */
export function Intro({ onDone }: IntroProps) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<'mark' | 'caption' | 'leaving'>('mark');

  useEffect(() => {
    if (reduced) {
      onDone();
      return undefined;
    }

    const captionTimer = window.setTimeout(() => setPhase('caption'), CAPTION_AT_MS);
    const leaveTimer = window.setTimeout(() => setPhase('leaving'), SEQUENCE_MS);
    // The extra 420ms covers the fade-out so the app is not revealed mid-wipe.
    const doneTimer = window.setTimeout(onDone, SEQUENCE_MS + 420);

    return () => {
      window.clearTimeout(captionTimer);
      window.clearTimeout(leaveTimer);
      window.clearTimeout(doneTimer);
    };
  }, [reduced, onDone]);

  // Any interaction skips straight to the app.
  useEffect(() => {
    const skip = () => onDone();
    window.addEventListener('keydown', skip, { once: true });
    window.addEventListener('pointerdown', skip, { once: true });
    return () => {
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [onDone]);

  if (reduced) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex flex-col items-center justify-center bg-background',
        'transition-opacity duration-reflow ease-standard',
        phase === 'leaving' ? 'pointer-events-none opacity-0' : 'opacity-100',
      )}
      role="presentation"
    >
      {/* A single soft bloom behind the mark. Cheap, and it keeps the frame
          from reading as a flat loading screen. */}
      <div
        className="pointer-events-none absolute size-[36rem] rounded-full opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(circle, hsl(var(--primary) / 0.35), transparent 70%)' }}
        aria-hidden="true"
      />

      <div className="relative flex flex-col items-center">
        <h1 // 300 rather than 900: Segoe UI and SF Pro both ship a real Light face,
        // so this is a drawn weight rather than a synthesised one. The wide
        // tracking is what makes "TAILS" read as an initialism, and the heavy
        // weight was working against it.
        className="flex font-display text-5xl font-light tracking-[0.2em] text-foreground sm:text-6xl">
          {'TAILS'.split('').map((letter, index) => (
            <span
              key={letter}
              className="animate-rise-in"
              // Letters arrive in sequence rather than together — the wordmark
              // assembles itself, which is the whole gesture.
              style={{ animationDelay: `${index * 90}ms`, animationDuration: '520ms' }}
            >
              {letter}
              {index < 4 ? <span className="opacity-40">.</span> : null}
            </span>
          ))}
        </h1>

        <p
          className={cn(
            'mt-5 max-w-md text-center text-sm text-muted-foreground transition-all duration-settle ease-enter',
            phase === 'mark' ? 'translate-y-1 opacity-0' : 'translate-y-0 opacity-100',
          )}
        >
          Totally Awesome Intelligent Local Sidekick
        </p>
      </div>

      <p className="absolute bottom-8 text-xs text-muted-foreground/60">
        Press any key to skip
      </p>
    </div>
  );
}
