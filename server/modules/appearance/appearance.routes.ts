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

  // The freeform layer. Ephemeral and separate from /apply on purpose: it is a
  // different trust level, and routing it through the same endpoint would make
  // that impossible to see from the outside.
  router.post('/css', respond((req) => (
    themeService.applyFreeformCss(req.body?.css, readString(req.body?.sessionId) ?? '')
  )));

  router.delete('/css', respond((req) => {
    themeService.clearFreeformCss(readString(req.query.sessionId) ?? '');
    return { ok: true };
  }));

  // "Keep this one." Separate from /apply because applying binds a look and
  // this promotes it — a user can want either without the other.
  router.post('/keep', respond((req) => themeService.keepCurrent(
    String(req.body?.name ?? ''),
    readString(req.body?.sessionId) ?? '',
  )));

  // The live-controls layer. Ephemeral like /css and separate from it because
  // it adopts no stylesheet at all — it publishes the knobs, and the renderer
  // writes single custom properties as the user drags them.
  // The payload is rebuilt rather than forwarded: the control schema is strict,
  // and `sessionId` rides in the same body as transport rather than as content.
  router.post('/controls', respond((req) => themeService.publishControls(
    { title: req.body?.title, controls: req.body?.controls },
    readString(req.body?.sessionId) ?? '',
  )));

  router.delete('/controls', respond((req) => {
    themeService.clearControls(readString(req.query.sessionId) ?? '');
    return { ok: true };
  }));

  // A proposal takes itself off screen when a theme lands, so this exists for
  // the case where the user decided against both and nothing was applied.
  router.delete('/proposal', respond((req) => {
    themeService.clearProposal(readString(req.query.sessionId) ?? '');
    return { ok: true };
  }));

  router.post('/unbind', respond((req) => {
    const scope = req.body?.scope === 'session' ? 'session' : 'global';
    themeService.unbind(scope, readString(req.body?.sessionId) ?? '');
    return { ok: true };
  }));

  router.patch('/themes/:themeId', respond((req) => (
    themeService.renameTheme(String(req.params.themeId), String(req.body?.name ?? ''))
  )));

  router.delete('/themes/:themeId', respond((req) => (
    themeService.deleteTheme(String(req.params.themeId))
  )));

  return router;
}
