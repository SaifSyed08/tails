import express from 'express';

import { surfaceService } from '@/modules/surface/surface.service.js';

/**
 * The panel beside a conversation.
 *
 * The read exists for one moment: a client arriving after the panel was built.
 * Everything else travels as a broadcast, because a panel that only updates
 * when something asks is a panel that is wrong between asks — and polling for a
 * monitor would undo the point of one.
 *
 * Pinning is here rather than on the agent's tool surface on purpose. "Follow me
 * into my other conversations" is a decision about the user's own screen, and
 * nothing the model can see tells it whether that is wanted.
 */
export function createSurfaceRouter(): express.Router {
  const router = express.Router();

  router.get('/:sessionId', (req, res) => {
    res.json(surfaceService.read(req.params.sessionId));
  });

  router.post('/:sessionId/pin', (req, res) => {
    surfaceService.pin(req.params.sessionId);
    res.json(surfaceService.read(req.params.sessionId));
  });

  router.post('/:sessionId/unpin', (req, res) => {
    surfaceService.unpin(req.params.sessionId);
    res.json(surfaceService.read(req.params.sessionId));
  });

  return router;
}
