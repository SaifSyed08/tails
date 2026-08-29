import express from 'express';

import { resolveClaudeCli } from '@/modules/chat/claude-cli.js';
import {
  hasPackageManager,
  installCli,
  INSTALL_COMMAND_TEXT,
  isInstalling,
} from '@/modules/setup/install-cli.js';
import {
  canInstallNode,
  hasNode,
  installNode,
  isInstallingNode,
  resolveNodeDownload,
} from '@/modules/setup/install-node.js';

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
        // The runtime the step above needs, reported separately because the
        // answers genuinely differ: a machine can have node and not npm, and
        // the panel offers a different button for each.
        node: cli.found ? { found: true, canInstall: false, download: null } : {
          found: await hasNode(),
          canInstall: canInstallNode(),
          // Named before it is fetched, so the panel can show the exact URL
          // next to the button that would download it.
          download: await resolveNodeDownload(),
        },
        command: INSTALL_COMMAND_TEXT,
        installing: isInstalling() || isInstallingNode(),
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

  /**
   * Installs Node itself.
   *
   * Its own route rather than a flag on the one above, because the two differ
   * in what they are allowed to do: this one reaches the network, writes a file
   * and asks Windows for elevation, and none of that should be reachable by
   * passing an unexpected body to the npm install.
   */
  router.post('/install-node', async (_req, res, next) => {
    try {
      res.json(await installNode());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
