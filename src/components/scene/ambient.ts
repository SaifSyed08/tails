import { DENSITY_SCALE, resolvePalette, SPEED_SCALE, type ScenePalette } from '@/components/scene/palette';
import type { AmbientScene } from '@/types/scene';

/**
 * The scenery, drawn on a canvas behind everything.
 *
 * ## Why canvas, and why no 3D library
 *
 * Every scene here is 2D drawing with a perspective trick where one is needed —
 * the grid converges, the voxel terrain is isometric. That is a deliberate
 * ceiling. A real 3D renderer is a few hundred kilobytes and a second geometry
 * system to maintain, and the six things people actually ask for ("make it
 * calmer", "make it cyberpunk", "make it Minecraft") do not need one.
 *
 * Anything that genuinely does have the custom scene, which can run WebGL of the
 * agent's own writing inside its sandbox. The library covers the common asks
 * instantly and in the user's theme; the escape hatch covers the rest.
 *
 * ## Everything is normalised
 *
 * Positions are held as fractions of the canvas and multiplied up at draw time,
 * so a window resize moves the scenery rather than reshuffling it. Rebuilding
 * the cloud layout on every resize is the difference between weather and a
 * screensaver restarting.
 *
 * ## Time is passed in, never read
 *
 * Each `draw` takes the elapsed milliseconds. Nothing here calls `performance.now`
 * or holds a frame loop; the host owns that, which is what lets it pause the
 * whole thing when the window is hidden.
 */

export type Ambient = {
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number, elapsedMs: number) => void;
};

/** A tiny deterministic generator, so a scene looks the same each time it starts. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function backdrop(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: ScenePalette,
): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, palette.sky[0]);
  gradient.addColorStop(1, palette.sky[1]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

/** A soft blob, which is what a cloud is made of and what a glow is drawn with. */
function blob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
}

function clouds(scene: Extract<AmbientScene, { kind: 'clouds' }>): Ambient {
  const random = seeded(7);
  const count = Math.round(7 * DENSITY_SCALE[scene.density]);
  const speed = SPEED_SCALE[scene.speed];

  // Three depths. Parallax is the whole of what makes a flat sky read as one
  // you could fly through: near clouds are bigger, paler and faster.
  const puffs = Array.from({ length: count }, () => {
    const depth = random();
    return {
      x: random(),
      y: 0.06 + random() * 0.45,
      scale: 0.5 + depth * 1.1,
      depth,
      lobes: Array.from({ length: 4 }, () => ({
        dx: (random() - 0.5) * 1.4,
        dy: (random() - 0.5) * 0.5,
        r: 0.5 + random() * 0.6,
      })),
    };
  });

  return {
    draw(ctx, width, height, elapsed) {
      const palette = resolvePalette(scene.palette);
      backdrop(ctx, width, height, palette);

      if (scene.celestial) {
        const cx = width * 0.78;
        const cy = height * 0.2;
        const r = Math.min(width, height) * 0.06;
        // The glow first, as three widening discs. A radial gradient would be
        // smoother and costs a gradient object per frame for a shape nobody
        // looks directly at.
        for (let ring = 3; ring >= 1; ring -= 1) {
          ctx.globalAlpha = 0.06 * ring;
          blob(ctx, cx, cy, r * (1 + ring * 0.7), palette.accent);
        }
        ctx.globalAlpha = 1;
        blob(ctx, cx, cy, r, palette.accent);
      }

      for (const puff of puffs) {
        const drift = (elapsed / 1000) * speed * (0.006 + puff.depth * 0.014);
        const x = ((puff.x + drift) % 1.25 - 0.125) * width;
        const y = puff.y * height;
        const unit = Math.min(width, height) * 0.055 * puff.scale;

        ctx.globalAlpha = 0.16 + puff.depth * 0.3;
        ctx.fillStyle = puff.depth > 0.5 ? palette.near : palette.far;
        for (const lobe of puff.lobes) {
          blob(ctx, x + lobe.dx * unit * 1.6, y + lobe.dy * unit, lobe.r * unit, ctx.fillStyle);
        }
      }
      ctx.globalAlpha = 1;
    },
  };
}

