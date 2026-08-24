import { useEffect, useRef } from 'react';

import { createAmbient } from '@/components/scene/ambient';
import { useReducedMotion } from '@/shared/ui/Motion';
import type { AmbientScene } from '@/types/scene';

/**
 * The canvas the scenery is drawn on, and the frame loop that drives it.
 *
 * Owns everything about *when* to draw so `ambient.ts` can own only *what*:
 * device pixels, resizing, and the three cases where the right number of frames
 * per second is zero.
 *
 * ## It stops when nobody is looking
 *
 * A background animation is the easiest thing in an app to leave running on a
 * laptop in a bag. Three separate guards, because they are three different
 * situations:
 *
 * - **Reduced motion** draws one frame and stops. The scene is still there and
 *   still the one that was asked for; it simply does not move. Removing it
 *   entirely would take away a choice the user made.
 * - **A hidden window** pauses. `requestAnimationFrame` already throttles in a
 *   background tab, but the Electron window can be visible-but-occluded and
 *   `document.hidden` is what catches that.
 * - **A still scene** never schedules a second frame at all.
 */
export function AmbientCanvas({ scene }: { scene: AmbientScene }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const ambient = createAmbient(scene);
    let frame = 0;
    let width = 0;
    let height = 0;
    const started = performance.now();

    /*
      Device pixels, capped at two.

      A 4K display would otherwise ask for four times the fill rate to draw
      clouds nobody is looking directly at, and the difference between 2x and 3x
      on soft shapes is not visible.
    */
    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const paint = (elapsed: number) => {
      ctx.clearRect(0, 0, width, height);
      ambient.draw(ctx, width, height, elapsed);
    };

    // `still` and reduced motion agree on the same thing by different routes:
    // draw the scene once, correctly, and then leave it alone.
    const animated = !reduced && !('speed' in scene && scene.speed === 'still');

    const loop = () => {
      if (document.hidden) {
        // Not rescheduled — the visibility listener starts it again. A loop
        // that keeps calling itself to do nothing is still a loop.
        frame = 0;
        return;
      }
      paint(performance.now() - started);
      frame = requestAnimationFrame(loop);
    };

    const start = () => {
      if (frame !== 0 || !animated) return;
      frame = requestAnimationFrame(loop);
    };

    const onVisibility = () => {
      if (document.hidden) return;
      // One frame immediately, so an app brought back into view is not blank
      // for as long as it takes the next animation frame to arrive.
      resize();
      paint(performance.now() - started);
      start();
    };

    const observer = new ResizeObserver(() => {
      resize();
      paint(performance.now() - started);
    });
    observer.observe(canvas);

    resize();
    paint(0);
    start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [scene, reduced]);

  return <canvas ref={canvasRef} className="size-full" aria-hidden="true" />;
}
