import { useEffect, useState } from 'react';

import {
  INTRO_COMPONENTS,
  INTRO_DURATION,
  INTRO_VARIANTS,
  type IntroVariant,
} from '@/components/intro/variants';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';

/** Where the chosen sequence lives. Beside the switch that turns it off. */
export const INTRO_VARIANT_KEY = 'tails.introVariant';

export const DEFAULT_INTRO: IntroVariant = 'assemble';

/** How long the fade out takes, so the app is not revealed mid-wipe. */
const LEAVE_MS = 420;

/** The stored choice, or the default. Never throws: this runs before anything. */
export function readIntroVariant(): IntroVariant {
  try {
    const stored = localStorage.getItem(INTRO_VARIANT_KEY);
    return (INTRO_VARIANTS as readonly string[]).includes(stored ?? '')
      ? stored as IntroVariant
      : DEFAULT_INTRO;
  } catch {
    return DEFAULT_INTRO;
  }
}

export function writeIntroVariant(variant: IntroVariant): void {
  try {
    localStorage.setItem(INTRO_VARIANT_KEY, variant);
  } catch {
    // A blocked store costs the preference, not the app.
  }
}

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
 *
 * ## What this owns, and what the variants own
 *
 * Everything about *leaving* is here: the overlay, the fade, the skip handlers
 * and the hand-off. A variant draws content and nothing else — five components
 * each owning their own dismissal would be five chances to leave the app behind
 * a screen that never left, and the one that got it wrong would be the one
 * nobody had picked yet.
 *
 * The variants themselves are in `variants.tsx`, along with why there are five.
 */
export function Intro({ onDone }: IntroProps) {
  const reduced = useReducedMotion();
  const [leaving, setLeaving] = useState(false);
  // Read once, on mount. A preference changed while the sequence is playing is
  // a preference for the *next* launch.
  const [variant] = useState(readIntroVariant);
  const Sequence = INTRO_COMPONENTS[variant];

  useEffect(() => {
    if (reduced) {
      onDone();
      return undefined;
    }

    const runFor = INTRO_DURATION[variant];
    const leaveTimer = window.setTimeout(() => setLeaving(true), runFor);
    const doneTimer = window.setTimeout(onDone, runFor + LEAVE_MS);

    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(doneTimer);
    };
  }, [reduced, onDone, variant]);

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
        leaving ? 'pointer-events-none opacity-0' : 'opacity-100',
      )}
      role="presentation"
    >
      <Sequence />

      <p className="absolute bottom-8 text-xs text-muted-foreground/60">
        Press any key to skip
      </p>
    </div>
  );
}
