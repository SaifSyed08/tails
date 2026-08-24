import { z } from 'zod';

import { AppError } from '@/shared/utils.js';

/**
 * The world the app is sitting in.
 *
 * Three systems now decide what T.A.I.L.S. looks like, and they are separate
 * because they answer different questions. **Appearance** is how the interface
 * is drawn — colour, shape, motion, the surfaces themselves. **Surfaces** are
 * panels of data the agent composes beside a conversation. This is the third:
 * what is *behind* and *beside* all of it. Clouds drifting past. A neon grid
 * running to the horizon. A game of snake in the empty corner.
 *
 * None of that is expressible as a theme, because a theme has no time axis and
 * nothing to update, and none of it is a widget, because a widget reports and
 * these things simply exist.
 *
 * ## Two ways in, and the second one is the interesting one
 *
 * The **library** is a closed union: named scenes this app knows how to draw,
 * configured by enums. Fast, consistent, themed, and impossible to get wrong —
 * the same doctrine the theme spec and the widget spec follow.
 *
 * The **custom** kind is an escape hatch that runs agent-authored HTML, CSS and
 * JavaScript. That is a real departure from the widget rule, which refuses
 * markup outright, and it is allowed here for a reason that does not apply
 * there: this content is not in the app's document. It renders inside a
 * sandboxed iframe with no same-origin access and a content policy that permits
 * no network at all, so it cannot read the page, cannot reach the app's
 * storage, cannot phone anywhere, and cannot navigate anything.
 *
 * The sandbox is the boundary — not a sanitiser. Nothing here inspects the
 * markup, because a validator that also tried to police what the code *means*
 * would be a second, weaker boundary that eventually disagrees with the real
 * one. See `CustomScene.tsx` for the attributes that make it true, and for the
 * separate rule that stops a custom scene impersonating the app's own UI.
 */

/** Everything the app can draw on its own. Adding one means adding a renderer. */
export const SCENE_KINDS = [
  'clouds', 'stars', 'grid', 'rain', 'meadow', 'voxel', 'snake', 'pong', 'custom',
] as const;
export type SceneKind = typeof SCENE_KINDS[number];

/**
 * Where a scene sits.
 *
 * `behind` is full-bleed, under the whole interface, and never takes a click —
 * it is scenery. `corner` is a small framed card in the empty space beside the
 * conversation, and it may be played with.
 *
 * The distinction is load-bearing rather than cosmetic. Something interactive
 * spread across the whole window would sit between the user and their work, and
 * something decorative confined to a card is a decoration nobody sees.
 */
export const SCENE_LAYERS = ['behind', 'corner'] as const;
export type SceneLayer = typeof SCENE_LAYERS[number];

export const SPEEDS = ['still', 'slow', 'drifting', 'brisk'] as const;
export const DENSITIES = ['sparse', 'some', 'thick'] as const;

/**
 * Palettes, including one that is not a palette.
 *
 * `theme` resolves to the appearance system's own tokens at draw time, so a
 * scene follows whatever look the user last asked for. It is the default for
 * everything that can take it, because a background that fights the interface
 * in front of it is worse than no background.
 */
export const PALETTES = ['theme', 'dawn', 'day', 'dusk', 'night', 'candy', 'mono'] as const;

export const LIMITS = {
  /** Characters of agent-authored markup. Enough for a real toy, not a bundle. */
  customHtml: 24_000,
  title: 60,
} as const;

const speed = z.enum(SPEEDS).default('slow');
const density = z.enum(DENSITIES).default('some');
const palette = z.enum(PALETTES).default('theme');

const clouds = z.object({
  kind: z.literal('clouds'),
  speed,
  density,
  palette,
  /** A sun or moon, depending on the palette. */
  celestial: z.boolean().default(true),
});

const stars = z.object({
  kind: z.literal('stars'),
  speed,
  density,
  palette,
  shooting: z.boolean().default(true),
});

const grid = z.object({
  kind: z.literal('grid'),
  speed,
  palette,
  /** How far up the window the vanishing point sits. */
  horizon: z.enum(['low', 'mid', 'high']).default('mid'),
  glow: z.enum(['soft', 'neon']).default('neon'),
});

const rain = z.object({
  kind: z.literal('rain'),
  density,
  palette,
  lightning: z.boolean().default(false),
});

const meadow = z.object({
  kind: z.literal('meadow'),
  palette,
  /** Grass, flowers and the odd bird wandering along the bottom. */
  flowers: density,
  critters: z.boolean().default(true),
});

const voxel = z.object({
  kind: z.literal('voxel'),
  speed,
  palette,
  /** How tall the terrain gets. */
  relief: z.enum(['flat', 'rolling', 'mountains']).default('rolling'),
});

const snake = z.object({ kind: z.literal('snake') });
const pong = z.object({ kind: z.literal('pong') });

const custom = z.object({
  kind: z.literal('custom'),
  /** Named, because a sandboxed frame has to say what it is. See the renderer. */
  title: z.string().min(1).max(LIMITS.title),
  html: z.string().min(1).max(LIMITS.customHtml),
});

const sceneSchema = z.discriminatedUnion('kind', [
  clouds, stars, grid, rain, meadow, voxel, snake, pong, custom,
]);

export type SceneBody = z.infer<typeof sceneSchema>;

/** Kinds that are scenery, and may only be scenery. */
const AMBIENT: ReadonlySet<SceneKind> = new Set(['clouds', 'stars', 'grid', 'rain', 'meadow', 'voxel']);
/** Kinds that are played with, and so must be reachable by a pointer. */
const PLAYABLE: ReadonlySet<SceneKind> = new Set(['snake', 'pong']);

export const sceneRequestSchema = z.object({
  layer: z.enum(SCENE_LAYERS),
  scene: sceneSchema,
});

export type Scene = z.infer<typeof sceneRequestSchema>;

/** Formats validation failures as dotted paths, the way the other specs do. */
function toValidationError(issues: readonly { path: PropertyKey[]; message: string }[]): AppError {
  return new AppError('The scene did not match the schema.', {
    code: 'SCENE_INVALID',
    statusCode: 422,
    details: issues.map((issue) => ({
      path: issue.path.map(String).join('.') || 'root',
      message: issue.message,
    })),
  });
}

/**
 * Validates a scene, including the pairing the schema alone cannot express.
 *
 * A game behind the interface cannot be clicked, and a sky inside a small
 * framed card is a postage stamp of sky. Both are refused rather than silently
 * relocated: an agent that asked for the wrong one should learn which, and a
 * request quietly moved to the other layer is a request that was not honoured.
 */
export function readScene(input: unknown): Scene {
  const result = sceneRequestSchema.safeParse(input);
  if (!result.success) throw toValidationError(result.error.issues);

  const { layer, scene } = result.data;

  if (layer === 'behind' && PLAYABLE.has(scene.kind)) {
    throw toValidationError([{
      path: ['layer'],
      message: `${scene.kind} is played with, so it has to be in the corner where a pointer can reach it. Scenery goes behind.`,
    }]);
  }

  if (layer === 'corner' && AMBIENT.has(scene.kind)) {
    throw toValidationError([{
      path: ['layer'],
      message: `${scene.kind} is scenery — put it behind the interface. The corner is for something to play with.`,
    }]);
  }

  return result.data;
}
