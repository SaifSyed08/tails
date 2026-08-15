import express from 'express';

import { themeService } from '@/modules/appearance/theme.service.js';
import { readString } from '@/shared/utils.js';

/** Thin transport around the theme service. */
export function createAppearanceRouter(): express.Router {
  const router = express.Router();

  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        res.json(await operation(req));
      } catch (error) {
        next(error);
      }
    };

  router.get('/themes', respond(() => themeService.listThemes()));

  // What the renderer asks for on boot, before anything is streamed to it.
  router.get('/resolve', respond((req) => (
    themeService.resolveAppearance(readString(req.query.sessionId) ?? undefined)
  )));

  router.post('/preview', respond((req) => {
    const compiled = themeService.previewTheme(req.body?.spec, readString(req.body?.sessionId) ?? '');
    return { name: compiled.spec.name, contrast: compiled.contrast };
  }));

  router.post('/apply', respond((req) => {
    const scope = req.body?.scope === 'session' ? 'session' : 'global';
    const themeId = readString(req.body?.themeId);
    const resolvedId = themeId ?? themeService.saveTheme(req.body?.spec, 'saved').id;
    return themeService.applyTheme(resolvedId, scope, readString(req.body?.sessionId) ?? '');
  }));

  router.post('/unbind', respond((req) => {
    const scope = req.body?.scope === 'session' ? 'session' : 'global';
    themeService.unbind(scope, readString(req.body?.sessionId) ?? '');
    return { ok: true };
  }));

  router.delete('/themes/:themeId', respond((req) => (
    themeService.deleteTheme(String(req.params.themeId))
  )));

  return router;
}
