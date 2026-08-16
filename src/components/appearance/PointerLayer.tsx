import { useEffect, useRef, useState } from 'react';

import { refreshPointerTracking } from '@/components/appearance/pointerTokens';

/**
 * The app-drawn cursor and its trail.
 *
 * A theme cannot import a cursor image — `cursor: url(...)` is refused
 * everywhere, because a stylesheet that can name a remote resource can report
 * where the user is pointing at the resolution of every hover. What it can do
 * is pick one of the shapes the OS already draws, or ask for a shape the app
 * draws and moves with the pointer. This is the second.
 *
 * Almost all of the drawing is in `index.css`, from tokens. This component owns
 * three things CSS cannot do: knowing how many segments to put in the DOM,
 * sampling the pointer's *path* so the trail lags along it, and not running an
 * animation frame loop when there is nothing to animate.
 *
 * ## The trail is spaced by distance, not by time
 *
 * The naive implementation stores one position per frame and points segment *i*
 * at the position from *i* frames ago. It has two faults and everyone ships it
 * anyway. It is frame-rate dependent, so the same theme draws a trail half as
 * long on a 120Hz display. And when the pointer stops, every segment converges
 * on the same coordinate and the trail collapses into a bright blob that sits
 * under the stationary cursor — which is the exact moment the user is looking
 * at it.
 *
 * Sampling by distance travelled fixes both. Segment *i* sits a fixed number of
 * pixels back along the recorded path, so a fast flick draws a long trail and a
 * slow drag draws a short one, which is what a trail is supposed to mean. And
 * because the path is trimmed to a fixed window, a stationary pointer runs out
 * of path: segments with nowhere to go are hidden, the trail retracts, and when
 * the last one goes the loop stops until the mouse moves again.
 */

/** How many frames of path to keep. At 60Hz this is about half a second of movement. */
const HISTORY_FRAMES = 40;

/** Segments the CSS falloff can hide, so the DOM count never has to change with the theme. */
const MAX_SEGMENTS = 16;

/** Frames with nothing left to draw before the loop gives up and waits for a move. */
const IDLE_FRAMES = 3;

type DrawnPointer = { cursor: boolean; segments: number; click: boolean };

const OFF: DrawnPointer = { cursor: false, segments: 0, click: false };

/** What the current theme has asked for, read back from the resolved tokens. */
function readDrawnPointer(): DrawnPointer {
  if (typeof document === 'undefined') return OFF;

  const computed = getComputedStyle(document.documentElement);
  const cursor = computed.getPropertyValue('--t-pointer-image').trim() !== 'none';
  const trail = computed.getPropertyValue('--t-trail-image').trim() !== 'none';

  // Reduced motion removes the trail entirely rather than slowing it: a trail
  // is autonomous movement that continues after the pointer has passed, which
  // is precisely what the preference is about. The cursor itself stays, because
  // it tracks the user's own hand.
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const length = Number.parseFloat(computed.getPropertyValue('--t-trail-length'));

  return {
    cursor,
    segments: trail && !reduced && Number.isFinite(length)
      ? Math.min(MAX_SEGMENTS, Math.max(0, Math.round(length)))
      : 0,
    click: !reduced && computed.getPropertyValue('--t-click-image').trim() !== 'none',
  };
}

