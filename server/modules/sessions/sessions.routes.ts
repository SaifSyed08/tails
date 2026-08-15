import express from 'express';

import { listSlashCommands } from '@/modules/chat/commands.service.js';
import { sessionsService } from '@/modules/sessions/sessions.service.js';
import { readString } from '@/shared/utils.js';

/** Thin transport around the sessions service: parse, call, format. */
export function createSessionsRouter(): express.Router {
  const router = express.Router();

  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        res.json(await operation(req));
      } catch (error) {
        next(error);
      }
    };

  router.get('/', respond((req) => sessionsService.listConversations(
    Number(req.query.limit) || 50,
    { archived: req.query.archived === '1' || req.query.archived === 'true' },
  )));

  router.post('/', respond((req) => sessionsService.createSession({
    cwd: readString(req.body?.cwd) ?? undefined,
    title: readString(req.body?.title) ?? undefined,
  })));

  // Above `/:sessionId`, or Express matches "draft" as an id.
  router.get('/draft', respond(() => sessionsService.draftSession()));

  router.get('/:sessionId', respond((req) => sessionsService.getSession(String(req.params.sessionId))));

  router.get('/:sessionId/messages', respond((req) => sessionsService.getMessages(
    String(req.params.sessionId),
    {
      limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
      offset: req.query.offset === undefined ? undefined : Number(req.query.offset),
    },
  )));

  router.post('/:sessionId/adopt', respond((req) => sessionsService.adoptExternalSession(
    String(req.params.sessionId),
    readString(req.body?.cwd) ?? process.cwd(),
    readString(req.body?.title) ?? 'Imported chat',
    readString(req.body?.lastActivityAt) ?? undefined,
  )));

  router.patch('/:sessionId', respond((req) => {
    const sessionId = String(req.params.sessionId);
    if (typeof req.body?.pinned === 'boolean') {
      return sessionsService.setPinned(sessionId, req.body.pinned);
    }
    if (typeof req.body?.archived === 'boolean') {
      return sessionsService.setArchived(sessionId, req.body.archived);
    }

    // `null` is meaningful here — it is how the picker clears the assignment —
    // so the field's presence is what routes, not its truthiness.
    if ('petId' in (req.body ?? {})) {
      return sessionsService.assignPet(sessionId, readString(req.body?.petId));
    }

    const cwd = readString(req.body?.cwd);
    if (cwd) return sessionsService.setWorkingDirectory(sessionId, cwd);
    return sessionsService.renameSession(sessionId, readString(req.body?.title) ?? 'Untitled');
  }));

  router.get('/:sessionId/commands', respond(async (req) => {
    // A draft conversation has no row yet, and the composer asks for its
    // commands the moment it mounts. Falling back to the default folder gives
    // the palette something real instead of a 404 the client swallows.
    const session = sessionsService.findSession(String(req.params.sessionId));
    return listSlashCommands(session?.cwd ?? sessionsService.defaultWorkingDirectory());
  }));

  router.delete('/:sessionId', respond((req) => sessionsService.deleteSession(
    String(req.params.sessionId),
  )));

  return router;
}
