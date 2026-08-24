import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  DENSITIES,
  LIMITS,
  PALETTES,
  SCENE_LAYERS,
  SPEEDS,
  sceneService,
} from '@/modules/scene/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * Letting the agent decide what the app is sitting in.
 *
 * The descriptions here carry more weight than usual. A model that has never
 * been told the window has a *behind* will keep answering "make it feel like a
 * summer afternoon" with a colour scheme, because a colour scheme is the only
 * thing it knows how to change — which is exactly the failure the appearance
 * tools were written to name and fix once already.
 */

const textResult = (payload: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const failureResult = (error: unknown) => {
  if (error instanceof AppError) {
    return textResult({ ok: false, error: error.message, issues: error.details }, true);
  }
  return textResult(
    { ok: false, error: error instanceof Error ? error.message : String(error) },
    true,
  );
};

const speed = z.enum(SPEEDS).optional()
  .describe('How fast it moves. "still" is a painting; "brisk" is weather. Slow is almost always right for something that sits behind someone working.');
const density = z.enum(DENSITIES).optional().describe('How much of it there is.');
const palette = z.enum(PALETTES).optional()
  .describe('"theme" — the default — takes its colours from the look the user is currently running, so the scene belongs to their app rather than sitting on top of it. Name a specific palette only when the request is about a time of day or a mood the theme does not carry.');

const scene = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clouds'), speed, density, palette, celestial: z.boolean().optional() })
    .describe('A sky with clouds drifting across it, and a sun or moon. The answer to "sunshine", "a summer afternoon", "make it calmer".'),
  z.object({ kind: z.literal('stars'), speed, density, palette, shooting: z.boolean().optional() })
    .describe('A starfield, with the occasional shooting star. Night, space, quiet, late.'),
  z.object({
    kind: z.literal('grid'),
    speed,
    palette,
    horizon: z.enum(['low', 'mid', 'high']).optional(),
    glow: z.enum(['soft', 'neon']).optional(),
  }).describe('A perspective grid running to a horizon. Cyberpunk, synthwave, Tron, "make it hacky", "make it look like the eighties".'),
  z.object({ kind: z.literal('rain'), density, palette, lightning: z.boolean().optional() })
    .describe('Rain on the window, optionally with lightning. Cosy, moody, focused.'),
  z.object({
    kind: z.literal('meadow'),
    palette,
    flowers: density,
    critters: z.boolean().optional(),
  }).describe('Grass and flowers along the bottom of the window, with birds and small animals wandering through. The other half of "sunshine and rainbows" — pair it with clouds only by choosing one; there is one scene at a time.'),
  z.object({
    kind: z.literal('voxel'),
    speed,
    palette,
    relief: z.enum(['flat', 'rolling', 'mountains']).optional(),
  }).describe('Blocky terrain scrolling past in the middle distance. The answer to "make it Minecraft".'),
  z.object({ kind: z.literal('snake') }).describe('Playable snake. Arrow keys or WASD.'),
  z.object({ kind: z.literal('pong') }).describe('Playable pong against the machine. Up and down, or the mouse.'),
  z.object({
    kind: z.literal('custom'),
    title: z.string().describe('What it is, in a few words. Shown on the frame, because the user should always know what they are looking at.'),
    html: z.string().describe(`A complete little page: markup, styles and script, up to ${LIMITS.customHtml} characters. Write it as though for a blank document — include your own <style> and <script>.`),
  }).describe([
    'Anything the list above cannot express: a specific game, a simulation, a visualiser, a 3D scene of your own in WebGL or CSS.',
    'It runs in a sandboxed frame with no access to this app and no network at all — no fetch, no external images, no fonts, no storage. Everything it needs must be in the markup you write. Inline SVG and data: URLs work; a URL to anything on the internet does not, and will silently draw nothing.',
    "Prefer a named scene when one fits. It will look like it belongs here, it starts instantly, and it follows the theme the user is running; yours will not unless you make it.",
  ].join(' ')),
]);

export const SCENE_ALLOWED_TOOLS = [
  'mcp__tails-scene__scene_set',
  'mcp__tails-scene__scene_clear',
];

export function createSceneServer(sessionId: string) {
  const setTool = tool(
    'scene_set',
    [
      'Put this conversation in a scene: scenery behind the whole interface, or something to play with in the corner.',
      'This is a different question from how the app *looks*. Colour, shape and motion are the appearance tools; this is what is behind and beside all of it — weather, a horizon, a landscape going past, a game in the empty space. When someone asks for an atmosphere rather than a colour scheme, they mean this, and answering with a palette is the failure to avoid.',
      'One scene at a time, per conversation, and setting a new one replaces it. It survives a restart, so treat it as something the user is choosing rather than something you are demonstrating.',
      'Scenery goes behind and is never clickable; a game goes in the corner. The two are refused the other way round rather than quietly moved.',
    ].join(' '),
    {
      sessionId: z.string().describe('The conversation this belongs to.'),
      layer: z.enum(SCENE_LAYERS).describe('"behind" for scenery, "corner" for something to play with.'),
      scene,
    },
    async (input) => {
      try {
        const next = sceneService.set(input.sessionId || sessionId, {
          layer: input.layer,
          scene: input.scene,
        });
        return textResult({ ok: true, revision: next.revision, kind: next.scene.kind });
      } catch (error) {
        return failureResult(error);
      }
    },
  );

  const clearTool = tool(
    'scene_clear',
    'Put the window back to plain. Do this when asked, and when a scene has outlived what it was for — scenery nobody chose is clutter that follows them into every message.',
    { sessionId: z.string() },
    async (input) => {
      sceneService.clear(input.sessionId || sessionId);
      return textResult({ ok: true });
    },
  );

  return createSdkMcpServer({
    name: 'tails-scene',
    version: '1.0.0',
    tools: [setTool, clearTool],
  });
}
