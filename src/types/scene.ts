/**
 * The world a conversation is sitting in, as the client receives it.
 *
 * Mirrors `server/modules/scene/scene-spec.ts`, which is the authority: it
 * validates, it applies the defaults, and it is what refuses a game behind the
 * interface. The same arrangement `src/types/surface.ts` has with the widget
 * spec.
 *
 * Every option is required here even though the tool makes them optional,
 * because by the time a scene reaches this file the server has filled them in.
 * A renderer that had to cope with `speed` being absent would be a renderer
 * carrying a second copy of the defaults.
 */

export type Speed = 'still' | 'slow' | 'drifting' | 'brisk';
export type Density = 'sparse' | 'some' | 'thick';
export type PaletteName = 'theme' | 'dawn' | 'day' | 'dusk' | 'night' | 'candy' | 'mono';
export type SceneLayer = 'behind' | 'corner';

export type SceneBody =
  | { kind: 'clouds'; speed: Speed; density: Density; palette: PaletteName; celestial: boolean }
  | { kind: 'stars'; speed: Speed; density: Density; palette: PaletteName; shooting: boolean }
  | {
    kind: 'grid';
    speed: Speed;
    palette: PaletteName;
    horizon: 'low' | 'mid' | 'high';
    glow: 'soft' | 'neon';
  }
  | { kind: 'rain'; density: Density; palette: PaletteName; lightning: boolean }
  | { kind: 'meadow'; palette: PaletteName; flowers: Density; critters: boolean }
  | {
    kind: 'voxel';
    speed: Speed;
    palette: PaletteName;
    relief: 'flat' | 'rolling' | 'mountains';
  }
  | { kind: 'snake' }
  | { kind: 'pong' }
  | { kind: 'custom'; title: string; html: string };

/** The scenery kinds, which are the ones drawn on a canvas behind everything. */
export type AmbientScene = Extract<
  SceneBody,
  { kind: 'clouds' | 'stars' | 'grid' | 'rain' | 'meadow' | 'voxel' }
>;

export type Scene = {
  layer: SceneLayer;
  scene: SceneBody;
  /** Increments on every write, so a client can tell a change from a repeat. */
  revision: number;
};
