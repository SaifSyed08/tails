import fs from 'node:fs';
import path from 'node:path';

import { TAILS_HOME } from '@/db/connection.js';
import {
  CLOUD_MODELS,
  hasKey,
  isCloudModel,
  keyHint,
  transcribeInCloud,
  type CloudModelId,
} from '@/modules/voice/cloud-transcribe.js';
import { buildInitialPrompt } from '@/modules/voice/vocabulary.js';
import { readStatus as readLocalStatus, transcribe as transcribeLocally } from '@/modules/voice/whisper.js';

/**
 * Which engine turns speech into text, and the one decision the caller makes.
 *
 * ## Why a provider and not a flag
 *
 * The two engines differ in more than accuracy, and the difference has to be
 * visible to the code that drives them rather than discovered by it:
 *
 * | | local (whisper.cpp) | cloud (OpenAI) |
 * |---|---|---|
 * | audio leaves the machine | never | every utterance |
 * | cost per sentence | none | billed to the user's key |
 * | live partial text | yes, by re-transcribing | no |
 *
 * That last row is the one that shapes the gateway. The local path shows words
 * as you speak by re-running the model over the growing buffer every few
 * hundred milliseconds; doing that against a paid API would bill for the same
 * sentence five times over. So `supportsPartials` is part of the provider, and
 * the gateway asks instead of assuming.
 *
 * ## Off unless chosen
 *
 * `local` is the default and there is no automatic promotion to the cloud. A
 * missing local model is reported as a missing local model — the one thing this
 * must never do is start uploading a microphone because something local was
 * unavailable.
 */

export type ProviderId = 'local' | 'openai';

export type TranscriptionSettings = {
  provider: ProviderId;
  /** Which OpenAI model, when the provider is `openai`. */
  cloudModel: CloudModelId;
};

const SETTINGS_FILE = path.join(TAILS_HOME, 'voice-provider.json');

const DEFAULTS: TranscriptionSettings = { provider: 'local', cloudModel: 'gpt-4o-transcribe' };

export function readSettings(): TranscriptionSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return DEFAULTS;

    const record = raw as Record<string, unknown>;
    const provider = record.provider === 'openai' ? 'openai' : 'local';
    const model = typeof record.cloudModel === 'string' && isCloudModel(record.cloudModel)
      ? record.cloudModel
      : DEFAULTS.cloudModel;

    return { provider, cloudModel: model };
  } catch {
    // No file, or a file somebody edited into nonsense. The default is the safe
    // one in both cases, which is the point of the default being `local`.
    return DEFAULTS;
  }
}

export function writeSettings(next: Partial<TranscriptionSettings>): TranscriptionSettings {
  const merged: TranscriptionSettings = { ...readSettings(), ...next };
  const clean: TranscriptionSettings = {
    provider: merged.provider === 'openai' ? 'openai' : 'local',
    cloudModel: isCloudModel(merged.cloudModel) ? merged.cloudModel : DEFAULTS.cloudModel,
  };

  fs.mkdirSync(TAILS_HOME, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(clean, null, 2));
  return clean;
}

export type ActiveProvider = {
  id: ProviderId;
  ready: boolean;
  /** Present only when not ready. The whole error surface for the mic button. */
  reason?: string;
  /**
   * Whether text can be shown while the user is still speaking.
   *
   * False for the cloud, and not as a limitation: partials are produced by
   * transcribing the same audio repeatedly, and each pass is a billed request.
   */
  supportsPartials: boolean;
};

/** Which provider is in effect, and whether it can actually run. */
export function activeProvider(): ActiveProvider {
  const settings = readSettings();

  if (settings.provider === 'openai') {
    return hasKey()
      ? { id: 'openai', ready: true, supportsPartials: false }
      : {
        id: 'openai',
        ready: false,
        reason: 'Cloud dictation is selected but no OpenAI key is saved. Add one in Settings.',
        supportsPartials: false,
      };
  }

  const local = readLocalStatus();
  return {
    id: 'local',
    ready: local.ready,
    reason: local.reason,
    supportsPartials: true,
  };
}

/**
 * What the settings panel needs to draw itself.
 *
 * The key is represented by its last four characters and its presence, never by
 * its value — an endpoint that can return a secret is an endpoint that will
 * eventually return it to something unintended.
 */
export function readTranscriptionStatus() {
  const settings = readSettings();
  const active = activeProvider();
  const local = readLocalStatus();

  return {
    provider: settings.provider,
    cloudModel: settings.cloudModel,
    models: CLOUD_MODELS,
    keySaved: hasKey(),
    keyHint: keyHint(),
    ready: active.ready,
    reason: active.reason,
    supportsPartials: active.supportsPartials,
    local: {
      ready: local.ready,
      reason: local.reason,
      modelPresent: local.modelPresent,
      enginePresent: local.enginePresent,
      downloadMiB: local.downloadMiB,
    },
  };
}

/**
 * Turns one utterance into text with whichever engine is selected.
 *
 * The prompt is built here rather than inside each engine so both get the same
 * vocabulary hint — the identifiers and file names of the project the user is
 * actually in, which is what stops "tsconfig" arriving as three words. The
 * local binary takes it as `--prompt`; OpenAI takes it as `prompt`.
 */
export async function transcribeUtterance(
  samples: Int16Array,
  cwd?: string | null,
): Promise<string> {
  const settings = readSettings();

  if (settings.provider === 'openai') {
    return transcribeInCloud(samples, {
      model: settings.cloudModel,
      prompt: buildInitialPrompt(cwd),
    });
  }

  return transcribeLocally(samples, cwd);
}
