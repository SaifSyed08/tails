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
  )));

  router.post('/', respond((req) => sessionsService.createSession({
    cwd: readString(req.body?.cwd) ?? undefined,
    title: readString(req.body?.title) ?? undefined,
  })));

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
    const cwd = readString(req.body?.cwd);
    if (cwd) return sessionsService.setWorkingDirectory(sessionId, cwd);
    return sessionsService.renameSession(sessionId, readString(req.body?.title) ?? 'Untitled');
  }));

  router.get('/:sessionId/commands', respond(async (req) => {
    const session = sessionsService.getSession(String(req.params.sessionId));
    return listSlashCommands(session.cwd);
  }));

  router.delete('/:sessionId', respond((req) => sessionsService.deleteSession(
    String(req.params.sessionId),
  )));

  return router;
}
