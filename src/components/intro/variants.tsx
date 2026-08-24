import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * The five cold-start sequences, and the shape they share.
 *
 * ## Why five rather than one
 *
 * The first two seconds of an app are the only part everybody sees and nobody
 * chose, and there is no single right answer to what they should feel like —
 * the same launch that reads as confident to one person reads as slow to
 * another. So this is a preference with real options rather than a decision
 * made once by whoever wrote the first one.
 *
 * They are deliberately not variations on a theme. A picker whose five entries
 * are the same animation at different speeds is a picker that answers nothing.
 *
 * ## The contract
 *
 * A variant draws content and nothing else. The overlay, the fade out, the skip
 * handlers and the hand-off timing all belong to `Intro` — a variant that owned
 * its own dismissal would be five chances to leave the app behind a screen that
 * never left.
 *
 * `preview` shrinks a variant into the settings box. Every size below is
 * relative to it, so the same component is the thing being chosen and the thing
 * that runs — a preview drawn separately is a preview that drifts.
 */

export const INTRO_VARIANTS = ['assemble', 'terminal', 'orbit', 'pixels', 'sunrise'] as const;
export type IntroVariant = typeof INTRO_VARIANTS[number];

export const INTRO_LABELS: Record<IntroVariant, { name: string; note: string }> = {
  assemble: { name: 'Assemble', note: 'The letters arrive one at a time.' },
  terminal: { name: 'Terminal', note: 'Typed at a prompt, with a cursor.' },
  orbit: { name: 'Orbit', note: 'They swing in along a ring.' },
  pixels: { name: 'Pixels', note: 'Resolves out of blocks, eight-bit.' },
  sunrise: { name: 'Sunrise', note: 'A horizon comes up behind it.' },
};

/** How long each one runs before the app is handed over. */
export const INTRO_DURATION: Record<IntroVariant, number> = {
  assemble: 2200,
  terminal: 2600,
  orbit: 2400,
  pixels: 2300,
  sunrise: 2800,
};

export const CAPTION = 'Totally Awesome Intelligent Local Sidekick';
const WORD = 'TAILS';

type VariantProps = {
  /** Drawn small, in the settings picker, rather than over the whole app. */
  preview?: boolean;
};

/** Advances through a script of delays, so a variant reads as a phase machine. */
function usePhase(steps: readonly number[]): number {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = steps.map((at, index) => window.setTimeout(() => setPhase(index + 1), at));
    return () => { for (const timer of timers) window.clearTimeout(timer); };
  }, [steps]);

  return phase;
}

/** The caption, which every variant lands on the same way. */
function Caption({ shown, preview }: { shown: boolean; preview?: boolean }) {
  return (
    <p
      className={cn(
        'mt-4 max-w-md text-center text-muted-foreground transition-all duration-settle ease-enter',
        preview ? 'text-[7px] leading-tight' : 'text-sm',
        shown ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
      )}
    >
      {preview ? 'Totally Awesome Intelligent Local Sidekick' : CAPTION}
    </p>
  );
}

const ASSEMBLE_STEPS = [900] as const;

/**
 * The original: letters rise in sequence, and the wordmark assembles itself.
 *
 * 300 rather than 900 on the weight — Segoe UI and SF Pro both ship a real
 * Light face, so this is a drawn weight rather than a synthesised one, and the
 * wide tracking is what makes "TAILS" read as an initialism.
 */
export function AssembleIntro({ preview }: VariantProps) {
  const phase = usePhase(ASSEMBLE_STEPS);

  return (
    <>
      <div
        className={cn(
          'pointer-events-none absolute rounded-full opacity-40 blur-3xl',
          preview ? 'size-40' : 'size-[36rem]',
        )}
        style={{ background: 'radial-gradient(circle, hsl(var(--primary) / 0.35), transparent 70%)' }}
        aria-hidden="true"
      />
      <div className="relative flex flex-col items-center">
        <h1
          className={cn(
            'flex font-display font-light tracking-[0.2em] text-foreground',
            preview ? 'text-base' : 'text-5xl sm:text-6xl',
          )}
        >
          {WORD.split('').map((letter, index) => (
            <span
              key={letter}
              className="animate-rise-in"
              style={{ animationDelay: `${index * 90}ms`, animationDuration: '520ms' }}
            >
              {letter}
              {index < 4 ? <span className="opacity-40">.</span> : null}
            </span>
          ))}
        </h1>
        <Caption shown={phase >= 1} preview={preview} />
      </div>
    </>
  );
}