export function PointerLayer() {
  const [drawn, setDrawn] = useState<DrawnPointer>(OFF);
  const trailRef = useRef<HTMLDivElement>(null);

  // Re-read the tokens whenever the appearance changes.
  useEffect(() => {
    const read = () => {
      setDrawn(readDrawnPointer());
      // The pointer writer is gated on someone reading its output, and a theme
      // that just switched a drawn cursor on or off is exactly that changing.
      refreshPointerTracking();
    };

    read();
    window.addEventListener('tails:appearance-changed', read);

    // The theme restored on boot arrives from a `fetch` that dispatches no
    // event — `AppearanceContext` fires `tails:appearance-changed` for pushed
    // changes only. Rather than reach into that file, this re-reads a few times
    // over the first couple of seconds and then stops. Three `getComputedStyle`
    // calls per mount is not a cost worth avoiding; a cursor that only appears
    // after the next theme change is a bug worth avoiding.
    const timers = [250, 800, 2000].map((delay) => window.setTimeout(read, delay));

    return () => {
      window.removeEventListener('tails:appearance-changed', read);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);

  // The trail's own frame loop, mounted only while there is a trail to draw.
  useEffect(() => {
    if (drawn.segments === 0) return undefined;

    const container = trailRef.current;
    if (!container) return undefined;

    const nodes = [...container.children] as HTMLElement[];
    const computed = getComputedStyle(document.documentElement);
    const segment = Number.parseFloat(computed.getPropertyValue('--t-trail-size')) || 12;
    const gap = Math.max(6, segment * 0.7);

    // `--t-trail-radius: 0` is the pixel kind. Squares are the only shape that
    // looks wrong on a fractional pixel — a circle at x=104.3 is a circle, a
    // square at x=104.3 is a blurry square — so the same token that squares the
    // segment off also puts it on a grid. Snapping a round trail would only
    // make it stutter.
    const radius = computed.getPropertyValue('--t-trail-radius').trim();
    const snap = radius === '0' || radius === '0px' ? Math.max(2, Math.round(segment)) : 0;
    const quantise = (value: number): number => (snap ? Math.round(value / snap) * snap : value);

    const path: { x: number; y: number }[] = [];
    let latest: { x: number; y: number } | null = null;
    let frame = 0;
    let idle = 0;

    const place = (node: HTMLElement, point: { x: number; y: number } | null) => {
      if (!point) {
        // Inline `opacity` beats the CSS falloff while it is set and defers to
        // it the moment it is cleared, so hiding a segment needs no class and
        // no second source of truth about how faint it should be.
        node.style.opacity = '0';
        return;
      }
      node.style.opacity = '';
      node.style.translate = `${quantise(point.x)}px ${quantise(point.y)}px`;
    };

    const draw = () => {
      frame = 0;
      if (!latest) return;

      path.push(latest);
      if (path.length > HISTORY_FRAMES) path.shift();

      // Walk backwards along the recorded path, dropping a segment every `gap`
      // pixels. Running out of path is the normal case for a slow or stopped
      // pointer, and the segments left over are hidden rather than stacked.
      let placed = 0;
      let travelled = 0;
      for (let index = path.length - 1; index > 0 && placed < nodes.length; index -= 1) {
        const from = path[index];
        const to = path[index - 1];
        travelled += Math.hypot(from.x - to.x, from.y - to.y);

        while (placed < nodes.length && travelled >= (placed + 1) * gap) {
          place(nodes[placed], to);
          placed += 1;
        }
      }
      for (let index = placed; index < nodes.length; index += 1) place(nodes[index], null);

      // Nothing drawn for several frames means the pointer has stopped and the
      // trail has finished retracting. Stop scheduling; the next move restarts.
      idle = placed === 0 ? idle + 1 : 0;
      if (idle < IDLE_FRAMES) frame = window.requestAnimationFrame(draw);
    };

    const onMove = (event: PointerEvent) => {
      latest = { x: event.clientX, y: event.clientY };
      idle = 0;
      if (!frame) frame = window.requestAnimationFrame(draw);
    };

    // A pointer that leaves the window has no position, and a trail frozen
    // mid-air at the edge is worse than no trail.
    const onLeave = () => {
      path.length = 0;
      for (const node of nodes) place(node, null);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);

    return () => {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [drawn.segments]);

  // Click feedback. No React state and no listener at all unless a theme asked
  // for it: each ripple is a bare element that removes itself when its
  // animation ends, so nothing is in the tree between clicks.
  useEffect(() => {
    if (!drawn.click) return undefined;

    const onDown = (event: PointerEvent) => {
      const ripple = document.createElement('div');
      ripple.className = 't-click';
      ripple.setAttribute('aria-hidden', 'true');
      ripple.style.translate = `${event.clientX}px ${event.clientY}px`;
      // `once` and `remove` together, so a ripple whose animation never fires
      // an end event (a display change mid-flight, say) still cannot pile up.
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
      document.body.appendChild(ripple);
    };

    window.addEventListener('pointerdown', onDown, { passive: true });
    return () => window.removeEventListener('pointerdown', onDown);
  }, [drawn.click]);

  if (!drawn.cursor && drawn.segments === 0) return null;

  return (
    <>
      {drawn.segments > 0 ? (
        <div ref={trailRef} aria-hidden>
          {Array.from({ length: drawn.segments }, (_, index) => (
            <span
              key={index}
              className="t-trail-segment"
              // Written once, at mount. Everything the segment looks like is
              // derived from it in CSS, so the frame loop never touches size or
              // opacity — only position.
              style={{ '--seg-index': index, opacity: 0 } as React.CSSProperties}
            />
          ))}
        </div>
      ) : null}

      {drawn.cursor ? <div className="t-pointer" aria-hidden /> : null}
    </>
  );
}
