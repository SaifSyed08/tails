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

/** The headline, split so the last word can be animated on its own. */
const HEADLINE = ['What', 'are', 'we', 'building', 'today?'];

/** When the last word has finished its entrance: its stagger plus its duration. */
const HEADLINE_SETTLED_MS = 540;

/** Per-character offsets. The colour drifts; the hop travels. */
const COLOUR_STEP_MS = 140;
const JUMP_STEP_MS = 80;

/**
 * The closing word: always changing colour, and rippling when pointed at.
 *
 * The two effects are deliberately on two different elements. They are
 * independent states — the colour is ambient, the ripple is a response — and
 * putting them on one element would mean one `animation` shorthand, where
 * gating the hop on hover would take the colour with it.
 *
 * Both are pure CSS: every character runs the same pair of keyframes and only
 * its `animation-delay` differs, so nothing in React drives a frame and the
 * hop stays on the compositor.
 *
 * Split for animation but not for reading — the characters are hidden from
 * assistive tech and the wrapper carries the word, so a screen reader hears
 * "today?" rather than six letters, and the text still selects as one word.
 */
function JumpingWord({ word, animate }: { word: string; animate: boolean }) {
  if (!animate) return <span className="text-primary">{word}</span>;

  return (
    // `group` scopes the hover to the word itself: pointing anywhere else in
    // the headline is not pointing at this.
    <span className="group text-primary" aria-label={word}>
      {[...word].map((character, index) => (
        <span
          key={`${character}-${index}`}
          aria-hidden="true"
          className="animate-hue-cycle inline-block"
          // Held until the headline has finished arriving, so the word is not
          // already cycling while it is still sliding into place.
          style={{ animationDelay: `${HEADLINE_SETTLED_MS + index * COLOUR_STEP_MS}ms` }}
        >
          <span
            className={cn(
              'inline-block group-hover:animate-letter-jump',
              // Covers the one ugly case: a pointer leaving mid-hop would
              // otherwise drop the character straight back to the baseline.
              'transition-transform duration-quick ease-standard',
            )}
            /*
              No entrance offset here, unlike the colour: this starts when the
              pointer arrives, and a delay measured from mount would make the
              first hover late by however long the screen had been open.
            */
            style={{ animationDelay: `${index * JUMP_STEP_MS}ms` }}
          >
            {character}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * What we know about the model, which is three things rather than two.
 *
 * "Not yet" and "never" look identical if both are modelled as `null`, and
 * they must not be drawn the same way: one has to hold its place, the other
 * has to leave.
 */
export type ModelBadgeState =
  | { status: 'resolving' }
  | { status: 'ready'; name: string }
  | { status: 'unavailable' };

type EmptyStateProps = {
  /** The folder this conversation runs in, shown as the one bit of real context. */
  cwd: string;
  model?: ModelBadgeState;
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
export function EmptyState({ cwd, model, onPick }: EmptyStateProps) {
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
            // Promoted so the pulse runs on the compositor. Left unpromoted, a
            // 28rem blurred radial re-rasterises its blur every frame and drags
            // the text sweep in front of it down with it.
            willChange: 'opacity',
          }}
        />
        <div
          className={cn('-ml-40 size-[22rem] rounded-full opacity-25 blur-3xl', !reduced && 'animate-pulse')}
          style={{
            background: 'radial-gradient(circle, hsl(var(--accent-foreground) / 0.28), transparent 70%)',
            animationDuration: '11s',
            animationDelay: '1.4s',
            willChange: 'opacity',
          }}
        />
      </div>

      <div className="relative flex flex-col items-center">
        {/*
          The model, or no badge at all. "Ready" said nothing the rest of the
          screen was not already saying, and a guessed model name would be
          worse than the silence — so when the CLI cannot tell us, this is
          absent.

          While it is still being read, though, the pill is present and says
          so. Absent-then-present is an insertion, and an insertion moves
          everything under it a beat after the screen has already settled; the
          placeholder turns that into a text swap inside a box that never
          moved. `min-w` sized to a representative name keeps even the swap
          from twitching, since most names land inside it.

          "Absent" is therefore `invisible` rather than unmounted. Removing it
          outright would trade the insertion for a collapse — and a worse one,
          because a failed read can take seconds, so the jump would land well
          after the screen looked finished. Nothing is drawn and nothing is
          announced either way; the only difference is that the space it would
          have taken stays taken.
        */}
        {model ? (
          <span
            className={cn(
              'mb-5 flex min-w-[11rem] items-center justify-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground backdrop-blur',
              model.status === 'unavailable' && 'invisible',
              !reduced && 'animate-rise-in',
            )}
            aria-hidden={model.status === 'unavailable'}
            aria-live="polite"
          >
            <Sparkles
              className={cn(
                'size-3 shrink-0 text-primary',
                // The one honest signal that something is still happening.
                model.status === 'resolving' && !reduced && 'animate-pulse',
              )}
              aria-hidden="true"
            />
            <span
              // Keyed so the arriving name fades rather than snapping in. The
              // pill itself is not keyed, so the frame stays put through it.
              key={model.status}
              className={!reduced ? 'animate-fade-in' : undefined}
            >
              {model.status === 'ready' ? model.name : 'Loading model…'}
            </span>
          </span>
        ) : null}

        <h2 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">
          {HEADLINE.map((word, index) => (
            <span
              key={word}
              className={cn('mr-[0.3em] inline-block', !reduced && 'animate-rise-in')}
              // The line assembles itself word by word, on the same capped
              // ramp every staggered list in the app uses.
              style={reduced ? undefined : { animationDelay: `${120 + readStaggerDelay(index)}ms` }}
            >
              {index === HEADLINE.length - 1 ? (
                <JumpingWord word={word} animate={!reduced} />
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

        {/*
          Always rendered, hidden until known. The folder arrives a moment
          after this screen does, and dropping the row in at that point shoves
          the openers below it down — the same insertion problem as the pill,
          one element further down. Reserving the line costs nothing and the
          cards never move.
        */}
        <span
          className={cn(
            'mt-4 flex items-center gap-1.5 font-mono text-xs text-muted-foreground/80',
            !folder && 'invisible',
            folder && !reduced && 'animate-fade-in',
          )}
          aria-hidden={!folder}
        >
          <FolderOpen className="size-3.5" aria-hidden="true" />
          {folder ?? 'resolving'}
        </span>
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
