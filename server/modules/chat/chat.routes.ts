import express from 'express';

import {
  CONVERSATION_INSTRUCTIONS_MAX_LENGTH,
  readConversationInstructions,
  writeConversationInstructions,
} from '@/modules/chat/conversation-instructions.js';

/**
 * The chat module's settings surface.
 *
 * Not on `/api/sessions`, and that is the scope decision made visible: these
 * instructions belong to the user, not to one conversation. The knobs that are
 * per conversation — permission mode, model, effort — already travel on the
 * send frame beside the message they affect, and a preference the user would
 * have to retype in every new chat is not a preference.
 */
export function createChatRouter(): express.Router {
  const router = express.Router();

  /**
   * The cap travels with the value rather than being restated in the client.
   *
   * The counter in Settings and the clamp on write are then the same number by
   * construction, so a field that stops accepting keystrokes and a save that
   * silently truncates can never be two different limits.
   */
  const instructions = (value: string) => ({
    instructions: value,
    maxLength: CONVERSATION_INSTRUCTIONS_MAX_LENGTH,
  });

  router.get('/instructions', (_req, res) => {
    res.json(instructions(readConversationInstructions()));
  });

  // The response carries what was stored, not what was sent, so a paste over
  // the cap comes back trimmed and the field ends up showing the text that will
  // actually reach the model.
  router.put('/instructions', (req, res) => {
    res.json(instructions(writeConversationInstructions(req.body?.instructions)));
  });

  return router;
}
