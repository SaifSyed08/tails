import express from 'express';

import { readSurface } from '@/modules/surface/surface.service.js';

/**
 * What a conversation currently has on its surface.
 *
 * One endpoint, and it exists for exactly one moment: a client that arrives
 * after the panel was built. Everything else travels as a broadcast, because a
 * panel that only updates when something asks is a panel that is wrong between
 * asks — and polling for it would undo the point of a monitor.
 */
export function createSurfaceRouter(): express.Router {
  const router = express.Router();

  router.get('/:sessionId', (req, res) => {
    res.json({ surface: readSurface(req.params.sessionId) });
  });

  return router;
}
