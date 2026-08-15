import express from 'express';
import fs from 'node:fs';

import { petsService } from '@/modules/pets/pets.service.js';

/** Thin transport around the pets service: parse, call, format. */
export function createPetsRouter(): express.Router {
  const router = express.Router();

  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        res.json(await operation(req));
      } catch (error) {
        next(error);
      }
    };

  // Registered before `/:petId` so a pet can never shadow it.
  router.get('/catalogue', respond((req) => petsService.listRemoteCatalogue(
    req.query.limit === undefined ? undefined : Number(req.query.limit),
  )));

  router.get('/', respond(() => petsService.listPets()));

  router.post('/import', respond((req) => petsService.importPet(req.body)));

  router.get('/:petId', respond((req) => petsService.getPet(String(req.params.petId))));

  router.patch('/:petId', respond((req) => petsService.updatePet(
    String(req.params.petId),
    req.body,
  )));

  router.post('/:petId/activate', respond((req) => petsService.setActivePet(
    req.body?.active === false ? null : String(req.params.petId),
  )));

  router.delete('/:petId', respond((req) => petsService.removePet(String(req.params.petId))));

  /**
   * Streams a pet's spritesheet.
   *
   * Streamed rather than buffered because these are multi-megabyte lossless
   * WebPs and the gallery asks for all of them at once. The service has already
   * proven the path is inside the pet's own directory.
   */
  router.get('/:petId/sprite', (req, res, next) => {
    try {
      const sprite = petsService.resolveSprite(String(req.params.petId));

      res.setHeader('Content-Type', sprite.contentType);
      res.setHeader('Content-Length', String(sprite.byteLength));
      // Short and revalidated: the bytes rarely change, but re-importing a pet
      // under the same id must not leave a stale sheet on screen.
      res.setHeader('Cache-Control', 'private, max-age=60');

      fs.createReadStream(sprite.filePath)
        .on('error', next)
        .pipe(res);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