const TERMINAL_STEPS = [1400] as const;
/** How long each character takes to appear. Fast enough to read as typing. */
const KEYSTROKE_MS = 130;

/**
 * Typed at a prompt, with a cursor that keeps blinking after the word lands.
 *
 * The one variant that says what the app is rather than what it looks like: a
 * thing you talk to that lives on your machine. The cursor is the whole gesture
 * — it is what makes the pause after the last letter read as *waiting for you*
 * rather than as the animation having stalled.
 */
export function TerminalIntro({ preview }: VariantProps) {
  const phase = usePhase(TERMINAL_STEPS);
  const [typed, setTyped] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(
      () => setTyped((count) => (count >= WORD.length ? count : count + 1)),
      KEYSTROKE_MS,
    );
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="relative flex flex-col items-center">
      <div
        className={cn(
          'flex items-baseline font-mono tracking-[0.15em] text-foreground',
          preview ? 'text-sm' : 'text-4xl sm:text-5xl',
        )}
      >
        <span className="mr-2 text-primary" aria-hidden="true">&gt;</span>
        <span>
          {WORD.slice(0, typed).split('').map((letter, index) => (
            <span key={index}>
              {letter}
              {index < 4 ? <span className="opacity-40">.</span> : null}
            </span>
          ))}
        </span>
        {/* A block, not a bar: this is a terminal, and a terminal's caret is
            the size of the character it is standing on. */}
        <span
          className={cn('ml-1 inline-block animate-caret-blink bg-primary', preview ? 'h-3 w-1.5' : 'h-8 w-3 sm:h-10')}
          aria-hidden="true"
        />
      </div>
      <Caption shown={phase >= 1} preview={preview} />
    </div>
  );
}

const ORBIT_STEPS = [80, 1100] as const;

/**
 * The letters swing in along a ring that draws itself.
 *
 * Each starts rotated away from its place by a different amount and settles on
 * a shared curve — so they arrive together without arriving *identically*,
 * which is the difference between an orbit and a fade. The ring is an SVG
 * circle with its own dash offset animated by a transition, which is the
 * cheapest way to draw a line that draws itself.
 */
export function OrbitIntro({ preview }: VariantProps) {
  const phase = usePhase(ORBIT_STEPS);
  const size = preview ? 96 : 320;

  return (
    <div className="relative flex flex-col items-center">
      <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
        <svg
          className="absolute inset-0"
          viewBox="0 0 100 100"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="50"
            cy="50"
            r="42"
            stroke="hsl(var(--primary) / 0.5)"
            strokeWidth="0.6"
            strokeDasharray="264"
            strokeDashoffset={phase >= 1 ? 0 : 264}
            style={{ transition: 'stroke-dashoffset 1400ms cubic-bezier(0.16, 1, 0.3, 1)' }}
          />
        </svg>

        <h1
          className={cn(
            'relative flex font-display font-light tracking-[0.2em] text-foreground',
            preview ? 'text-base' : 'text-5xl',
          )}
        >
          {WORD.split('').map((letter, index) => (
            <span
              key={letter}
              className="inline-block"
              style={{
                // Each letter comes in from its own angle, on a shared curve.
                transform: phase >= 1
                  ? 'rotate(0deg) translateY(0)'
                  : `rotate(${(index - 2) * 40}deg) translateY(${preview ? 28 : 90}px)`,
                opacity: phase >= 1 ? 1 : 0,
                transition: `transform 900ms cubic-bezier(0.16, 1, 0.3, 1) ${index * 70}ms, opacity 500ms ease-out ${index * 70}ms`,
              }}
            >
              {letter}
              {index < 4 ? <span className="opacity-40">.</span> : null}
            </span>
          ))}
        </h1>
      </div>
      <Caption shown={phase >= 2} preview={preview} />
    </div>
  );
}

const PIXELS_STEPS = [1000] as const;
/** The block grid behind the wordmark. Coarse on purpose. */
const PIXEL_COLUMNS = 22;
const PIXEL_ROWS = 7;

