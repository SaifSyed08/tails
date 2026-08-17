import express from 'express';

import { downloadModel, MODEL_MIB, readStatus } from '@/modules/voice/whisper.js';
import { readWakeWordStatus, resolveWakeModel } from '@/modules/voice/wake-word.js';
import { AppError } from '@/shared/utils.js';

/**
 * The non-streaming half of voice: can dictation run, and fetching the model.
 *
 * Audio never touches these routes — it goes over the `/voice` websocket. This
 * exists so the microphone button can be disabled with a reason before anyone
 * presses it, and so the one download this feature performs is a route someone
 * had to call rather than something that happens on launch.
 */
export function createVoiceRouter(): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res) => {
    res.json(readStatus());
  });

  /**
   * Whether wake-word listening can run, and which words are installed.
   *
   * Separate from `/status` because the two fail independently: the wake-word
   * runtime is an optional native package that is normally absent, and its
   * absence must never make dictation look broken.
   */
  router.get('/wake', (_req, res) => {
    res.json(readWakeWordStatus());
  });

  /**
   * Serves a wake-word model to the renderer, which is where detection runs.
   *
   * Only names on the known list resolve — the renderer asks by filename, and
   * without an allow-list this route would be a way to read arbitrary files
   * out of the user's home directory.
   */
  router.get('/wake/model/:file', (req, res, next) => {
    const resolved = resolveWakeModel(req.params.file);
    if (!resolved) {
      next(new AppError('Unknown wake-word model', {
        code: 'VOICE_WAKE_MODEL_UNKNOWN', statusCode: 404,
      }));
      return;
    }

    res.type('application/octet-stream');
    res.sendFile(resolved);
  });

  /**
   * Fetches the model. Explicit, one-time, and never called on boot.
   *
   * The size is in the status payload so the UI can state it *before* this is
   * called — the requirement is that a download is a visible decision, which
   * means the number has to be on screen while the user is choosing.
   */
  router.post('/model', async (_req, res, next) => {
    const status = readStatus();
    if (status.modelPresent) {
      res.json({ ok: true, alreadyPresent: true });
      return;
    }

    try {
      await downloadModel();
      res.json({ ok: true, downloadedMiB: MODEL_MIB });
    } catch (error) {
      next(new AppError(
        error instanceof Error ? error.message : 'Model download failed',
        { code: 'VOICE_MODEL_DOWNLOAD_FAILED', statusCode: 502 },
      ));
    }
  });

  return router;
}
