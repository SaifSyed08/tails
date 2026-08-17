import express from 'express';

import { resolveClaudeCli } from '@/modules/chat/claude-cli.js';

/**
 * What the chat module answers about itself.
 *
 * The conversation-instructions endpoints that used to live here moved to the
 * preferences module, which is the right home for them — they belong to the
 * user rather than to a conversation. This route did not move with them and
 * should not have: whether there is a CLI to drive is a fact about the chat
 * runtime, not a setting anybody chose.
 *
 * It is registered separately for that reason. Folding it into preferences
 * would have made "is the agent available" look like a preference, and putting
 * it under `/api/sessions` would have implied it varies per conversation.
 */
export function createChatRouter(): express.Router {
  const router = express.Router();

  /**
   * Whether there is a Claude Code CLI to drive.
   *
   * Asked at startup rather than discovered on the first message. Without the
   * CLI this app has no agent at all, and finding that out by typing a sentence
   * and getting an error back is the difference between "you need to install
   * one more thing" and "this is broken".
   *
   * Cheap enough to be a plain GET: a hit is a cached path plus one `stat`, and
   * a miss is half a dozen. Re-asking after installing Claude Code therefore
   * works without restarting anything.
   */
  router.get('/cli', (_req, res) => {
    res.json(resolveClaudeCli());
  });

  return router;
}
