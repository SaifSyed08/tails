/**
 * Canvas-drawn cursor trails.
 *
 * The DOM trail in `PointerLayer` places elements, which is right for pixels
 * and dots and wrong for anything that wants a continuous stroke or a field.
 * Two effects the user asked for — the cursify rainbow ribbon and fluid
 * cursor — are canvas implementations upstream and cannot be expressed as
 * positioned divs at all. See `docs/reference/cursify-*.md` for both originals.
 *
 * ## Why the app owns the renderer
 *
 * The alternative was a canvas layer the theme could switch on and *script*.
 * That is arbitrary code execution in the renderer, and it discards every
 * guarantee this module rests on: the `url()` ban, the ephemerality that makes
 * "reload the window" a complete recovery path, and the rule textures
 * established that the app draws and the theme chooses. A theme that can run a
 * shader can do anything a script can do.
 *
 * So these are named effects, like textures and ambient motions. A theme picks
 * one and supplies its colours, width, length and strength through tokens; it
 * does not supply the code. Same trade, third time.
 *
 * ## What is faithful and what is not
 *
 * `rainbow` is a real reimplementation: a chain of points easing toward the one
 * in front, stroked once per palette colour with a per-colour vertical offset,
 * which is what stacks the strokes into a ribbon rather than overdrawing one
 * line. That is the original's actual trick.
 *
 * `fluid` is **not** a port. The original is a WebGL Navier-Stokes solver — 20
 * pressure iterations and six shader passes per frame over a 128-squared
 * velocity field and a 1440-squared dye buffer. That is a continuous GPU load
 * on an application whose job is displaying text, and the request was for
 * something much smaller and more subtle than the original anyway. This is soft
 * additive blobs seeded along the pointer path, each carrying sampled pointer
 * velocity, advected and dissipated per frame. It reads as fluid at small
 * scale. It is a look-alike, and the reference document says so plainly.
 */

export type TrailMode = 'none' | 'dom' | 'rainbow' | 'fluid';

type Blob = { x: number; y: number; vx: number; vy: number; life: number };

/** Frames with no pointer movement before the loop gives up and waits. */
const IDLE_FRAMES = 40;

type Options = {
  mode: 'rainbow' | 'fluid';
  colors: string[];
  /** Stroke width for the ribbon, blob radius for the fluid. */
  size: number;
  /** Points in the chain, or blobs alive at once. */
  length: number;
  opacity: number;
};

/**
 * Starts a canvas trail on the given element. Returns the stop function.
 *
 * The canvas is sized in device pixels and scaled back down, because a ribbon
 * drawn at CSS resolution on a 2x display is visibly soft — and softness is the
 * one thing that makes a deliberate effect look like a rendering fault.
 */
export function startTrailCanvas(canvas: HTMLCanvasElement, options: Options): () => void {
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return () => {};

  const colors = options.colors.length > 0 ? options.colors : ['#ffffff'];
  let width = 0;
  let height = 0;
  let frame = 0;
  let idle = 0;
  let time = 0;

  const pointer = { x: -1e4, y: -1e4, px: -1e4, py: -1e4, seen: false };
  const chain: { x: number; y: number }[] = [];
  const blobs: Blob[] = [];

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const drawRibbon = () => {
    // Ease every point toward the one ahead of it. The lag this produces *is*
    // the effect — a chain that snapped to the pointer would draw a straight
    // line from wherever the mouse was last frame.
    let x = pointer.x;
    let y = pointer.y;
    for (const point of chain) {
      const nextX = point.x;
      const nextY = point.y;
      point.x = x;
      point.y = y;
      x += (nextX - x) * 0.42;
      y += (nextY - y) * 0.42;
    }

    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.globalAlpha = options.opacity;

    colors.forEach((color, index) => {
      context.beginPath();
      context.strokeStyle = color;
      context.lineWidth = options.size;
      // The per-colour vertical offset is what stacks the strokes into a
      // ribbon. Without it every colour draws over the same path and only the
      // last one is visible.
      const offset = (index - (colors.length - 1) / 2) * options.size;
      chain.forEach((point, at) => {
        if (at === 0) context.moveTo(point.x, point.y + offset);
        else context.lineTo(point.x, point.y + offset);
      });
      context.stroke();
    });
    context.globalAlpha = 1;
  };

  const drawFluid = () => {
    const dx = pointer.x - pointer.px;
    const dy = pointer.y - pointer.py;
    const speed = Math.hypot(dx, dy);

    // Seed on movement only, and in proportion to it: a stationary pointer
    // should leave nothing, and a fast flick should leave more than a drift.
    if (speed > 0.5 && blobs.length < options.length) {
      blobs.push({
        x: pointer.x,
        y: pointer.y,
        vx: dx * 0.16,
        vy: dy * 0.16,
        life: 1,
      });
    }

    context.globalCompositeOperation = 'lighter';
    for (let index = blobs.length - 1; index >= 0; index -= 1) {
      const blob = blobs[index];
      blob.x += blob.vx;
      blob.y += blob.vy;
      // Standing in for the solver's VELOCITY_DISSIPATION and
      // DENSITY_DISSIPATION respectively.
      blob.vx *= 0.94;
      blob.vy *= 0.94;
      blob.life -= 0.022;
      if (blob.life <= 0) {
        blobs.splice(index, 1);
        continue;
      }

      const radius = options.size * (0.4 + blob.life * 0.6);
      const color = colors[index % colors.length];
      const gradient = context.createRadialGradient(blob.x, blob.y, 0, blob.x, blob.y, radius);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, 'transparent');
      context.globalAlpha = blob.life * blob.life * options.opacity;
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(blob.x, blob.y, radius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
  };

  const draw = () => {
    frame = 0;
    time += 1;
    context.clearRect(0, 0, width, height);

    if (options.mode === 'rainbow') drawRibbon();
    else drawFluid();

    pointer.px = pointer.x;
    pointer.py = pointer.y;

    // Stop when there is nothing left moving. An unconditional
    // `requestAnimationFrame` for the life of the page is what the upstream
    // component does and it is a battery cost with no output.
    const settled = options.mode === 'fluid'
      ? blobs.length === 0
      : idle > IDLE_FRAMES;
    idle += 1;
    if (!settled) frame = window.requestAnimationFrame(draw);
  };

  const onMove = (event: PointerEvent) => {
    if (!pointer.seen) {
      pointer.seen = true;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.px = pointer.x;
      pointer.py = pointer.y;
      for (let index = 0; index < options.length; index += 1) {
        chain.push({ x: pointer.x, y: pointer.y });
      }
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    idle = 0;
    if (!frame) frame = window.requestAnimationFrame(draw);
  };

  const onLeave = () => {
    chain.length = 0;
    blobs.length = 0;
    pointer.seen = false;
    context.clearRect(0, 0, width, height);
  };

  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', onLeave);

  return () => {
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerleave', onLeave);
    if (frame) window.cancelAnimationFrame(frame);
    context.clearRect(0, 0, width, height);
    void time;
  };
}
