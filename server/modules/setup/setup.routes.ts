import express from 'express';

import { resolveClaudeCli } from '@/modules/chat/claude-cli.js';
import {
  hasPackageManager,
  installCli,
  INSTALL_COMMAND_TEXT,
  isInstalling,
} from '@/modules/setup/install-cli.js';

/**
 * First run, when the thing this app drives is not there yet.
 *
 * Deliberately its own module rather than another route on `/api/chat`: this is
 * about the machine, not about a conversation, and it has to work in exactly
 * the state where nothing about chat does.
 */
export function createSetupRouter(): express.Router {
  const router = express.Router();

  router.get('/', async (_req, res, next) => {
    try {
      const cli = resolveClaudeCli();
      res.json({
        cli: {
          found: cli.found,
          reason: cli.found ? null : cli.reason,
          installUrl: cli.found ? null : cli.installUrl,
        },
        // Only asked when it matters. Spawning a probe on every poll of a
        // healthy install is a process per second for an answer nobody needs.
        packageManager: cli.found ? true : await hasPackageManager(),
        command: INSTALL_COMMAND_TEXT,
        installing: isInstalling(),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Runs the install.
   *
   * Answers when it is over rather than immediately: the output streams over
   * the broadcast while it runs, so the panel is never waiting on this response
   * to show progress, and having it carry the verdict means there is one place
   * that decides whether it worked.
   */
  router.post('/install-cli', async (_req, res, next) => {
    try {
      res.json(await installCli());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
