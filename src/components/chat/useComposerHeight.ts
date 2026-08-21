import { useCallback, useEffect, type RefObject } from 'react';

/**
 * The input box grows with what is being written, up to a limit.
 *
 * ## Why this is not `rows`
 *
 * A textarea's `rows` is its *fixed* height. `rows={1}` with a CSS
 * `max-height` — which is what this was — gives a one-line box that scrolls
 * internally: a fifth line pushes the first one out of sight, so the thing you
 * are composing is mostly invisible while you compose it. Nothing about that is
 * visible from the outside either; the box looks deliberately small rather than
 * broken.
 *
 * So the height is measured instead. `scrollHeight` is the height the content
 * *wants*, which is the only number that accounts for wrapping — pressing Enter
 * is not the only way to reach a second line, and counting newlines would miss
 * every long paragraph.
 *
 * ## The cap is in lines, not pixels
 *
 * Ten lines of *this* text, at whatever size and leading the current theme has
 * chosen. A pixel cap is a line count that changes when the user picks a bigger
 * font or a generated theme sets a looser leading, and there is no reason for
 * "ten lines" to mean eight in one theme and thirteen in another. Past the cap
 * it scrolls, which is the right behaviour for something already large enough to
 * read comfortably.
 */

/** Lines the box may grow to before it starts scrolling instead. */
export const MAX_LINES = 10;

/**
 * Keeps a textarea exactly as tall as its content, to a limit.
 *
 * Returns the measure function as well as running it, because the height has to
 * be re-derived on anything that changes wrapping — a resize, a font finishing
 * loading, the draft being replaced from outside — and the caller knows about
 * those before this does.
 */
export function useComposerHeight(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): () => void {
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    const styles = window.getComputedStyle(el);

    /*
      A `line-height` of `normal` computes to the string, not a number, so it
      cannot be read directly. Falling back to a multiple of the font size is
      the same approximation the browser makes, and it only ever applies to a
      theme that has not set a leading.
    */
    const parsed = Number.parseFloat(styles.lineHeight);
    const lineHeight = Number.isFinite(parsed)
      ? parsed
      : Number.parseFloat(styles.fontSize) * 1.5;

    // `box-sizing: border-box` here, so the cap has to include the padding and
    // borders that `scrollHeight` is measured against.
    const chrome = Number.parseFloat(styles.paddingTop)
      + Number.parseFloat(styles.paddingBottom)
      + Number.parseFloat(styles.borderTopWidth)
      + Number.parseFloat(styles.borderBottomWidth);

    const cap = Math.round(lineHeight * MAX_LINES + chrome);

    /*
      Reset first, and this is not superstition: `scrollHeight` is the content
      height *or the element height, whichever is larger*, so measuring without
      collapsing it first can only ever report the height it already has. That
      is a box that grows and never shrinks — delete four lines and it stays
      four lines tall.
    */
    el.style.height = 'auto';
    const wanted = el.scrollHeight;

    el.style.height = `${Math.min(wanted, cap)}px`;
    // Only when it is actually full. A permanent `auto` leaves a scrollbar
    // gutter reserved in some themes, which reads as the box being misaligned.
    el.style.overflowY = wanted > cap ? 'auto' : 'hidden';
  }, [ref]);

  // On every change of the text, which is the ordinary case.
  useEffect(measure, [measure, value]);

  /*
   * And on anything else that changes how the text wraps.
   *
   * The width is the one that matters and it changes without the value
   * changing: opening the browser panel narrows the composer, and every line
   * that was borderline rewraps. A font arriving late does the same thing.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    document.fonts?.ready.then(measure).catch(() => {});

    return () => observer.disconnect();
  }, [ref, measure]);

  return measure;
}
