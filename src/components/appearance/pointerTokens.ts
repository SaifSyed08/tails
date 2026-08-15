/**
 * Pointer position as CSS custom properties.
 *
 * The third gap the design doc names: mouse-following effects "have nowhere to
 * live". They still have no *spec* vocabulary — there is no `follow: cursor`
 * field in a surface recipe — but the reason they were unreachable was more
 * basic than that. CSS cannot see the pointer. Without something writing the
 * coordinates into the cascade, a spotlight that tracks the mouse is not a
 * missing primitive, it is an impossible one, and no amount of freeform CSS
 * gets there.
 *
 * So this publishes four properties on `documentElement` and stops:
 *
 *   --pointer-x   --pointer-y     percentages, for gradient positions
 *   --pointer-px  --pointer-py    pixels, for translate() and inset shadows
 *
 * and a theme composes whatever it wants out of them:
 *
 *   background-image:
 *     radial-gradient(circle at var(--pointer-x) var(--pointer-y),
 *                     hsl(var(--primary) / 0.18), transparent 40%);
 *
 * That is deliberately a smaller mechanism than "mouse-following effects". A
 * built-in trail or glow would be one effect somebody chose; two numbers in the
 * cascade are every effect anybody can express with a gradient, a shadow or a
 * transform, and they cost one rAF-coalesced write per frame the mouse moves.
 *
 * Coalescing to an animation frame is not an optimisation detail. A raw
 * `pointermove` handler fires faster than the display refreshes on a high-poll
 * mouse, and each write invalidates every declaration in the document that
 * mentions the property — so the unthrottled version does the same work three
 * or four times per painted frame, forever, on a laptop.
 */

let running = false;

/**
 * Starts publishing pointer position. Returns the stop function.
 *
 * Idempotent, because it is called from a component effect and React's strict
 * mode mounts effects twice in development — two trackers would each schedule
 * their own frame and fight over the same four properties.
 */
export function startPointerTokens(): () => void {
  if (typeof window === 'undefined' || running) return () => {};
  running = true;

  const root = document.documentElement;
  let frame = 0;
  let pending: { x: number; y: number } | null = null;

  const flush = () => {
    frame = 0;
    if (!pending) return;

    const { x, y } = pending;
    pending = null;

    // One decimal place. The extra precision is invisible and the shorter
    // string is one less thing for the style engine to parse every frame.
    root.style.setProperty('--pointer-x', `${Math.round((x / window.innerWidth) * 1000) / 10}%`);
    root.style.setProperty('--pointer-y', `${Math.round((y / window.innerHeight) * 1000) / 10}%`);
    root.style.setProperty('--pointer-px', `${Math.round(x)}px`);
    root.style.setProperty('--pointer-py', `${Math.round(y)}px`);
  };

  const onMove = (event: PointerEvent) => {
    pending = { x: event.clientX, y: event.clientY };
    if (!frame) frame = window.requestAnimationFrame(flush);
  };

  // Passive: this never calls preventDefault, and saying so up front keeps the
  // handler off the scrolling critical path.
  window.addEventListener('pointermove', onMove, { passive: true });

  return () => {
    running = false;
    window.removeEventListener('pointermove', onMove);
    if (frame) window.cancelAnimationFrame(frame);
    // The floor values in index.css only apply while nothing has been written
    // here, so the inline properties have to go rather than being reset to a
    // guess at what the floor said.
    for (const name of ['--pointer-x', '--pointer-y', '--pointer-px', '--pointer-py']) {
      root.style.removeProperty(name);
    }
  };
}
