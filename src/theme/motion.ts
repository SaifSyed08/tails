/**
 * Motion tokens.
 *
 * These values also exist as CSS custom properties in `index.css`, and a
 * generated theme can change them (`motion: 'playful'` moves differently from
 * `motion: 'calm'`). The constants here are the pre-paint fallback; the
 * readers below prefer the live CSS value so JS-driven and CSS-driven motion
 * can never disagree after a re-theme.
 */

/** Fallback durations in milliseconds, named by the size of the change. */
export const DURATION = {
  /** Hover, focus, pressed. Fast enough to feel like direct contact. */
  instant: 90,
  /** A control changing state: toggles, tabs, small reveals. */
  quick: 160,
  /** An element entering or leaving: cards, panels, rows. */
  settle: 240,
  /** A layout rearranging, where the user must follow what moved. */
  reflow: 380,
} as const;

export type DurationName = keyof typeof DURATION;

/**
 * Fallback easings. `exit` is faster-out than `enter` is slow-in: things
 * leaving should get out of the way, things arriving earn a beat of attention.
 */
export const EASING = {
  enter: 'cubic-bezier(0.22, 1, 0.36, 1)',
  exit: 'cubic-bezier(0.64, 0, 0.78, 0)',
  standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
  emphasis: 'cubic-bezier(0.34, 1.4, 0.64, 1)',
} as const;

/** Delay between consecutive items in a staggered group, in milliseconds. */
export const STAGGER_STEP_MS = 40;

/**
 * Ceiling on any single item's stagger delay. Without it the twentieth row of
 * a list animates almost a second after the first, which reads as lag.
 */
export const STAGGER_MAX_MS = 240;

export function readStaggerDelay(index: number): number {
  return Math.min(index * STAGGER_STEP_MS, STAGGER_MAX_MS);
}

/**
 * Reads a duration from the live CSS custom property, falling back to the
 * constant above.
 *
 * Parsing here rather than caching is deliberate: a re-theme rewrites these
 * variables, and a cached value would leave JS animating on the previous
 * theme's rhythm.
 */
export function readDuration(name: DurationName): number {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return DURATION[name];
  }

  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--duration-${name}`)
    .trim();

  if (raw.endsWith('ms')) {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (raw.endsWith('s')) {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) return parsed * 1000;
  }

  return DURATION[name];
}

/**
 * Whether the user has asked the system to minimise animation.
 *
 * Read at call time rather than cached: the OS setting can change while the
 * app is open, and a companion that keeps bouncing after the user turned
 * motion off is exactly what this setting exists to stop.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Subscribes to reduced-motion changes. Returns an unsubscribe function. */
export function watchReducedMotion(onChange: (reduced: boolean) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};

  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  const handleChange = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener('change', handleChange);
  return () => query.removeEventListener('change', handleChange);
}
