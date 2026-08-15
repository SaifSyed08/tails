/**
 * Pointer position as CSS custom properties.
 *
 * CSS cannot see the pointer. Without something writing the coordinates into
 * the cascade, a spotlight that tracks the mouse is not a missing primitive, it
 * is an impossible one, and no amount of freeform CSS gets there. So this
 * publishes four properties on `documentElement`:
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
 * Two numbers in the cascade are every effect anybody can express with a
 * gradient, a shadow or a transform, which is a much better trade than one
 * built-in effect somebody chose.
 *
 * ## Why this is gated
 *
 * The first version started on mount and ran for the rest of the session. That
 * is wrong in a way worth recording, because it looks free and is not. Every
 * flush writes four custom properties on the root element, and a custom
 * property change on `:root` invalidates the computed style of everything below
 * it that could reference it. Doing that on every frame the mouse moves, for a
 * whole session, for a feature no current theme uses, is a battery cost with no
 * benefit — on a laptop, for a user who never asked for a cursor effect.
 *
 * So the writes only happen while something is reading them, and "something" is
 * checked rather than assumed: any adopted stylesheet mentioning `--pointer-`
 * (a theme or a `theme_css` layer), or a drawn cursor or trail being switched
 * on. The check is cached and only recomputed when the appearance changes,
 * because scanning stylesheets per mouse move would cost more than the writes.
 *
 * The `pointermove` listener itself stays attached even when nothing reads the
 * tokens. That is deliberate: a listener whose body is one boolean test is
 * genuinely free, and keeping it is what lets the answer be recomputed lazily
 * at the moment of first use — which sidesteps a race where the theme resolved
 * on boot lands after this module has already decided nobody needs it.
 */

/** Coalescing to a frame: a high-poll mouse fires several moves per painted frame. */
let frame = 0;
let pending: { x: number; y: number } | null = null;
let attached = false;

/**
 * Whether anything currently reads the pointer tokens.
 *
 * `null` means "not worked out yet" and is the state after every appearance
 * change, so the answer is recomputed at most once per theme rather than once
 * per mouse move.
 */
let consumed: boolean | null = null;

const POINTER_TOKENS = ['--pointer-x', '--pointer-y', '--pointer-px', '--pointer-py'] as const;

/**
 * Does any adopted stylesheet mention the pointer tokens?
 *
 * Only `adoptedStyleSheets` is scanned, never the bundled stylesheet: the theme
 * layer and the `theme_css` layer are the two things that can start reading the
 * pointer, and `index.css` mentions the tokens only to give them floor values.
 * Scanning it too would make the answer permanently `true` and the gate
 * pointless.
 */
function someSheetReadsPointer(): boolean {
  for (const sheet of document.adoptedStyleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // A sheet we cannot read is one we did not construct; assume it is not ours.
      continue;
    }
    for (const rule of rules) {
      if (rule.cssText.includes('--pointer-')) return true;
    }
  }
  return false;
}

/** Is the theme drawing its own cursor or trail? Both are painted from pointer tokens. */
function drawnPointerIsOn(): boolean {
  const computed = getComputedStyle(document.documentElement);
  return computed.getPropertyValue('--t-pointer-image').trim() !== 'none'
    || computed.getPropertyValue('--t-trail-image').trim() !== 'none';
}

function needed(): boolean {
  if (consumed === null) consumed = drawnPointerIsOn() || someSheetReadsPointer();
  return consumed;
}

const flush = () => {
  frame = 0;
  if (!pending) return;

  const { x, y } = pending;
  pending = null;

  const root = document.documentElement;
  // One decimal place. The extra precision is invisible and the shorter string
  // is one less thing for the style engine to parse every frame.
  root.style.setProperty('--pointer-x', `${Math.round((x / window.innerWidth) * 1000) / 10}%`);
  root.style.setProperty('--pointer-y', `${Math.round((y / window.innerHeight) * 1000) / 10}%`);
  root.style.setProperty('--pointer-px', `${Math.round(x)}px`);
  root.style.setProperty('--pointer-py', `${Math.round(y)}px`);
};

const onMove = (event: PointerEvent) => {
  if (!needed()) return;
  pending = { x: event.clientX, y: event.clientY };
  if (!frame) frame = window.requestAnimationFrame(flush);
};

/**
 * Forgets whether the tokens are read, so the next mouse move works it out again.
 *
 * Called on every appearance change. It also clears the written values when the
 * answer turns out to be no, because a theme that used to draw a cursor and no
 * longer does must not leave the last position it saw sitting on the root — a
 * stale coordinate is how an effect appears to survive the theme that made it.
 */
export function refreshPointerTracking(): void {
  if (typeof document === 'undefined') return;
  consumed = null;

  if (!needed()) {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    pending = null;
    for (const name of POINTER_TOKENS) document.documentElement.style.removeProperty(name);
  }
}

/**
 * Attaches the pointer listener. Returns the detach function.
 *
 * Idempotent: React's strict mode mounts effects twice in development, and two
 * trackers would each schedule their own frame and fight over the same four
 * properties.
 */
export function startPointerTokens(): () => void {
  if (typeof window === 'undefined' || attached) return () => {};
  attached = true;

  window.addEventListener('pointermove', onMove, { passive: true });

  return () => {
    attached = false;
    window.removeEventListener('pointermove', onMove);
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    // The floor values in index.css only apply while nothing has been written
    // here, so the inline properties have to go rather than being reset to a
    // guess at what the floor said.
    for (const name of POINTER_TOKENS) document.documentElement.style.removeProperty(name);
  };
}
