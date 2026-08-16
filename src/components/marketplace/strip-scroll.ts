/**
 * Turning a vertical wheel into a horizontal strip that scrolls smoothly.
 *
 * Its own file, and pure apart from one measurement, because every part of this
 * is a rule that looks like nothing in a diff and is separately infuriating to
 * live with: how far a notch goes, when the event is not ours to take, and how
 * the strip travels the distance. All three were got wrong at least once.
 */

/**
 * `WheelEvent.deltaMode`, spelled out rather than read off the global.
 *
 * The values are fixed by the spec, and taking them from `WheelEvent` would
 * make functions that are otherwise arithmetic depend on there being a DOM —
 * which is the one thing standing between these rules and being checkable.
 */
const DELTA_MODE_LINE = 1;
const DELTA_MODE_PAGE = 2;

/**
 * The most one wheel event may move the strip, in icons.
 *
 * The cap, not the scaling, is what makes this feel right, because the size of
 * a notch is not ours to know. Measured in this build, a wheel arrives in
 * *pixel* mode, so the strip moves by whatever `deltaY` the OS decided a notch
 * is worth — and on a machine set to scroll more than a few lines at a time
 * that was most of the strip per notch, which reads as paging rather than
 * scrolling. Capping in icons is the one rule that holds whatever the mouse,
 * the mode, or the control panel says: a notch moves about two pets.
 *
 * A trackpad is unaffected. Its deltas arrive as a stream of a few pixels each,
 * far below the cap, so fine scrolling stays fine.
 */
const MAX_NOTCH_ITEMS = 2;

/** Used when the strip is too short to measure its own pitch: a 36px icon and its gap. */
const FALLBACK_ITEM_PITCH = 40;

/** How much of the remaining distance the strip closes each frame. Lower is longer. */
const SCROLL_EASE = 0.22;

/** Within half a pixel of the target, stop animating and land on it. */
const SCROLL_EPSILON = 0.5;

/** The wheel's movement along one axis, in pixels, whatever unit it arrived in. */
function wheelPixels(delta: number, mode: number, itemPitch: number, pageSize: number): number {
  // A "line" of a strip of icons is an icon. Whatever these come to, the cap
  // has the final word.
  if (mode === DELTA_MODE_LINE) return delta * itemPitch;
  if (mode === DELTA_MODE_PAGE) return delta * pageSize;
  return delta;
}

/** The distance between one pet and the next, measured rather than assumed. */
export function readItemPitch(strip: HTMLElement): number {
  const [first, second] = strip.children;
  if (first instanceof HTMLElement && second instanceof HTMLElement) {
    const pitch = second.offsetLeft - first.offsetLeft;
    if (pitch > 0) return pitch;
  }
  if (first instanceof HTMLElement && first.offsetWidth > 0) return first.offsetWidth;
  return FALLBACK_ITEM_PITCH;
}

export type StripGeometry = {
  /**
   * Where the strip is *heading*, which is where it already is when nothing is
   * in flight.
   *
   * Asked of the destination rather than the live position because the scroll
   * is animated: two notches in quick succession have to add up, and "is there
   * any further to go" has to be answered about where it will end up, not about
   * a position that is still moving.
   */
  from: number;
  scrollWidth: number;
  clientWidth: number;
  itemPitch: number;
};

/**
 * Where the strip should scroll to for this wheel event, or null to let it go.
 *
 * Knowing when *not* to take the event is most of this:
 *
 * - Nothing to scroll. A strip whose pets all fit must let the wheel through,
 *   or the sidebar stops scrolling over a strip that had no use for it.
 * - Already at that end. Once there is no further to go the event belongs to
 *   whatever is underneath again; keeping it is how a page feels stuck.
 * - A genuine horizontal wheel. Trackpads and tilt wheels send `deltaX`, and a
 *   sideways swipe should be obeyed, not reinterpreted.
 */
export function nextStripScroll(
  wheel: { deltaX: number; deltaY: number; deltaMode: number },
  strip: StripGeometry,
): number | null {
  const furthest = strip.scrollWidth - strip.clientWidth;
  if (furthest <= 0) return null;

  const sideways = Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY);
  const raw = wheelPixels(
    sideways ? wheel.deltaX : wheel.deltaY,
    wheel.deltaMode,
    strip.itemPitch,
    strip.clientWidth,
  );
  if (raw === 0) return null;

  const cap = MAX_NOTCH_ITEMS * strip.itemPitch;
  const travel = Math.max(-cap, Math.min(cap, raw));

  const next = Math.min(furthest, Math.max(0, strip.from + travel));
  return next === strip.from ? null : next;
}

/**
 * One frame of the travel: where the strip should be next, and whether it is
 * there.
 *
 * An eased approach with a floor under the step, because a fraction of a pixel
 * per frame is a scroll that stalls a couple of pixels short of where it was
 * asked to go and stays there. The floor can never overshoot: a step at least
 * as long as what remains lands exactly on the target instead.
 */
export function glideStep(current: number, target: number): { at: number; arrived: boolean } {
  const distance = target - current;
  const step = Math.sign(distance) * Math.max(1, Math.abs(distance) * SCROLL_EASE);

  if (Math.abs(distance) < SCROLL_EPSILON || Math.abs(step) >= Math.abs(distance)) {
    return { at: target, arrived: true };
  }

  return { at: current + step, arrived: false };
}
