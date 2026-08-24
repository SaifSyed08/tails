import { Check, Cloud, HardDrive, Radio, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { voiceApi, type TranscriptionStatus } from '@/components/voice/voice-api';
import { cn } from '@/lib/utils';

/**
 * Choosing which engine hears you, and saying what that costs.
 *
 * ## Why this screen is written the way it is
 *
 * Every other part of voice in this app was built on one promise: no audio and
 * no transcript leaves the machine. Cloud dictation breaks that promise. It is
 * here because the local model's accuracy was not good enough to use in
 * practice — but a setting that quietly starts uploading a microphone would be a
 * betrayal of the thing the rest of the feature was for.
 *
 * So the copy states the consequence rather than the benefit. "More accurate"
 * and "your voice is sent to OpenAI" are the same choice, and the user has to be
 * able to make it knowingly. The two engines are presented as a pair with the
 * trade-off on the face of each, not as a checkbox called "improve accuracy".
 *
 * The key is write-only: it goes to the server and is never read back. What
 * comes back is its last four characters, which is enough to tell two keys apart
 * and worth nothing to anyone looking over a shoulder.
 */
export function TranscriptionSettings() {
  const [status, setStatus] = useState<TranscriptionStatus | null>(null);
  const [key, setKey] = useState('');
  const [streamingKey, setStreamingKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await voiceApi.transcription().catch(() => null);
      if (!cancelled) setStatus(next);
    })();
    return () => { cancelled = true; };
  }, []);

  const run = useCallback(async (label: string, work: () => Promise<TranscriptionStatus>) => {
    setBusy(label);
    setError(null);
    try {
      setStatus(await work());
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not work.');
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  if (!status) return null;

  const cloud = status.provider === 'openai';
  const streaming = status.provider === 'assemblyai';
  const local = !cloud && !streaming;

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Speech recognition</h3>
        <p className="text-xs text-muted-foreground">
          What turns your voice into text. This is the one setting in the app that decides whether
          audio leaves the machine.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {/*
          Presented as a pair, each carrying its own trade-off. A checkbox
          labelled "better accuracy" would be the same switch with the cost
          hidden, which is exactly what this must not be.
        */}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run('provider', () => voiceApi.setTranscription({ provider: 'local' }))}
          className={cn(
            'rounded-lg border p-3 text-left transition-colors duration-quick',
            local ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent',
          )}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <HardDrive className="size-4" aria-hidden="true" />
            On this machine
            {local ? <Check className="size-3.5 text-primary" aria-hidden="true" /> : null}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Nothing is sent anywhere, and it is free. Words appear as you speak. Less accurate on
            names and identifiers.
          </span>
          {!status.local.ready && status.local.reason ? (
            <span className="mt-1 block text-xs text-amber-500">{status.local.reason}</span>
          ) : null}
        </button>

        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run('provider', () => voiceApi.setTranscription({ provider: 'openai' }))}
          className={cn(
            'rounded-lg border p-3 text-left transition-colors duration-quick',
            cloud ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent',
          )}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <Cloud className="size-4" aria-hidden="true" />
            OpenAI, with your key
            {cloud ? <Check className="size-3.5 text-primary" aria-hidden="true" /> : null}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Much more accurate.{' '}
            <strong className="font-medium text-foreground">
              Each thing you say is uploaded to OpenAI
            </strong>{' '}
            and billed to your key. No live text while you talk — that would be a second charge for
            the same sentence.
          </span>
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run('provider', () => voiceApi.setTranscription({ provider: 'assemblyai' }))}
          className={cn(
            'rounded-lg border p-3 text-left transition-colors duration-quick',
            streaming ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent',
          )}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <Radio className="size-4" aria-hidden="true" />
            AssemblyAI, streaming
            {streaming ? <Check className="size-3.5 text-primary" aria-hidden="true" /> : null}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {/*
              The one that is both, and the copy has to say why rather than
              leaving it to read as "the best one". A stream sends the audio once
              and the partial text comes back as part of it, which is what makes
              live words affordable here and not above.
            */}
            Accurate <em>and</em> live, because the audio goes over once as you speak instead of
            being re-sent for every update.{' '}
            <strong className="font-medium text-foreground">
              Your microphone is streamed to AssemblyAI
            </strong>{' '}
            and billed to your key.
          </span>
        </button>
      </div>

      {streaming ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <label className="block text-xs font-medium" htmlFor="assembly-key">
            AssemblyAI API key
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="assembly-key"
              type="password"
              value={streamingKey}
              onChange={(event) => setStreamingKey(event.target.value)}
              placeholder={status.streamingConfigured
                ? `Saved ${status.streamingKeyHint ?? ''}`
                : 'Paste your key'}
              data-tails-part="input"
              className="min-w-56 flex-1 p-2 text-sm outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            />
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run('streaming-key', async () => {
                const next = await voiceApi.setStreamingKey(streamingKey);
                setStreamingKey('');
                return next;
              })}
              className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-50"
            >
              {streamingKey.trim() ? 'Save key' : 'Remove key'}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Stored on this machine only, in your TAILS folder. If the stream cannot be reached,
            dictation quietly falls back to transcribing the sentence after you stop — you get the
            words either way, without the live text.
          </p>
        </div>
      ) : null}

      {cloud ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <label className="block text-xs font-medium" htmlFor="openai-key">
            OpenAI API key
          </label>
          <div className="flex gap-2">
            <input
              id="openai-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(event) => { setKey(event.target.value); setSaved(false); }}
              placeholder={status.keySaved ? `Saved (${status.keyHint})` : 'sk-...'}
              className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-primary"
            />
            <button
              type="button"
              disabled={busy !== null || key.trim().length === 0}
              onClick={() => {
                void run('key', () => voiceApi.saveKey(key)).then((ok) => {
                  if (!ok) return;
                  // Cleared on success, so the value is not left sitting in a
                  // field for the rest of the session.
                  setKey('');
                  setSaved(true);
                });
              }}
              className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs transition-colors duration-quick hover:bg-accent disabled:opacity-40"
            >
              {busy === 'key' ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : 'Save'}
            </button>
            {status.keySaved ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void run('key', () => voiceApi.saveKey(''))}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-quick hover:bg-accent"
              >
                Remove
              </button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Stored on this machine only, in your TAILS folder, and sent to api.openai.com and
            nowhere else. It is never written to a log, and no part of the app can read it back.
          </p>
          {saved ? <p className="text-xs text-primary">Saved.</p> : null}

          <div className="pt-1">
            <label className="block text-xs font-medium" htmlFor="cloud-model">Model</label>
            <select
              id="cloud-model"
              value={status.cloudModel}
              disabled={busy !== null}
              onChange={(event) => {
                void run('model', () => voiceApi.setTranscription({ cloudModel: event.target.value }));
              }}
              className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-primary"
            >
              {status.models.map((model) => (
                <option key={model.id} value={model.id}>{model.label} — {model.note}</option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {/*
        The obstacle for whichever engine is actually selected — never the other
        one's. That is how "download a 78 MB model" ends up on screen while the
        real problem is a missing key.
      */}
      {!status.ready && status.reason ? (
        <p className="text-xs text-amber-500">{status.reason}</p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
