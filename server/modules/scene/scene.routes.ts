import express from 'express';

import { sceneService } from '@/modules/scene/scene.service.js';

/**
 * What a conversation is sitting in.
 *
 * A read for clients that arrive after the scene was set, and a clear, because
 * "put it back to normal" is a thing to be able to do with a button when the
 * agent is busy or the scene is in the way. Setting is the agent's, through its
 * tool: describing what you want is the whole point of the feature.
 */
export function createSceneRouter(): express.Router {
  const router = express.Router();

  router.get('/:sessionId', (req, res) => {
    res.json({ scene: sceneService.read(req.params.sessionId) });
  });

  router.post('/:sessionId/clear', (req, res) => {
    sceneService.clear(req.params.sessionId);
    res.json({ scene: null });
  });

  return router;
}
