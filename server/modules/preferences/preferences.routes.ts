import express from 'express';

import {
  CONVERSATION_INSTRUCTIONS_MAX_LENGTH,
  readConversationInstructions,
  writeConversationInstructions,
} from '@/modules/chat/conversation-instructions.js';
import { readDefaultVoice, writeDefaultVoice } from '@/modules/preferences/default-voice.js';

/**
 * Settings that belong to the user rather than to a conversation.
 *
 * One router for all of them, which is the whole point of the module. The
 * alternative — each feature hanging its own preference off its own API — is
 * how an app ends up with the voice default under `/api/chat` because that is
 * where the last preference happened to land, and it is why the conversation
 * instructions endpoint moved here rather than being joined by a second
 * mechanism.
 *
 * The per-turn knobs are *not* here and should not move here: permission mode,
 * model and effort travel on the send frame beside the message they affect,
 * because they are decisions about that message. The test is whether you would
 * expect the setting to survive into a brand new chat.
 *
 * Each preference's own module owns its shape, its defaults and its clamps.
 * This file is transport: parse, call, format.
 */
export function createPreferencesRouter(): express.Router {
  const router = express.Router();

  const respond = (operation: (req: express.Request) => unknown) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        res.json(operation(req));
      } catch (error) {
        next(error);
      }
    };

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

  router.get('/conversation-instructions', respond(() => instructions(readConversationInstructions())));

  // Every write answers with what was *stored*, not with what was sent, so a
  // value the server trimmed or clamped comes back and the control ends up
  // showing what will actually be used.
  router.put('/conversation-instructions', respond((req) => (
    instructions(writeConversationInstructions(req.body?.instructions))
  )));

  router.get('/default-voice', respond(() => ({ voice: readDefaultVoice() })));

  router.put('/default-voice', respond((req) => ({ voice: writeDefaultVoice(req.body?.voice) })));

  return router;
}
