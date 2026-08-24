/**
 * The scene module's front door.
 *
 * A barrel because the tools need the spec's vocabulary *and* the service, and
 * importing both by path from a file whose whole job is to describe the
 * vocabulary reads as though there were two sources for it.
 */
export {
  DENSITIES,
  LIMITS,
  PALETTES,
  SCENE_KINDS,
  SCENE_LAYERS,
  SPEEDS,
  readScene,
  type Scene,
  type SceneKind,
  type SceneLayer,
} from '@/modules/scene/scene-spec.js';
export { sceneService, readCurrentScene } from '@/modules/scene/scene.service.js';
