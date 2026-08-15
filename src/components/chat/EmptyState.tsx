import { FolderOpen, Palette, Search, Sparkles, TerminalSquare, Wrench } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';
import { readStaggerDelay } from '@/theme/motion';

/**
 * The openers offered on a blank chat.
 *
 * Chosen to advertise what this app can do that a chat box cannot — it runs
 * in a real folder, it has a terminal, and it can restyle itself — rather
 * than to be a list of generic prompts.
 */
const SUGGESTIONS = [
  {
    icon: Search,
    title: 'Explore this folder',
    hint: 'Map the codebase',
    prompt: 'Take a look around this folder and give me a short tour: what it is, how it is structured, and where the interesting parts live.',
  },
  {
    icon: Wrench,
    title: 'Fix something',
    hint: 'Find and repair',
    prompt: 'Something is broken here. Find the failing behaviour, explain the root cause, and fix it.',
  },
  {
    icon: Palette,
    title: 'Restyle the app',
    hint: 'Change how T.A.I.L.S. looks',
    prompt: 'Restyle this app with a new look — show me a preview before you apply anything.',
  },
  {
    icon: TerminalSquare,
    title: 'Run something',
    hint: 'Use the shell',
    prompt: 'Run the checks for this project and tell me what is failing.',
  },
] as const;

type EmptyStateProps = {
  /** The folder this conversation runs in, shown as the one bit of real context. */
  cwd: string;
  onPick: (prompt: string) => void;
};

/**
 * The first thing seen on every new chat.
 *
 * Built entirely from theme tokens and the app's own motion vocabulary, so a
 * restyle carries it along instead of leaving a hardcoded gradient behind.
 * Under reduced motion the whole thing simply arrives: same layout, no drift,
 * no shimmer.
 */
export function EmptyState({ cwd, onPick }: EmptyStateProps) {
  const reduced = useReducedMotion();
  // Only the last two segments; an absolute path is noise on a hero.
  const folder = cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).slice(-2).join('/') : null;

  return (
    <div className="relative flex flex-col items-center pt-16 text-center">
      {/*
        Two offset blooms, breathing out of phase. `animate-pulse` is reused
        with long, mismatched durations rather than a bespoke keyframe: it
        costs nothing, it is already in the build, and out-of-phase opacity on
        two blurred radials reads as slow drift.
      */}
      <div className="pointer-events-none absolute inset-x-0 -top-10 flex justify-center" aria-hidden="true">
        <div
          className={cn('size-[28rem] rounded-full opacity-30 blur-3xl', !reduced && 'animate-pulse')}
          style={{
            background: 'radial-gradient(circle, hsl(var(--primary) / 0.45), transparent 68%)',
            animationDuration: '7s',
          }}
        />
        <div
          className={cn('-ml-40 size-[22rem] rounded-full opacity-25 blur-3xl', !reduced && 'animate-pulse')}
          style={{
            background: 'radial-gradient(circle, hsl(var(--accent-foreground) / 0.28), transparent 70%)',
            animationDuration: '11s',
            animationDelay: '1.4s',
          }}
        />
      </div>

      <div className="relative flex flex-col items-center">
        <span
          className={cn(
            'mb-5 flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground backdrop-blur',
            !reduced && 'animate-rise-in',
          )}
        >
          <Sparkles className="size-3 text-primary" aria-hidden="true" />
          Ready
        </span>

        <h2 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">
          {['What', 'are', 'we', 'building', 'today?'].map((word, index) => (
            <span
              key={word}
              className={cn('mr-[0.3em] inline-block', !reduced && 'animate-rise-in')}
              // The line assembles itself word by word, on the same capped
              // ramp every staggered list in the app uses.
              style={reduced ? undefined : { animationDelay: `${120 + readStaggerDelay(index)}ms` }}
            >
              {/* The last word carries the sweep, so the eye finishes the
                  headline where the emphasis is. */}
              {index === 4 && !reduced ? (
                <span
                  className="animate-shimmer bg-clip-text text-transparent"
                  style={{
                    backgroundImage:
                      'linear-gradient(90deg, hsl(var(--foreground)) 35%, hsl(var(--primary)) 50%, hsl(var(--foreground)) 65%)',
                    backgroundSize: '250% 100%',
                  }}
                >
                  {word}
                </span>
              ) : (
                word
              )}
            </span>
          ))}
        </h2>

        <p
          className={cn('mt-3 max-w-md text-sm text-muted-foreground', !reduced && 'animate-fade-in')}
          style={reduced ? undefined : { animationDelay: '380ms' }}
        >
          T.A.I.L.S. runs Claude Code with your tools, your files, and your machine.
        </p>

        {folder ? (
          <span
            className={cn(
              'mt-4 flex items-center gap-1.5 font-mono text-xs text-muted-foreground/80',
              !reduced && 'animate-fade-in',
            )}
            style={reduced ? undefined : { animationDelay: '460ms' }}
          >
            <FolderOpen className="size-3.5" aria-hidden="true" />
            {folder}
          </span>
        ) : null}
      </div>

      <div className="relative mt-9 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((suggestion, index) => (
          <button
            key={suggestion.title}
            type="button"
            onClick={() => onPick(suggestion.prompt)}
            data-tails-part="card"
            className={cn(
              'group flex items-center gap-3 p-3 text-left transition-transform duration-quick ease-emphasis',
              'hover:-translate-y-0.5 focus-visible:-translate-y-0.5 focus-visible:outline-none',
              !reduced && 'animate-rise-in',
            )}
            style={reduced ? undefined : { animationDelay: `${520 + readStaggerDelay(index)}ms` }}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary transition-colors duration-quick group-hover:bg-primary/20">
              <suggestion.icon className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{suggestion.title}</span>
              <span className="block truncate text-xs text-muted-foreground">{suggestion.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
