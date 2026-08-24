import { scenesRepository } from '@/db/scenes.repository.js';
import { readScene, type Scene } from '@/modules/scene/scene-spec.js';
import { appBroadcast } from '@/shared/broadcast.js';
import { createMessage } from '@/shared/utils.js';

/**
 * What each conversation is sitting in.
 *
 * One scene per conversation, replaced whole. Two backgrounds at once is not a
 * richer picture, it is two pictures — and layering them would make "make it
 * rain" a question about what it was raining on before.
 *
 * Kept in memory and on disk for the same reason surfaces are: the live copy is
 * what a broadcast carries, and the row is what makes "make it sunshine and
 * rainbows" a setting rather than a demo.
 */
const scenes = new Map<string, Scene & { revision: number }>();

export const readCurrentScene = (sessionId: string): (Scene & { revision: number }) | null =>
  scenes.get(sessionId) ?? scenesRepository.read(sessionId) ?? null;

function publish(sessionId: string, scene: (Scene & { revision: number }) | null): void {
  appBroadcast.publish(createMessage('scene_changed', 'app', {
    content: JSON.stringify({ sessionId, scene }),
  }));
}

export const sceneService = {
  read: readCurrentScene,

  /**
   * Puts a conversation in a scene.
   *
   * Validated here rather than at the tool, because the HTTP route reaches this
   * too and a second opinion about what a valid scene is would eventually be a
   * different opinion.
   */
  set(sessionId: string, input: unknown): Scene & { revision: number } {
    const scene = readScene(input);
    const previous = readCurrentScene(sessionId);
    const next = { ...scene, revision: (previous?.revision ?? 0) + 1 };

    scenes.set(sessionId, next);
    scenesRepository.write(sessionId, scene, next.revision);
    publish(sessionId, next);
    return next;
  },

  /** Back to a plain window. Idempotent. */
  clear(sessionId: string): void {
    scenes.delete(sessionId);
    scenesRepository.remove(sessionId);
    publish(sessionId, null);
  },

  /** Drops scenery whose conversation is gone. Called at startup. */
  prune(): number {
    return scenesRepository.prune();
  },
};
