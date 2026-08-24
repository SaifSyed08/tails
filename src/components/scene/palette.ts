import type { PaletteName } from '@/types/scene';

/**
 * The five colours every scene is drawn from.
 *
 * Deliberately few. A scene that could name a colour per element would be a
 * scene the agent has to art-direct, and the ones it produced would clash with
 * whatever look the user is running — the same reason widgets take a tone
 * rather than a hex. Five roles is enough for a sky with a sun in it, and few
 * enough that a palette can be stated in a line.
 */
export type ScenePalette = {
  /** Top and bottom of the backdrop gradient. */
  sky: [string, string];
  /** Things in the foreground: near clouds, grass, the front of the grid. */
  near: string;
  /** The same things further away. Distance is drawn with colour, not blur. */
  far: string;
  /** The sun, the neon, a flower. One bright thing per scene. */
  accent: string;
  /** Silhouettes — a bird, a tree, a blade of grass against the light. */
  ink: string;
};

const FIXED: Record<Exclude<PaletteName, 'theme'>, ScenePalette> = {
  dawn: {
    sky: ['#2b2352', '#f0a07a'],
    near: '#f5c6a5',
    far: '#8f7aa8',
    accent: '#ffd9a0',
    ink: '#2a2340',
  },
  day: {
    sky: ['#4aa3e8', '#bfe4f7'],
    near: '#ffffff',
    far: '#cfe6f5',
    accent: '#fff2b8',
    ink: '#26506b',
  },
  dusk: {
    sky: ['#1b2a4a', '#e2734a'],
    near: '#f0a878',
    far: '#5c5480',
    accent: '#ffb46b',
    ink: '#171f33',
  },
  night: {
    sky: ['#050914', '#131b34'],
    near: '#8fa3d8',
    far: '#3a4568',
    accent: '#cfe0ff',
    ink: '#020408',
  },
  candy: {
    sky: ['#ffd7ef', '#c9e9ff'],
    near: '#ffffff',
    far: '#ffc2e2',
    accent: '#ffe36e',
    ink: '#a05a86',
  },
  mono: {
    sky: ['#0d0d0d', '#1c1c1c'],
    near: '#d8d8d8',
    far: '#5a5a5a',
    accent: '#ffffff',
    ink: '#000000',
  },
};

/**
 * Reads one of the appearance system's tokens.
 *
 * They are stored as bare HSL components — `220 14% 8%` — so that Tailwind can
 * wrap them with an alpha. Wrapping them here is the same trick from the other
 * end, and it is what lets a canvas, which knows nothing about custom
 * properties, paint in the user's current theme.
 */
function token(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value ? `hsl(${value})` : fallback;
}

/**
 * The scene's colours, resolved now.
 *
 * `theme` is the default and the interesting one: it pulls from the tokens the
 * appearance pipeline derived and contrast-solved, so scenery follows whatever
 * look was last asked for instead of sitting on top of it like a wallpaper
 * somebody else chose. It is read at draw time rather than stored, so a theme
 * changed while a scene is running is picked up on the next frame.
 */
export function resolvePalette(name: PaletteName): ScenePalette {
  if (name !== 'theme') return FIXED[name];

  return {
    sky: [token('--background', '#0d0f14'), token('--card', '#151922')],
    near: token('--muted-foreground', '#8b93a7'),
    far: token('--border', '#2a303d'),
    accent: token('--primary', '#6ea8ff'),
    ink: token('--foreground', '#e6e9f0'),
  };
}

/** Scene speeds as a multiplier. `still` is a painting, not a paused animation. */
export const SPEED_SCALE: Record<string, number> = {
  still: 0,
  slow: 0.4,
  drifting: 1,
  brisk: 2.2,
};

/** How many of a thing a density asks for, against a per-scene base count. */
export const DENSITY_SCALE: Record<string, number> = {
  sparse: 0.45,
  some: 1,
  thick: 2,
};