function stars(scene: Extract<AmbientScene, { kind: 'stars' }>): Ambient {
  const random = seeded(19);
  const count = Math.round(140 * DENSITY_SCALE[scene.density]);
  const speed = SPEED_SCALE[scene.speed];

  const field = Array.from({ length: count }, () => ({
    x: random(),
    y: random(),
    r: 0.4 + random() * 1.3,
    // Each star twinkles on its own clock, or the whole sky pulses together.
    phase: random() * Math.PI * 2,
    rate: 0.5 + random() * 1.5,
  }));

  return {
    draw(ctx, width, height, elapsed) {
      const palette = resolvePalette(scene.palette);
      backdrop(ctx, width, height, palette);

      const seconds = elapsed / 1000;
      for (const star of field) {
        const drift = seconds * speed * 0.004;
        const x = ((star.x + drift) % 1) * width;
        ctx.globalAlpha = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(star.phase + seconds * star.rate));
        blob(ctx, x, star.y * height, star.r, palette.near);
      }

      if (scene.shooting) {
        // One every twelve seconds, crossing in under one. Derived from the
        // clock rather than scheduled, so it cannot drift or double up.
        const cycle = 12_000;
        const into = elapsed % cycle;
        if (into < 900) {
          const progress = into / 900;
          const seed = seeded(Math.floor(elapsed / cycle) + 1);
          const startX = 0.2 + seed() * 0.6;
          const startY = 0.05 + seed() * 0.35;
          const length = 0.09;
          ctx.globalAlpha = Math.sin(progress * Math.PI);
          ctx.strokeStyle = palette.accent;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo((startX + progress * 0.25) * width, (startY + progress * 0.18) * height);
          ctx.lineTo((startX + progress * 0.25 - length) * width, (startY + progress * 0.18 - length * 0.7) * height);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    },
  };
}

function grid(scene: Extract<AmbientScene, { kind: 'grid' }>): Ambient {
  const speed = SPEED_SCALE[scene.speed];
  const horizonAt = { low: 0.68, mid: 0.55, high: 0.42 }[scene.horizon];

  return {
    draw(ctx, width, height, elapsed) {
      const palette = resolvePalette(scene.palette);
      backdrop(ctx, width, height, palette);

      const horizon = height * horizonAt;
      const vanishX = width / 2;

      ctx.save();
      if (scene.glow === 'neon') {
        ctx.shadowBlur = 12;
        ctx.shadowColor = palette.accent;
      }
      ctx.strokeStyle = palette.accent;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;

      // The rails. Evenly spaced along the bottom edge, all meeting the
      // vanishing point — which is what makes a flat fan read as a floor.
      for (let i = -14; i <= 14; i += 1) {
        ctx.beginPath();
        ctx.moveTo(vanishX, horizon);
        ctx.lineTo(vanishX + i * (width / 8), height);
        ctx.stroke();
      }

      /*
        The sleepers, and the reason this looks like movement.

        Spaced by a squared progression rather than evenly: lines near the
        horizon must crowd together and lines near the viewer must spread apart,
        or the floor reads as a ladder lying flat. The scroll offset runs inside
        one gap and wraps, so the pattern is continuous however long it runs.
      */
      const scroll = ((elapsed / 1000) * speed * 0.35) % 1;
      for (let i = 0; i < 18; i += 1) {
        const t = (i + scroll) / 18;
        const y = horizon + (height - horizon) * t * t;
        ctx.globalAlpha = 0.12 + 0.5 * t;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // A band of light along the horizon, so the two halves meet in something
      // rather than simply stopping.
      ctx.globalAlpha = 0.25;
      const glow = ctx.createLinearGradient(0, horizon - height * 0.12, 0, horizon);
      glow.addColorStop(0, 'transparent');
      glow.addColorStop(1, palette.accent);
      ctx.fillStyle = glow;
      ctx.fillRect(0, horizon - height * 0.12, width, height * 0.12);
      ctx.restore();
      ctx.globalAlpha = 1;
    },
  };
}

function rain(scene: Extract<AmbientScene, { kind: 'rain' }>): Ambient {
  const random = seeded(31);
  const count = Math.round(120 * DENSITY_SCALE[scene.density]);

  const drops = Array.from({ length: count }, () => ({
    x: random(),
    y: random(),
    length: 0.02 + random() * 0.05,
    speed: 0.55 + random() * 0.9,
  }));

  return {
    draw(ctx, width, height, elapsed) {
      const palette = resolvePalette(scene.palette);
      backdrop(ctx, width, height, palette);

      const seconds = elapsed / 1000;

      if (scene.lightning) {
        // A double flash every nine seconds or so — one strike is a glitch, two
        // is weather.
        const into = elapsed % 9_000;
        const flash = into < 90 ? 1 - into / 90 : into > 200 && into < 260 ? 0.5 : 0;
        if (flash > 0) {
          ctx.globalAlpha = flash * 0.35;
          ctx.fillStyle = palette.accent;
          ctx.fillRect(0, 0, width, height);
          ctx.globalAlpha = 1;
        }
      }

      ctx.strokeStyle = palette.near;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.35;
      for (const drop of drops) {
        const y = ((drop.y + seconds * drop.speed * 0.35) % 1.1 - 0.05) * height;
        // A slight lean, shared by every drop, because rain falls in a wind
        // rather than each drop choosing its own.
        const x = drop.x * width + y * 0.07;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - drop.length * height * 0.07, y - drop.length * height);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
  };
}

function meadow(scene: Extract<AmbientScene, { kind: 'meadow' }>): Ambient {
  const random = seeded(53);
  const bladeCount = 90;
  const flowerCount = Math.round(14 * DENSITY_SCALE[scene.flowers]);

  const blades = Array.from({ length: bladeCount }, () => ({
    x: random(),
    height: 0.05 + random() * 0.07,
    lean: (random() - 0.5) * 0.5,
    phase: random() * Math.PI * 2,
  }));
  const flowers = Array.from({ length: flowerCount }, () => ({
    x: random(),
    height: 0.04 + random() * 0.05,
    phase: random() * Math.PI * 2,
  }));
  /** Two of them, offset in time, so the meadow is never quite empty or busy. */
  const critters = [{ offset: 0 }, { offset: 0.55 }];

  return {
    draw(ctx, width, height, elapsed) {
      const palette = resolvePalette(scene.palette);
      backdrop(ctx, width, height, palette);

      const seconds = elapsed / 1000;
      const ground = height * 0.97;

      if (scene.critters) {
        /*
          Drawn before the grass so they walk *through* it rather than on top,
          which is most of what sells a silhouette as being in a place.
        */
        for (const critter of critters) {
          const cycle = 26;
          const t = ((seconds / cycle) + critter.offset) % 1;
          const x = t * (width + 80) - 40;
          const bob = Math.abs(Math.sin(seconds * 6)) * 2;
          const y = ground - height * 0.035 - bob;
          const size = Math.min(width, height) * 0.011;

          ctx.globalAlpha = 0.75;
          ctx.fillStyle = palette.ink;
          // Body, head, and a beak. Three shapes is enough to read as a bird at
          // this size; a fourth is detail nobody sees behind a conversation.
          ctx.beginPath();
          ctx.ellipse(x, y, size * 1.6, size, 0, 0, Math.PI * 2);
          ctx.fill();
          blob(ctx, x + size * 1.3, y - size * 0.9, size * 0.7, palette.ink);
          ctx.beginPath();
          ctx.moveTo(x + size * 1.9, y - size * 0.9);
          ctx.lineTo(x + size * 2.9, y - size * 0.7);
          ctx.lineTo(x + size * 1.9, y - size * 0.5);
          ctx.fill();
          // Legs, alternating, so it is walking rather than hovering.
          ctx.strokeStyle = palette.ink;
          ctx.lineWidth = Math.max(1, size * 0.25);
          for (const leg of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(x + leg * size * 0.4, y + size * 0.8);
            ctx.lineTo(x + leg * size * 0.4 + Math.sin(seconds * 6 + leg) * size * 0.6, ground);
            ctx.stroke();
          }
        }
      }

      // The bank of grass, then individual blades over it. The band stops the
      // blades reading as hairs on a bare gradient.
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = palette.far;
      ctx.fillRect(0, ground - height * 0.03, width, height * 0.06);

      ctx.strokeStyle = palette.ink;
      ctx.lineWidth = 1.4;
      ctx.globalAlpha = 0.55;
      for (const blade of blades) {
        const sway = Math.sin(seconds * 1.1 + blade.phase) * 0.012;
        const x = blade.x * width;
        ctx.beginPath();
        ctx.moveTo(x, ground);
        ctx.quadraticCurveTo(
          x + (blade.lean + sway) * width * 0.02,
          ground - blade.height * height * 0.6,
          x + (blade.lean + sway) * width * 0.04,
          ground - blade.height * height,
        );
        ctx.stroke();
      }

      for (const flower of flowers) {
        const sway = Math.sin(seconds * 1.3 + flower.phase) * 0.01;
        const x = flower.x * width + sway * width * 0.03;
        const y = ground - flower.height * height;
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = palette.ink;
        ctx.beginPath();
        ctx.moveTo(flower.x * width, ground);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.globalAlpha = 0.85;
        blob(ctx, x, y, Math.min(width, height) * 0.005, palette.accent);
      }
      ctx.globalAlpha = 1;
    },
  };
}

function voxel(scene: Extract<AmbientScene, { kind: 'voxel' }>): Ambient {
  const speed = SPEED_SCALE[scene.speed];
  const amplitude = { flat: 0.6, rolling: 1.6, mountains: 3.2 }[scene.relief];
  /** Columns across the window. Wider than the view, so it can scroll in. */
  const columns = 46;

  /** A repeating, seamless height field. Sines, so the terrain never has a join. */
  const heightAt = (index: number): number => {
    const a = Math.sin(index * 0.31) * 1.0;
    const b = Math.sin(index * 0.13 + 1.7) * 1.4;
    const c = Math.sin(index * 0.71 + 0.4) * 0.4;
    return Math.max(0, Math.round((a + b + c) * amplitude));
  };

  return {
    draw(ctx, width, height, elapsed) {
      const palette = resolvePalette(scene.palette);
      backdrop(ctx, width, height, palette);

      const block = width / (columns * 0.62);
      const scroll = (elapsed / 1000) * speed * block * 0.35;
      const baseline = height * 0.82;

      /*
        Isometric cubes, back to front.

        Three faces per block — top, left, right — at three brightnesses. That
        shading *is* the three-dimensionality: the same three quadrilaterals in
        one colour read as a flat mosaic, which is the whole difference between
        this and a tiled background.
      */
      for (let i = 0; i < columns; i += 1) {
        const worldIndex = Math.floor(scroll / block) + i;
        const stack = heightAt(worldIndex);
        const x = i * block * 0.62 - (scroll % block);
        const depth = i / columns;

        for (let level = 0; level <= stack; level += 1) {
          const y = baseline - level * block * 0.45 - depth * height * 0.06;
          const w = block * 0.62;
          const h = block * 0.45;

          // Top
          ctx.fillStyle = level === stack ? palette.accent : palette.near;
          ctx.globalAlpha = level === stack ? 0.55 : 0.35;
          ctx.beginPath();
          ctx.moveTo(x, y - h * 0.5);
          ctx.lineTo(x + w * 0.5, y - h);
          ctx.lineTo(x + w, y - h * 0.5);
          ctx.lineTo(x + w * 0.5, y);
          ctx.closePath();
          ctx.fill();

          // Left face, then right, each a step darker.
          ctx.fillStyle = palette.far;
          ctx.globalAlpha = 0.45;
          ctx.beginPath();
          ctx.moveTo(x, y - h * 0.5);
          ctx.lineTo(x + w * 0.5, y);
          ctx.lineTo(x + w * 0.5, y + h * 0.5);
          ctx.lineTo(x, y);
          ctx.closePath();
          ctx.fill();

          ctx.fillStyle = palette.ink;
          ctx.globalAlpha = 0.35;
          ctx.beginPath();
          ctx.moveTo(x + w, y - h * 0.5);
          ctx.lineTo(x + w * 0.5, y);
          ctx.lineTo(x + w * 0.5, y + h * 0.5);
          ctx.lineTo(x + w, y);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    },
  };
}

/**
 * Builds the renderer for a scenery kind.
 *
 * A total record over the ambient kinds, so a kind added to the spec without a
 * renderer is a compile error rather than a blank window — the same property
 * the widget registry has.
 */
export function createAmbient(scene: AmbientScene): Ambient {
  switch (scene.kind) {
    case 'clouds': return clouds(scene);
    case 'stars': return stars(scene);
    case 'grid': return grid(scene);
    case 'rain': return rain(scene);
    case 'meadow': return meadow(scene);
    case 'voxel': return voxel(scene);
  }
}
