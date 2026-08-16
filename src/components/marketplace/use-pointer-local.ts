import { useEffect, useRef, type RefObject } from 'react';

/**
 * The pointer's position *inside* one element, as inheritable CSS variables.
 *
 * The appearance module publishes `--pointer-px` / `--pointer-py` on `:root`
 * once per animation frame, in viewport pixels. That is the right source — one
 * listener for the whole app — but anything that wants to react to the pointer
 * relative to *itself* needs its own origin subtracted, and measuring that in
 * every component would mean a `getBoundingClientRect` per component per frame.
 *
 * So the container measures itself once when the pointer arrives and publishes
 * four variables. Custom properties inherit, so every descendant — the glow
 * behind the pet, the parallax on the pet itself — reads them for free and
 * updates on the same frame as the pointer, with no listener and no re-render.
 *
 *   --pet-local-x / --pet-local-y     pointer, relative to this element
 *   --pet-center-x / --pet-center-y   this element's midpoint
 *
 * The rect is re-read on scroll and resize while active, because those are the
 * two things that move a card the pointer is already sitting on.
 */
export function usePointerLocal<T extends HTMLElement>(active: boolean): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return undefined;

    const measure = () => {
      const rect = element.getBoundingClientRect();
      element.style.setProperty('--pet-local-x', `calc(var(--pointer-px, 0px) - ${rect.left}px)`);
      element.style.setProperty('--pet-local-y', `calc(var(--pointer-py, 0px) - ${rect.top}px)`);
      element.style.setProperty('--pet-center-x', `${rect.width / 2}px`);
      element.style.setProperty('--pet-center-y', `${rect.height / 2}px`);
    };

    measure();
    // Capture, because the marketplace scrolls in its own container rather than
    // on the window. Passive, because this never blocks a scroll.
    window.addEventListener('scroll', measure, { passive: true, capture: true });
    window.addEventListener('resize', measure);

    return () => {
      window.removeEventListener('scroll', measure, { capture: true });
      window.removeEventListener('resize', measure);
    };
  }, [active]);

  return ref;
}

/**
 * How far a pet leans toward the pointer, as a transform.
 *
 * A few pixels, clamped, so it reads as the pet noticing you rather than as the
 * layout moving. Returned as a style object because it belongs on a wrapper:
 * the sprite itself already uses `transform` for its facing, and a second
 * transform on the same element would replace the first.
 */
export const parallaxStyle = (reach: number) => ({
  transform: `translate(
    clamp(${-reach}px, calc((var(--pet-local-x, var(--pet-center-x, 0px)) - var(--pet-center-x, 0px)) * 0.06), ${reach}px),
    clamp(${-reach}px, calc((var(--pet-local-y, var(--pet-center-y, 0px)) - var(--pet-center-y, 0px)) * 0.05), ${reach}px)
  )`,
});