/**
 * The wordmark resolves out of a field of blocks.
 *
 * Every block starts lit and goes out in a scattered order, uncovering the word
 * underneath — a dissolve rather than a build, because a build from nothing
 * reads as loading and a dissolve reads as *arriving*. The order is a fixed
 * hash of the coordinates rather than random: an eight-bit machine had no
 * entropy either, and a sequence that differs every launch cannot be recognised
 * as a sequence.
 */
export function PixelsIntro({ preview }: VariantProps) {
  const phase = usePhase(PIXELS_STEPS);

  return (
    <div className="relative flex flex-col items-center">
      <div className="relative">
        <h1
          className={cn(
            'relative font-mono font-bold tracking-[0.18em] text-foreground',
            preview ? 'text-sm' : 'text-4xl sm:text-5xl',
          )}
          style={{ imageRendering: 'pixelated' }}
        >
          {WORD.split('').map((letter, index) => (
            <span key={letter}>
              {letter}
              {index < 4 ? <span className="opacity-40">.</span> : null}
            </span>
          ))}
        </h1>

        <div
          className="pointer-events-none absolute -inset-2 grid"
          style={{
            gridTemplateColumns: `repeat(${PIXEL_COLUMNS}, 1fr)`,
            gridTemplateRows: `repeat(${PIXEL_ROWS}, 1fr)`,
          }}
          aria-hidden="true"
        >
          {Array.from({ length: PIXEL_COLUMNS * PIXEL_ROWS }, (_, index) => {
            // A fixed scatter: multiply by a prime and wrap, so neighbours are
            // never adjacent in time and the same pattern plays every launch.
            const order = (index * 37) % (PIXEL_COLUMNS * PIXEL_ROWS);
            return (
              <span
                key={index}
                className="bg-primary"
                style={{
                  opacity: phase >= 1 ? 0 : 0.9,
                  transition: `opacity 260ms steps(2, end) ${(order / (PIXEL_COLUMNS * PIXEL_ROWS)) * 700}ms`,
                }}
              />
            );
          })}
        </div>
      </div>
      <Caption shown={phase >= 1} preview={preview} />
    </div>
  );
}

const SUNRISE_STEPS = [120, 1300] as const;

/**
 * A horizon comes up behind the wordmark.
 *
 * The warm one, and the only variant with somewhere in it rather than just
 * something. The sun rises *behind* the letters so they silhouette against it
 * for a moment before the light gets past them, which is the whole reason the
 * order of these three layers matters.
 */
export function SunriseIntro({ preview }: VariantProps) {
  const phase = usePhase(SUNRISE_STEPS);

  return (
    <div className="relative flex w-full flex-col items-center overflow-hidden">
      <div
        className={cn('relative flex w-full items-center justify-center', preview ? 'h-24' : 'h-72')}
      >
        {/* The sky, warming as it comes up. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: 'linear-gradient(to top, hsl(var(--primary) / 0.35), transparent 60%)',
            opacity: phase >= 1 ? 1 : 0,
            transition: 'opacity 1600ms ease-out',
          }}
          aria-hidden="true"
        />

        <div
          className={cn('pointer-events-none absolute rounded-full', preview ? 'size-16' : 'size-56')}
          style={{
            background: 'radial-gradient(circle, hsl(var(--primary) / 0.75), hsl(var(--primary) / 0.1) 70%)',
            transform: phase >= 1 ? 'translateY(20%)' : 'translateY(110%)',
            transition: 'transform 1800ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          aria-hidden="true"
        />

        <h1
          className={cn(
            'relative flex font-display font-light tracking-[0.2em] text-foreground',
            preview ? 'text-base' : 'text-5xl sm:text-6xl',
          )}
        >
          {WORD.split('').map((letter, index) => (
            <span
              key={letter}
              className="animate-fade-in"
              style={{ animationDelay: `${300 + index * 80}ms`, animationDuration: '700ms' }}
            >
              {letter}
              {index < 4 ? <span className="opacity-40">.</span> : null}
            </span>
          ))}
        </h1>

        {/* The ground, which is what makes the sun read as rising rather than
            as a circle moving up. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-foreground/25"
          aria-hidden="true"
        />
      </div>
      <Caption shown={phase >= 2} preview={preview} />
    </div>
  );
}

export const INTRO_COMPONENTS: Record<IntroVariant, (props: VariantProps) => React.JSX.Element> = {
  assemble: AssembleIntro,
  terminal: TerminalIntro,
  orbit: OrbitIntro,
  pixels: PixelsIntro,
  sunrise: SunriseIntro,
};
