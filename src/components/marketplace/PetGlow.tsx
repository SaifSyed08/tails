import { useEffect, useRef, type CSSProperties } from 'react';

import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';

/**
 * The light behind a pet.
 *
 * One component for both shelves. It used to be written inline in `PetStage`
 * and again in the catalogue card, which is why the installed pets glowed
 * convincingly and the catalogue ones barely did: same gradient, but the
 * catalogue's box is a third of the width, so an ellipse sized in percentages
 * collapsed to something smaller than the sprite standing in front of it.
 * Sizing in pixels, from one place, makes the two read identically.
 *
 * ## Following the pointer
 *
 * The appearance module already publishes the pointer on `:root` — `--pointer-px`
 * and `--pointer-py`, in viewport pixels, written once per animation frame — so
 * this adds no listener of its own and inherits that coalescing for free.
 *
 * Those are viewport coordinates and a gradient needs element-relative ones, so
 * the card's own origin is measured when the pointer arrives and subtracted in
 * `calc()`. That measurement is a single `getBoundingClientRect` per hover, not
 * per frame: the card does not move while it is hovered, apart from scrolling,
 * which is watched separately and only while active.
 */

type PetGlowProps = {
  /** Usually "is the card hovered". Fades out rather than unmounting. */
  active: boolean;
  className?: string;
};

/** The lit area, in CSS pixels. Bigger than any card, so the light spills round the pet. */
const GLOW_WIDTH = 260;
const GLOW_HEIGHT = 210;

export function PetGlow({ active, className }: PetGlowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const follows = active && !reduced;

  useEffect(() => {
    const element = ref.current;
    if (!follows || !element) return undefined;

    const measure = () => {
      const rect = element.getBoundingClientRect();
      element.style.setProperty('--glow-origin-x', `${rect.left}px`);
      element.style.setProperty('--glow-origin-y', `${rect.top}px`);
    };

    measure();
    // Capture, because the marketplace scrolls in its own container rather than
    // on the window. Passive, because this never blocks the scroll.
    window.addEventListener('scroll', measure, { passive: true, capture: true });
    window.addEventListener('resize', measure);

    return () => {
      window.removeEventListener('scroll', measure, { capture: true });
      window.removeEventListener('resize', measure);
    };
  }, [follows]);

  // Reduced motion gets the same light, parked. The effect is decoration; a
  // gradient chasing the pointer is exactly the kind of movement the setting is
  // asking us to stop.
  const position = follows
    ? 'calc(var(--pointer-px, 50%) - var(--glow-origin-x, 0px)) '
      + 'calc(var(--pointer-py, 50%) - var(--glow-origin-y, 0px))'
    : '50% 60%';

  const style: CSSProperties = {
    backgroundImage: `radial-gradient(${GLOW_WIDTH}px ${GLOW_HEIGHT}px at ${position}, `
      // `--primary` rather than a colour: the accent is a theme token, and it is
      // being changed from blue to amber underneath us this week.
      + 'hsl(var(--primary) / 0.38), hsl(var(--primary) / 0.10) 45%, transparent 72%)',
    opacity: active ? 1 : 0,
  };

  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={style}
      className={cn(
        'pointer-events-none absolute inset-0',
        !reduced && 'transition-opacity duration-settle ease-standard',
        className,
      )}
    />
  );
}
