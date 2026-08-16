import express from 'express';
import fs from 'node:fs';

import { renderDesktopWindowHtml } from '@/modules/pets/desktop-window.js';
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

  // Registered before `/:petId` so a pet can never shadow them.
  router.get('/catalogue', respond((req) => petsService.listRemoteCatalogue({
    page: req.query.page === undefined ? undefined : Number(req.query.page),
    pageSize: req.query.pageSize === undefined ? undefined : Number(req.query.pageSize),
    query: typeof req.query.q === 'string' ? req.query.q : undefined,
  })));

  /**
   * Downloads one catalogue pet and installs it.
   *
   * Takes an id and nothing else. A body carrying a URL would make this a
   * general-purpose fetcher pointed at our own network, so the URL is resolved
   * server-side from what the catalogue advertised.
   */
  router.post('/catalogue/:petId/install', respond(
    (req) => petsService.installFromCatalogue(String(req.params.petId)),
  ));

  /**
   * Proxies the two catalogue images.
   *
   * Here so the renderer makes no third-party requests: the marketplace shows
   * remote artwork without the remote host ever seeing the user. `poster` is a
   * single cell and `strip` is the filmstrip — two routes rather than one
   * "preview", because conflating them is what put a row of 57 sprites in a
   * card.
   */
  for (const kind of ['poster', 'strip'] as const) {
    router.get(`/catalogue/:petId/${kind}`, async (req, res, next) => {
      try {
        const image = await petsService.fetchCatalogueImage(String(req.params.petId), kind);
        res.setHeader('Content-Type', image.contentType);
        res.setHeader('Content-Length', String(image.bytes.byteLength));
        // Long and immutable-ish: these are versioned in their upstream URL,
        // and a browsing session revisits the same page constantly.
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.end(image.bytes);
      } catch (error) {
        next(error);
      }
    });
  }

  /**
   * Which pet a surface should render.
   *
   * `?sessionPetId=` is the conversation's assignment, if it has one. The
   * precedence and the dangling-reference handling live in the service so every
   * caller gets the same answer; this route exists so a caller does not have to
   * be on the server to ask.
   */
  /** Which conversation has which pet, for surfaces showing many rows at once. */
  router.get('/assignments', respond(() => petsService.listAssignments()));

  router.get('/display', respond((req) => petsService.resolveDisplayPet(
    typeof req.query.sessionPetId === 'string' ? req.query.sessionPetId : null,
    typeof req.query.sessionId === 'string' ? req.query.sessionId : null,
  )));

  /**
   * The desktop pet's page.
   *
   * Served rather than bundled so the always-on-top window has a URL that works
   * the same in development and in a packaged build, with no second renderer
   * entry point to configure. It is a whole document, so it answers HTML rather
   * than going through `respond`.
   */
  router.get('/window', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderDesktopWindowHtml());
  });

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

  /** Starring, which decides where a pet sits in the carousel. */
  router.post('/:petId/starred', respond((req) => petsService.setPetStarred(
    String(req.params.petId),
    req.body?.starred !== false,
  )));

  /** How the pet is shown where he stands: his size, and whether he wanders. */
  router.post('/:petId/stage', respond((req) => petsService.setPetStage(
    String(req.params.petId),
    req.body,
  )));

  /** "This pet was chosen" — assignment lives in another module, the tally lives here. */
  router.post('/:petId/used', respond((req) => petsService.markPetUsed(String(req.params.petId))));

  /** Hiding is the only "remove" available for a pet Codex owns. */
  router.post('/:petId/hidden', respond((req) => petsService.setPetHidden(
    String(req.params.petId),
    req.body?.hidden !== false,
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
