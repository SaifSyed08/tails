import express from 'express';

import { downloadVoice, readSpeechStatus, synthesise } from '@/modules/voice/piper.js';
import { writeKey } from '@/modules/voice/cloud-transcribe.js';
import { activeProvider, readTranscriptionStatus, writeSettings } from '@/modules/voice/transcription.js';
import { downloadModel, MODEL_MIB } from '@/modules/voice/whisper.js';
import { bytesNeeded, downloadWakeWord } from '@/modules/voice/wake-download.js';
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

  /**
   * Whether the microphone button works, according to whichever engine is on.
   *
   * Answers for the *selected* provider rather than for the local one. The two
   * fail for different reasons and with different fixes — a missing model is a
   * download, a missing key is a paste — and reporting one obstacle while the
   * user is blocked by the other is worse than reporting nothing.
   */
  router.get('/status', (_req, res) => {
    const provider = activeProvider();
    const local = readTranscriptionStatus().local;

    res.json({
      ready: provider.ready,
      reason: provider.reason,
      provider: provider.id,
      supportsPartials: provider.supportsPartials,
      // Kept for the download button, which is about the local model whichever
      // provider happens to be selected.
      modelPresent: local.modelPresent,
      enginePresent: local.enginePresent,
      downloadMiB: local.downloadMiB,
    });
  });

  /** Everything the settings panel needs. Never includes the key itself. */
  router.get('/transcription', (_req, res) => {
    res.json(readTranscriptionStatus());
  });

  /**
   * Chooses the engine.
   *
   * Switching to `openai` is the moment audio starts leaving the machine, so it
   * is a deliberate write from a control that says so — never inferred, and
   * never a fallback from a local failure.
   */
  router.post('/transcription', (req, res, next) => {
    try {
      const body = req.body as { provider?: unknown; cloudModel?: unknown };
      const next_ = writeSettings({
        provider: body.provider === 'openai' ? 'openai' : body.provider === 'local' ? 'local' : undefined,
        cloudModel: typeof body.cloudModel === 'string' ? body.cloudModel as never : undefined,
      });
      res.json({ ...readTranscriptionStatus(), provider: next_.provider });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Saves or clears the key.
   *
   * Write-only by design: there is no route that returns it. The response is
   * the same status everything else reads, so the panel can confirm a save
   * without the value ever making the return trip.
   */
  router.post('/transcription/key', (req, res, next) => {
    try {
      const body = req.body as { key?: unknown };
      const key = typeof body.key === 'string' ? body.key : '';

      // A rough shape check, so a pasted mistake is caught here rather than as
      // a 401 several seconds into the first sentence.
      if (key && !key.startsWith('sk-')) {
        throw new AppError(
          'That does not look like an OpenAI key — they begin with "sk-".',
          { code: 'voice.badKey', statusCode: 400 },
        );
      }

      writeKey(key);
      res.json(readTranscriptionStatus());
    } catch (error) {
      next(error);
    }
  });

  /**
   * Whether wake-word listening can run, and which words are installed.
   *
   * Separate from `/status` because the two fail independently: the wake-word
   * runtime is an optional native package that is normally absent, and its
   * absence must never make dictation look broken.
   */
  /**
   * Wake-word state, enriched with what each word would cost to install.
   *
   * The size is composed here rather than inside `readWakeWordStatus` because
   * the downloader imports the definitions, and having the definitions import
   * the downloader back would be a cycle. The route is the natural place for
   * the two to meet.
   */
  router.get('/wake', (_req, res) => {
    const status = readWakeWordStatus();
    res.json({
      ...status,
      words: status.words.map((word) => ({
        ...word,
        downloadBytes: bytesNeeded(word.id),
      })),
    });
  });

  /**
   * Fetches one wake word's models. Explicit, one-time, never on boot.
   *
   * The size is in the status payload so the UI can state it *before* this is
   * called — a download has to be a visible decision, which means the number
   * is on screen while the user is deciding.
   */
  router.post('/wake/:id/download', async (req, res, next) => {
    try {
      await downloadWakeWord(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(new AppError(
        error instanceof Error ? error.message : 'Wake-word download failed',
        { code: 'VOICE_WAKE_DOWNLOAD_FAILED', statusCode: 502 },
      ));
    }
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
    const status = readTranscriptionStatus().local;
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

  /**
   * Whether replies can be spoken, and in whose voice.
   *
   * Separate from `/status`, which is about *hearing*. The two fail
   * independently — a machine can transcribe without a voice installed and the
   * reverse — and collapsing them would make one missing download look like
   * the whole voice feature being broken.
   */
  router.get('/speech', (_req, res) => {
    res.json(readSpeechStatus());
  });

  /** Fetches one voice. Explicit, one-time, never on boot. */
  router.post('/speech/voice/:id/download', async (req, res, next) => {
    try {
      await downloadVoice(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(new AppError(
        error instanceof Error ? error.message : 'Voice download failed',
        { code: 'VOICE_TTS_DOWNLOAD_FAILED', statusCode: 502 },
      ));
    }
  });

  /**
   * Turns text into audio.
   *
   * A POST returning `audio/wav` rather than a URL to a stored file: the audio
   * is worth exactly one playback and keeping it would mean deciding when to
   * delete somebody's synthesised speech. It never touches disk beyond the
   * length of the subprocess call — the same rule dictation follows for the
   * microphone.
   */
  router.post('/speech/say', async (req, res, next) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const voice = typeof req.body?.voice === 'string' ? req.body.voice : undefined;

    if (!text.trim()) {
      next(new AppError('Nothing to say', { code: 'VOICE_TTS_EMPTY', statusCode: 400 }));
      return;
    }

    try {
      const wav = await synthesise(text, voice);
      res.type('audio/wav').send(wav);
    } catch (error) {
      next(new AppError(
        error instanceof Error ? error.message : 'Speech synthesis failed',
        { code: 'VOICE_TTS_FAILED', statusCode: 500 },
      ));
    }
  });

  return router;
}
